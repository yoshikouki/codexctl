import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { AppServerClient, type AppServerEvent, jobDir } from "./app-server.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type JobRecord = {
  key: string;
  repo: string;
  prompt: string;
  model: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  workerPid: number | null;
  threadId: string | null;
  turnId: string | null;
  finalResponse: string;
  error: string | null;
};

export type ControlCommand = {
  id: string;
  type: "turn.steer";
  at: string;
  input: Array<{ type: "text"; text: string }>;
};

export type StartJobOptions = {
  key: string;
  repo: string;
  prompt: string;
  model?: string;
  force?: boolean;
  detach?: boolean;
};

export async function startJob(options: StartJobOptions): Promise<JobRecord> {
  const record = await createJob(options);
  if (options.detach) {
    const dir = jobDir(process.cwd(), record.key);
    const proc = Bun.spawn({
      cmd: [process.execPath, import.meta.resolveSync("./cli.ts"), "internal", "worker", record.key],
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: Bun.file(`${dir}/worker.log`),
      stderr: Bun.file(`${dir}/worker.err.log`),
      detached: true,
    });
    proc.unref();
    record.status = "running";
    record.workerPid = proc.pid;
    record.updatedAt = new Date().toISOString();
    await writeJobRecord(dir, record);
    return record;
  }
  return await runJobWorker(record.key);
}

export async function createJob(options: StartJobOptions): Promise<JobRecord> {
  const repo = normalizeRepo(options.repo);
  const root = process.cwd();
  const dir = jobDir(root, options.key);
  const existingJob = Bun.file(`${dir}/job.json`);
  if ((await existingJob.exists()) && !options.force) {
    throw new Error(`Job '${options.key}' already exists; use --force to replace its local record`);
  }
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/events.jsonl`, "");
  await Bun.write(`${dir}/control.jsonl`, "");
  await Bun.write(`${dir}/worker.log`, "");
  await Bun.write(`${dir}/worker.err.log`, "");

  const record: JobRecord = {
    key: options.key,
    repo,
    prompt: options.prompt,
    model: options.model ?? null,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    workerPid: null,
    threadId: null,
    turnId: null,
    finalResponse: "",
    error: null,
  };
  await writeJobRecord(dir, record);
  return record;
}

export async function runJobWorker(key: string): Promise<JobRecord> {
  const dir = jobDir(process.cwd(), key);
  const record = await readJob(key);
  record.status = "running";
  record.startedAt ??= new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  record.workerPid ??= process.pid;
  await writeJobRecord(dir, record);
  await appendEvent(dir, {
    direction: "worker",
    event: { type: "worker.started", pid: process.pid },
    at: new Date().toISOString(),
  });

  const processedControlIds = new Set<string>();
  const client = new AppServerClient(async (event) => {
    await appendEvent(dir, event);
    updateRecordFromEvent(record, event);
    await writeJobRecord(dir, record);
  });

  try {
    await client.initialize();
    const threadResult = await client.request("thread/start", {
      cwd: record.repo,
      runtimeWorkspaceRoots: [record.repo],
      model: record.model,
      approvalsReviewer: "user",
      approvalPolicy: "on-request",
      threadSource: "other",
    }) as { thread?: { id?: string } };
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error("thread/start response did not include thread.id");
    record.threadId = threadId;

    const turnResult = await client.request("turn/start", {
      threadId,
      cwd: record.repo,
      runtimeWorkspaceRoots: [record.repo],
      input: [{ type: "text", text: record.prompt }],
      responsesapiClientMetadata: {
        codexctl_job_key: record.key,
      },
    }) as { turn?: { id?: string } };
    const turnId = turnResult.turn?.id;
    if (!turnId) throw new Error("turn/start response did not include turn.id");
    record.turnId = turnId;
    await writeJobRecord(dir, record);

    await Promise.race([
      waitForTurnCompletion(record, client, dir, processedControlIds),
      client.closed().then(() => {
        if (record.status === "running") {
          throw new Error("codex app-server closed before the turn completed");
        }
      }),
    ]);
    return record;
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.completedAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    await writeJobRecord(dir, record);
    throw error;
  } finally {
    await client.close();
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "worker.exited", pid: process.pid, status: record.status },
      at: new Date().toISOString(),
    });
  }
}

export async function readJob(key: string): Promise<JobRecord> {
  const path = `${jobDir(process.cwd(), key)}/job.json`;
  return await Bun.file(path).json() as JobRecord;
}

export async function readJobEvents(key: string): Promise<unknown[]> {
  const path = `${jobDir(process.cwd(), key)}/events.jsonl`;
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export async function enqueueSteer(key: string, prompt: string): Promise<ControlCommand> {
  const dir = jobDir(process.cwd(), key);
  const job = await readJob(key);
  if (job.status !== "running") {
    throw new Error(`Job '${key}' is ${job.status}; only running jobs can be steered`);
  }
  const command: ControlCommand = {
    id: crypto.randomUUID(),
    type: "turn.steer",
    at: new Date().toISOString(),
    input: [{ type: "text", text: prompt }],
  };
  await appendFile(`${dir}/control.jsonl`, JSON.stringify(command) + "\n");
  await appendEvent(dir, {
    direction: "control",
    command,
    at: new Date().toISOString(),
  });
  return command;
}

export async function readNewEventLines(key: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  const path = `${jobDir(process.cwd(), key)}/events.jsonl`;
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], offset };
  const text = await file.text();
  if (offset > text.length) offset = 0;
  const chunk = text.slice(offset);
  const lines = chunk.split("\n").filter((line) => line.trim().length > 0);
  return { lines, offset: text.length };
}

async function waitForTurnCompletion(
  record: JobRecord,
  client: AppServerClient,
  dir: string,
  processedControlIds: Set<string>,
): Promise<void> {
  while (record.status === "running") {
    await processControlCommands(record, client, dir, processedControlIds);
    await Bun.sleep(250);
  }
  if (record.status === "failed") {
    throw new Error(record.error ?? "Codex turn failed");
  }
}

function updateRecordFromEvent(record: JobRecord, event: AppServerEvent): void {
  if (event.direction !== "server" || !("method" in event.message)) return;
  const { method, params } = event.message;
  if (method === "thread/started") {
    const threadId = getNestedString(params, ["thread", "id"]);
    if (threadId) record.threadId = threadId;
  }
  if (method === "turn/started") {
    const turnId = getNestedString(params, ["turn", "id"]);
    if (turnId) record.turnId = turnId;
  }
  if (method === "item/started") {
    const itemType = getNestedString(params, ["item", "type"]);
    const phase = getNestedString(params, ["item", "phase"]);
    if (itemType === "agentMessage" && phase === "final_answer") {
      record.finalResponse = "";
    }
  }
  if (method === "item/agentMessage/delta") {
    const delta = getNestedString(params, ["delta"]);
    if (delta) record.finalResponse += delta;
  }
  if (method === "item/completed") {
    const itemType = getNestedString(params, ["item", "type"]);
    const phase = getNestedString(params, ["item", "phase"]);
    const text = getNestedString(params, ["item", "text"]);
    if (itemType === "agentMessage" && phase === "final_answer" && text !== null) {
      record.finalResponse = text;
    }
  }
  if (method === "turn/completed") {
    const status = getNestedString(params, ["turn", "status"]);
    record.status = status === "failed" ? "failed" : "completed";
    record.error = getNestedString(params, ["turn", "error", "message"]);
    record.completedAt = new Date().toISOString();
  }
  if (method === "error") {
    record.status = "failed";
    record.error = JSON.stringify(params);
  }
  record.updatedAt = new Date().toISOString();
}

async function processControlCommands(
  record: JobRecord,
  client: AppServerClient,
  dir: string,
  processedControlIds: Set<string>,
): Promise<void> {
  const file = Bun.file(`${dir}/control.jsonl`);
  if (!(await file.exists())) return;
  const text = await file.text();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const command = JSON.parse(line) as ControlCommand;
    if (processedControlIds.has(command.id)) continue;
    processedControlIds.add(command.id);
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "control.accepted", commandId: command.id, commandType: command.type },
      at: new Date().toISOString(),
    });
    if (command.type === "turn.steer") {
      if (!record.threadId || !record.turnId) {
        await appendEvent(dir, {
          direction: "worker",
          event: { type: "control.rejected", commandId: command.id, reason: "turn_not_started" },
          at: new Date().toISOString(),
        });
        continue;
      }
      await client.request("turn/steer", {
        threadId: record.threadId,
        expectedTurnId: record.turnId,
        input: command.input,
      });
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "control.applied", commandId: command.id, method: "turn/steer" },
        at: new Date().toISOString(),
      });
    }
  }
}

function getNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function appendEvent(dir: string, event: AppServerEvent): Promise<void> {
  await appendFile(`${dir}/events.jsonl`, JSON.stringify(event) + "\n");
}

async function writeJobRecord(dir: string, record: JobRecord): Promise<void> {
  await mkdir(dirname(`${dir}/job.json`), { recursive: true });
  await Bun.write(`${dir}/job.json`, JSON.stringify(record, null, 2) + "\n");
}

function normalizeRepo(repo: string): string {
  return isAbsolute(repo) ? repo : resolve(process.cwd(), repo);
}
