import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { AppServerClient, type AppServerEvent, jobDir } from "./app-server.ts";

export type JobStatus = "running" | "completed" | "failed";

export type JobRecord = {
  key: string;
  repo: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  threadId: string | null;
  turnId: string | null;
  finalResponse: string;
  error: string | null;
};

export type StartJobOptions = {
  key: string;
  repo: string;
  prompt: string;
  model?: string;
  force?: boolean;
};

export async function startJob(options: StartJobOptions): Promise<JobRecord> {
  const repo = normalizeRepo(options.repo);
  const root = process.cwd();
  const dir = jobDir(root, options.key);
  const existingJob = Bun.file(`${dir}/job.json`);
  if ((await existingJob.exists()) && !options.force) {
    throw new Error(`Job '${options.key}' already exists; use --force to replace its local record`);
  }
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/events.jsonl`, "");

  const record: JobRecord = {
    key: options.key,
    repo,
    prompt: options.prompt,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    threadId: null,
    turnId: null,
    finalResponse: "",
    error: null,
  };
  await writeJobRecord(dir, record);

  const client = new AppServerClient(async (event) => {
    await appendEvent(dir, event);
    updateRecordFromEvent(record, event);
    await writeJobRecord(dir, record);
  });

  try {
    await client.initialize();
    const threadResult = await client.request("thread/start", {
      cwd: repo,
      runtimeWorkspaceRoots: [repo],
      model: options.model ?? null,
      approvalsReviewer: "user",
      approvalPolicy: "on-request",
      threadSource: "other",
    }) as { thread?: { id?: string } };
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error("thread/start response did not include thread.id");
    record.threadId = threadId;

    const turnResult = await client.request("turn/start", {
      threadId,
      cwd: repo,
      runtimeWorkspaceRoots: [repo],
      input: [{ type: "text", text: options.prompt }],
    }) as { turn?: { id?: string } };
    const turnId = turnResult.turn?.id;
    if (!turnId) throw new Error("turn/start response did not include turn.id");
    record.turnId = turnId;
    await writeJobRecord(dir, record);

    await Promise.race([
      waitForTurnCompletion(record),
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
    record.updatedAt = new Date().toISOString();
    await writeJobRecord(dir, record);
    throw error;
  } finally {
    await client.close();
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

async function waitForTurnCompletion(record: JobRecord): Promise<void> {
  while (record.status === "running") {
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
  if (method === "item/agentMessage/delta") {
    const delta = getNestedString(params, ["delta"]);
    if (delta) record.finalResponse += delta;
  }
  if (method === "turn/completed") {
    const status = getNestedString(params, ["turn", "status"]);
    record.status = status === "failed" ? "failed" : "completed";
    record.error = getNestedString(params, ["turn", "error", "message"]);
  }
  if (method === "error") {
    record.status = "failed";
    record.error = JSON.stringify(params);
  }
  record.updatedAt = new Date().toISOString();
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
  await Bun.write(`${dir}/job.json`, JSON.stringify(record, null, 2) + "\n");
}

function normalizeRepo(repo: string): string {
  return isAbsolute(repo) ? repo : resolve(process.cwd(), repo);
}
