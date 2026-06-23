import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { AppServerClient, type AppServerEvent, jobDir } from "./app-server.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export type JobRecord = {
  key: string;
  repo: string;
  prompt: string;
  model: string | null;
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access" | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  workerPid: number | null;
  threadId: string | null;
  turnId: string | null;
  approvals: ApprovalRecord[];
  finalResponse: string;
  error: string | null;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "unsupported";

export type ApprovalRecord = {
  id: string;
  serverRequestId: string | number;
  method: string;
  params: unknown;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  decision: string | null;
  error: string | null;
};

export type TurnSteerCommand = {
  id: string;
  type: "turn.steer";
  at: string;
  input: Array<{ type: "text"; text: string }>;
};

export type ApprovalResolveCommand = {
  id: string;
  type: "approval.resolve";
  at: string;
  approvalId: string;
  decision: "approve" | "approveForSession" | "reject" | "cancel";
};

export type ControlCommand = TurnSteerCommand | ApprovalResolveCommand;

export type StartJobOptions = {
  key: string;
  repo: string;
  prompt: string;
  model?: string;
  approvalPolicy?: JobRecord["approvalPolicy"];
  sandbox?: NonNullable<JobRecord["sandbox"]>;
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
    approvalPolicy: options.approvalPolicy ?? "on-request",
    sandbox: options.sandbox ?? null,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    workerPid: null,
    threadId: null,
    turnId: null,
    approvals: [],
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
      approvalPolicy: record.approvalPolicy,
      sandbox: record.sandbox,
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

export async function readApprovals(key: string, includeResolved = false): Promise<ApprovalRecord[]> {
  const job = await readJob(key);
  return includeResolved ? job.approvals : job.approvals.filter((approval) => approval.status === "pending");
}

export async function readApproval(key: string, approvalId: string): Promise<ApprovalRecord> {
  const approval = (await readApprovals(key, true)).find((candidate) => candidate.id === approvalId);
  if (!approval) throw new Error(`Approval '${approvalId}' was not found for job '${key}'`);
  return approval;
}

export async function enqueueApprovalDecision(
  key: string,
  approvalId: string,
  decision: ApprovalResolveCommand["decision"],
): Promise<ApprovalResolveCommand> {
  const dir = jobDir(process.cwd(), key);
  const job = await readJob(key);
  if (job.status !== "running") {
    throw new Error(`Job '${key}' is ${job.status}; only running jobs can receive approval decisions`);
  }
  const approval = job.approvals.find((candidate) => candidate.id === approvalId);
  if (!approval) throw new Error(`Approval '${approvalId}' was not found for job '${key}'`);
  if (approval.status !== "pending") {
    throw new Error(`Approval '${approvalId}' is already ${approval.status}`);
  }
  const command: ApprovalResolveCommand = {
    id: crypto.randomUUID(),
    type: "approval.resolve",
    at: new Date().toISOString(),
    approvalId,
    decision,
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
  if ("id" in event.message && isApprovalRequest(method)) {
    upsertApproval(record, {
      id: String(event.message.id),
      serverRequestId: event.message.id,
      method,
      params,
      status: "pending",
      createdAt: event.at,
      resolvedAt: null,
      decision: null,
      error: null,
    });
  }
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
    if (command.type === "approval.resolve") {
      await resolveApprovalCommand(record, client, dir, command);
    }
  }
}

async function resolveApprovalCommand(
  record: JobRecord,
  client: AppServerClient,
  dir: string,
  command: ApprovalResolveCommand,
): Promise<void> {
  const approval = record.approvals.find((candidate) => candidate.id === command.approvalId);
  if (!approval || approval.status !== "pending") {
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "approval.rejected", commandId: command.id, approvalId: command.approvalId, reason: "not_pending" },
      at: new Date().toISOString(),
    });
    return;
  }

  const result = approvalResponseFor(approval, command.decision);
  if (!result.supported) {
    approval.status = "unsupported";
    approval.error = result.error;
    approval.resolvedAt = new Date().toISOString();
    approval.decision = command.decision;
    record.updatedAt = new Date().toISOString();
    await writeJobRecord(dir, record);
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "approval.unsupported", commandId: command.id, approvalId: approval.id, method: approval.method, error: result.error },
      at: new Date().toISOString(),
    });
    return;
  }

  await client.respond(approval.serverRequestId, result.response);
  approval.status = command.decision === "cancel" ? "cancelled" : command.decision.startsWith("approve") ? "approved" : "rejected";
  approval.decision = command.decision;
  approval.resolvedAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  await writeJobRecord(dir, record);
  await appendEvent(dir, {
    direction: "worker",
    event: { type: "approval.resolved", commandId: command.id, approvalId: approval.id, decision: command.decision },
    at: new Date().toISOString(),
  });
}

function approvalResponseFor(
  approval: ApprovalRecord,
  decision: ApprovalResolveCommand["decision"],
): { supported: true; response: unknown } | { supported: false; error: string } {
  if (approval.method === "item/commandExecution/requestApproval") {
    return { supported: true, response: { decision: modernApprovalDecision(approval, decision) } };
  }
  if (approval.method === "item/fileChange/requestApproval") {
    return { supported: true, response: { decision: modernApprovalDecision(approval, decision) } };
  }
  if (approval.method === "execCommandApproval" || approval.method === "applyPatchApproval") {
    return { supported: true, response: { decision: legacyApprovalDecision(decision) } };
  }
  return { supported: false, error: `Approval method '${approval.method}' is not supported yet` };
}

function modernApprovalDecision(approval: ApprovalRecord, decision: ApprovalResolveCommand["decision"]): unknown {
  if (decision === "approve") return "accept";
  if (decision === "approveForSession") return sessionApprovalDecision(approval.params) ?? "acceptForSession";
  if (decision === "cancel") return "cancel";
  return "decline";
}

function sessionApprovalDecision(params: unknown): unknown | null {
  if (!isObject(params)) return null;
  const { availableDecisions, proposedExecpolicyAmendment } = params;
  if (Array.isArray(availableDecisions)) {
    const sessionDecision = availableDecisions.find((candidate) => isObject(candidate) && "acceptWithExecpolicyAmendment" in candidate);
    if (sessionDecision) return sessionDecision;
  }
  if (Array.isArray(proposedExecpolicyAmendment)) {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: proposedExecpolicyAmendment,
      },
    };
  }
  return null;
}

function legacyApprovalDecision(decision: ApprovalResolveCommand["decision"]): string {
  if (decision === "approve") return "approved";
  if (decision === "approveForSession") return "approved_for_session";
  if (decision === "cancel") return "abort";
  return "denied";
}

function isApprovalRequest(method: string): boolean {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "execCommandApproval"
    || method === "applyPatchApproval";
}

function upsertApproval(record: JobRecord, approval: ApprovalRecord): void {
  const index = record.approvals.findIndex((candidate) => candidate.id === approval.id);
  if (index >= 0) {
    record.approvals[index] = { ...record.approvals[index], ...approval };
  } else {
    record.approvals.push(approval);
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
