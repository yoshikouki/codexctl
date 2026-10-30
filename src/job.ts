import { appendFile, mkdir, readdir, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppServerClient, type AppServerEvent } from "./app-server.ts";
import { appendEvent, isApprovalRequest, readNewCompleteLines, readRawEvents } from "./events.ts";
import { sendJobNotification } from "./notify.ts";
import { jobDir, jobsRoot, codexctlHome } from "./state.ts";

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

class JobOperationError extends Error {
  constructor(
    readonly code: "job_not_terminal" | "job_worker_alive" | "job_unreadable",
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

export type JobRecord = {
  key: string;
  jobIncarnation: string | null;
  repo: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
  workerPid: number | null;
  threadId: string | null;
  turnId: string | null;
  cancelRequestedAt: string | null;
  cancelCommandId: string | null;
  approvals: ApprovalRecord[];
  finalResponse: string;
  latestAgentMessage: string;
  controlOffset: number;
  resumeCommandId: string | null;
  error: string | null;
};

type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "unsupported";

type ApprovalRecord = {
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

type TurnSteerCommand = {
  id: string;
  type: "turn.steer";
  resume?: true;
  at: string;
  input: Array<{ type: "text"; text: string }>;
};

type ApprovalResolveCommand = {
  id: string;
  type: "approval.resolve";
  at: string;
  approvalId: string;
  decision: "approve" | "approveForSession" | "reject" | "cancel";
};

type TurnInterruptCommand = {
  id: string;
  type: "turn.interrupt";
  at: string;
};

type ControlCommand = TurnSteerCommand | ApprovalResolveCommand | TurnInterruptCommand;

type CreateJobOptions = {
  key: string;
  repo: string;
  prompt: string;
  force?: boolean;
};

type JobCancelResult = {
  action: "interrupt_queued" | "none";
  reason: string;
  job: JobRecord;
  command: TurnInterruptCommand | null;
};

type JobRemoveOptions = {
  dryRun?: boolean;
  force?: boolean;
};

type JobRemoveResult = {
  action: "removed" | "would_remove";
  key: string;
  status: JobStatus | "unreadable";
  reason: string;
};

type JobListItem = Pick<JobRecord,
  "key" | "jobIncarnation" | "workerId" | "workerPid" | "threadId" | "turnId" | "cancelRequestedAt" | "error"
> & {
  status: JobStatus | "unreadable";
  updatedAt: string | null;
  workerAlive: boolean | null;
  pendingApprovals: number;
  actionableApprovals: number;
};

type JobSummary = Pick<JobRecord,
  "key" | "status" | "repo" | "threadId" | "turnId" | "createdAt" | "startedAt" | "completedAt" | "finalResponse" | "error"
> & {
  pendingApprovals: { count: number; ids: string[] };
  latestAgentMessage: string;
  lastNotification: { status: "sent" | "failed" | "skipped"; at: string } | null;
  recentEvents: unknown[];
};

type JobWaitOptions = {
  eventLimit?: number;
  ignoredApprovalIds?: string[];
  intervalMs?: number;
  timeoutMs?: number | null;
};

type JobWaitResult = {
  key: string;
  ready: boolean;
  reason: "terminal" | "approval_required" | "timeout";
  elapsedMs: number;
  intervalMs: number;
  ignoredApprovalIds: string[];
  timeoutMs: number | null;
  deadlineAt: string | null;
  status: JobStatus;
  summary: JobSummary;
};

type ApprovalDecisionAndWaitResult = {
  command: ApprovalResolveCommand;
  wait: JobWaitResult;
};

export async function runJob(options: CreateJobOptions): Promise<JobRecord> {
  const record = await createJob(options);
  spawnDetachedWorker(record.key);
  return record;
}

export async function listJobs(): Promise<JobListItem[]> {
  const root = jobsRoot();
  const entries = await readJobRootEntries(root);
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<JobListItem> => {
      try {
        const job = await Bun.file(join(root, entry.name, "job.json")).json() as JobRecord;
        return summarizeJob(job);
      } catch (error) {
        return {
          key: entry.name,
          jobIncarnation: null,
          status: "unreadable",
          updatedAt: null,
          workerId: null,
          workerPid: null,
          workerAlive: null,
          threadId: null,
          turnId: null,
          pendingApprovals: 0,
          actionableApprovals: 0,
          cancelRequestedAt: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  return jobs.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

export async function removeJob(key: string, options: JobRemoveOptions = {}): Promise<JobRemoveResult> {
  const dir = jobDir(key);
  let status: JobStatus | "unreadable";
  let job: JobRecord | null = null;
  try {
    job = await readJob(key);
  } catch (error) {
    if (!options.force) {
      throw new JobOperationError("job_unreadable", `Job '${key}' could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (job) {
    status = job.status;
    if (job.workerPid !== null && isProcessAlive(job.workerPid)) {
      throw new JobOperationError("job_worker_alive", `Job '${key}' still has live worker ${job.workerPid}; cancel or wait before removing it`);
    }
    if (!isTerminalStatus(job.status)) {
      if (!options.force) {
        throw new JobOperationError("job_not_terminal", `Job '${key}' is ${job.status}; only terminal jobs can be removed without --force`);
      }
    }
  } else {
    status = "unreadable";
  }

  const action = options.dryRun ? "would_remove" : "removed";
  if (!options.dryRun) {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    action,
    key,
    status,
    reason: options.dryRun ? "dry run" : "job record removed",
  };
}

export async function cancelJob(key: string): Promise<JobCancelResult> {
  const dir = jobDir(key);
  const job = await readJob(key);
  if (isTerminalStatus(job.status)) {
    return { action: "none", reason: `job is already ${job.status}`, job, command: null };
  }
  const command: TurnInterruptCommand = { id: crypto.randomUUID(), type: "turn.interrupt", at: new Date().toISOString() };
  await appendFile(`${dir}/control.jsonl`, JSON.stringify(command) + "\n");
  return { action: "interrupt_queued", reason: "turn interrupt command queued", job, command };
}

export async function createJob(options: CreateJobOptions): Promise<JobRecord> {
  const repo = resolve(options.repo);
  const dir = jobDir(options.key);
  await mkdir(jobsRoot(), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if (!isErrorWithCode(error) || error.code !== "EEXIST") throw error;
    if (!options.force) throw new Error(`Job '${options.key}' already exists; use --force to replace its local record`);
    const existing = await readJob(options.key);
    if (isProcessAlive(existing.workerPid)) {
      throw new JobOperationError("job_worker_alive", `Job '${options.key}' still has live worker ${existing.workerPid}; cancel or wait before replacing it`);
    }
  }
  await Bun.write(`${dir}/events.jsonl`, "");
  await Bun.write(`${dir}/control.jsonl`, "");
  await Bun.write(`${dir}/worker.log`, "");
  await Bun.write(`${dir}/worker.err.log`, "");

  const record: JobRecord = {
    key: options.key,
    jobIncarnation: crypto.randomUUID(),
    repo,
    prompt: options.prompt,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    workerId: null,
    workerPid: null,
    threadId: null,
    turnId: null,
    cancelRequestedAt: null,
    cancelCommandId: null,
    approvals: [],
    finalResponse: "",
    latestAgentMessage: "",
    controlOffset: 0,
    resumeCommandId: null,
    error: null,
  };
  await writeJobRecord(dir, record);
  return record;
}

function spawnDetachedWorker(key: string, resumeCommandId?: string): void {
  const dir = jobDir(key);
  const proc = Bun.spawn({
    cmd: [process.execPath, import.meta.resolveSync("./cli.ts"), "internal", "worker", key],
    env: { ...process.env, CODEXCTL_HOME: codexctlHome(), CODEXCTL_RESUME_COMMAND_ID: resumeCommandId ?? "" },
    stdin: "ignore",
    stdout: Bun.file(`${dir}/worker.log`),
    stderr: Bun.file(`${dir}/worker.err.log`),
    detached: true,
  });
  proc.unref();
}

export async function runJobWorker(key: string): Promise<JobRecord> {
  const dir = jobDir(key);
  let record = await readJob(key);
  const resumeId = process.env.CODEXCTL_RESUME_COMMAND_ID;
  if (resumeId) {
    // A terminal state is visible before the previous worker finishes its webhook.
    while (isProcessAlive(record.workerPid)) await Bun.sleep(50);
    record = await readJob(key);
    const controls = await readNewCompleteLines(`${dir}/control.jsonl`, record.controlOffset);
    let offset = record.controlOffset;
    for (const line of controls.lines) {
      offset += Buffer.byteLength(line + "\n");
      const command = JSON.parse(line) as ControlCommand;
      if (command.id !== resumeId || command.type !== "turn.steer") continue;
      record.prompt = command.input.map(item => item.text).join("\n");
      record.controlOffset = offset;
      record.resumeCommandId = command.id;
      break;
    }
    if (record.resumeCommandId !== resumeId) throw new Error("Resume command not found");
  }
  record.status = "running";
  record.startedAt = new Date().toISOString();
  record.updatedAt = record.startedAt;
  record.completedAt = null;
  record.turnId = null;
  record.finalResponse = "";
  record.latestAgentMessage = "";
  record.error = null;
  record.approvals = [];
  record.cancelRequestedAt = null;
  record.cancelCommandId = null;
  record.workerId = crypto.randomUUID();
  record.workerPid = process.pid;
  await writeJobRecord(dir, record);
  await appendEvent(dir, {
    direction: "worker",
    event: { type: "worker.started", pid: process.pid, workerId: record.workerId },
    at: new Date().toISOString(),
  });

  const processedControlIds = new Set<string>();
  const notifiedApprovals = new Set<string>();
  let client: AppServerClient | undefined;
  try {
    const queued = await readNewCompleteLines(`${dir}/control.jsonl`, record.controlOffset);
    const interrupt = queued.lines.map(line => JSON.parse(line) as ControlCommand).find(command => command.type === "turn.interrupt");
    if (interrupt) {
      record.controlOffset = queued.offset;
      record.cancelRequestedAt = interrupt.at;
      record.cancelCommandId = interrupt.id;
      record.status = "cancelled";
      record.completedAt = new Date().toISOString();
      await writeJobRecord(dir, record);
      return record;
    }
    client = new AppServerClient(async (event) => {
      await appendEvent(dir, event);
      updateRecordFromEvent(record, event);
      await writeJobRecord(dir, record);
      if (event.direction === "server" && "method" in event.message && "id" in event.message && isApprovalRequest(event.message.method)) {
        const approvalId = String(event.message.id);
        if (!notifiedApprovals.has(approvalId)) {
          notifiedApprovals.add(approvalId);
          await sendJobNotification(dir, record, "approval.requested", approvalId);
        }
      }
    });

    await client.initialize();
    const threadMethod = record.threadId ? "thread/resume" : "thread/start";
    const threadResult = await client.request(threadMethod, {
      ...(record.threadId ? { threadId: record.threadId } : {}),
      cwd: record.repo,
    }) as { thread?: { id?: string } };
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error(`${threadMethod} response did not include thread.id`);
    record.threadId = threadId;

    const turnResult = await client.request("turn/start", {
      threadId,
      cwd: record.repo,
      input: [{ type: "text", text: record.prompt }],
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
    await client?.close();
    if (isTerminalStatus(record.status)) {
      await sendJobNotification(dir, record, `job.${record.status}`);
    }
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "worker.exited", pid: process.pid, status: record.status },
      at: new Date().toISOString(),
    });
  }
}

export async function notifyJob(key: string) {
  const result = await sendJobNotification(jobDir(key), await readJob(key), "job.status");
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result;
}

export async function readJob(key: string): Promise<JobRecord> {
  return await Bun.file(`${jobDir(key)}/job.json`).json() as JobRecord;
}

export async function readJobEvents(key: string): Promise<unknown[]> {
  return readRawEvents(`${jobDir(key)}/events.jsonl`);
}

export async function readJobSummary(key: string, eventLimit = 5): Promise<JobSummary> {
  return summarizeRecord(await readJob(key), eventLimit);
}

async function summarizeRecord(job: JobRecord, eventLimit: number): Promise<JobSummary> {
  const events = await readJobEvents(job.key);
  let lastNotification: JobSummary["lastNotification"] = null;
  for (const raw of events) {
    const entry = raw as AppServerEvent;
    if (entry.direction !== "worker") continue;
    const type = entry.event.type;
    if (type === "notify.sent" || type === "notify.failed" || type === "notify.skipped") {
      const status = type === "notify.sent" ? "sent" : type === "notify.failed" ? "failed" : "skipped";
      lastNotification = { status, at: entry.at };
    }
  }
  const ids = job.approvals.filter(approval => approval.status === "pending").map(approval => approval.id);
  return {
    key: job.key, status: job.status, repo: job.repo,
    threadId: job.threadId, turnId: job.turnId,
    createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
    pendingApprovals: { count: ids.length, ids },
    latestAgentMessage: Array.from(job.latestAgentMessage).slice(0, 2000).join(""),
    finalResponse: job.finalResponse, error: job.error,
    lastNotification,
    recentEvents: eventLimit <= 0 ? [] : events.slice(-eventLimit),
  };
}

export async function waitForJob(key: string, options: JobWaitOptions = {}): Promise<JobWaitResult> {
  const eventLimit = options.eventLimit ?? 5;
  const ignoredApprovalIds = options.ignoredApprovalIds ?? [];
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? null;
  const startedAt = Date.now();
  const deadline = timeoutMs === null ? null : startedAt + timeoutMs;

  while (true) {
    const job = await readJob(key);
    const summary = await summarizeRecord(job, eventLimit);
    const pending = isTerminalStatus(job.status)
      ? await readNewCompleteLines(`${jobDir(key)}/control.jsonl`, job.controlOffset)
      : { lines: [] };
    const resumePending = pending.lines.some(line => {
      const command = JSON.parse(line) as ControlCommand;
      return command.type === "turn.steer" && command.resume;
    });
    const readyReason = resumePending ? null : readyReasonFor(summary, ignoredApprovalIds);
    const now = Date.now();
    if (readyReason || (deadline !== null && now >= deadline)) {
      return {
        key,
        ready: readyReason !== null,
        reason: readyReason ?? "timeout",
        elapsedMs: Math.max(0, now - startedAt),
        intervalMs,
        ignoredApprovalIds,
        timeoutMs,
        deadlineAt: deadline === null ? null : new Date(deadline).toISOString(),
        status: summary.status,
        summary,
      };
    }
    const sleepMs = deadline === null ? intervalMs : Math.max(0, Math.min(intervalMs, deadline - now));
    await Bun.sleep(sleepMs);
  }
}

export async function enqueueApprovalDecisionAndWait(
  key: string,
  approvalId: string,
  decision: ApprovalResolveCommand["decision"],
  options: JobWaitOptions = {},
): Promise<ApprovalDecisionAndWaitResult> {
  const command = await enqueueApprovalDecision(key, approvalId, decision);
  return {
    command,
    wait: await waitForJob(key, {
      ...options,
      ignoredApprovalIds: [...(options.ignoredApprovalIds ?? []), approvalId],
    }),
  };
}

export async function enqueueSteer(key: string, prompt: string): Promise<TurnSteerCommand> {
  const dir = jobDir(key);
  const job = await readJob(key);
  if (isTerminalStatus(job.status) && !job.threadId) throw new Error(`Job '${key}' has no threadId to resume`);
  const pending = await readNewCompleteLines(`${dir}/control.jsonl`, job.controlOffset);
  const resumeQueued = pending.lines.some(line => {
    const command = JSON.parse(line) as ControlCommand;
    return command.type === "turn.steer" && command.resume;
  });
  const command: TurnSteerCommand = {
    id: crypto.randomUUID(),
    type: "turn.steer",
    ...(isTerminalStatus(job.status) ? { resume: true as const } : {}),
    at: new Date().toISOString(),
    input: [{ type: "text", text: prompt }],
  };
  await appendFile(`${dir}/control.jsonl`, JSON.stringify(command) + "\n");
  if (isTerminalStatus(job.status) && !resumeQueued) spawnDetachedWorker(key, command.id);
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
  const dir = jobDir(key);
  const job = await readJob(key);
  if (job.status !== "running") {
    throw new Error(`Job '${key}' is ${job.status}; only running jobs can receive approval decisions`);
  }
  const approval = job.approvals.find((candidate) => candidate.id === approvalId);
  if (!approval) throw new Error(`Approval '${approvalId}' was not found for job '${key}'`);
  if (approval.status !== "pending") {
    throw new Error(`Approval '${approvalId}' is already ${approval.status}`);
  }
  if (approval.method === "item/permissions/requestApproval" && (decision === "reject" || decision === "cancel")) {
    throw new Error("Permission approval requests do not support reject/cancel responses in the current app-server schema");
  }
  const command: ApprovalResolveCommand = {
    id: crypto.randomUUID(),
    type: "approval.resolve",
    at: new Date().toISOString(),
    approvalId,
    decision,
  };
  await appendFile(`${dir}/control.jsonl`, JSON.stringify(command) + "\n");
  return command;
}

async function waitForTurnCompletion(
  record: JobRecord,
  client: AppServerClient,
  dir: string,
  processedControlIds: Set<string>,
): Promise<void> {
  let controlOffset = record.controlOffset;
  while (record.status === "running") {
    controlOffset = await processControlCommands(record, client, dir, processedControlIds, controlOffset);
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
    if (itemType === "agentMessage") record.latestAgentMessage = "";
    if (itemType === "agentMessage" && phase === "final_answer") {
      record.finalResponse = "";
    }
  }
  if (method === "item/agentMessage/delta") {
    const delta = getNestedString(params, ["delta"]);
    if (delta) record.latestAgentMessage += delta;
  }
  if (method === "item/completed") {
    const itemType = getNestedString(params, ["item", "type"]);
    const phase = getNestedString(params, ["item", "phase"]);
    const text = getNestedString(params, ["item", "text"]);
    if (itemType === "agentMessage" && text !== null) record.latestAgentMessage = text;
    if (itemType === "agentMessage" && phase === "final_answer" && text !== null) {
      record.finalResponse = text;
    }
  }
  if (method === "turn/completed") {
    const status = getNestedString(params, ["turn", "status"]);
    record.status = status === "failed" ? "failed" : status === "interrupted" ? "cancelled" : "completed";
    record.error = record.status === "cancelled" ? null : getNestedString(params, ["turn", "error", "message"]);
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
  offset: number,
): Promise<number> {
  const result = await readNewCompleteLines(`${dir}/control.jsonl`, offset);
  if (result.lines.length === 0) return result.offset;
  for (const line of result.lines) {
    const command = JSON.parse(line) as ControlCommand;
    record.controlOffset += Buffer.byteLength(line + "\n");
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
    if (command.type === "turn.interrupt") {
      record.cancelRequestedAt ??= command.at;
      record.cancelCommandId ??= command.id;
      record.updatedAt = new Date().toISOString();
      await writeJobRecord(dir, record);
      if (!record.threadId || !record.turnId) {
        await appendEvent(dir, {
          direction: "worker",
          event: { type: "control.rejected", commandId: command.id, reason: "turn_not_started" },
          at: new Date().toISOString(),
        });
        continue;
      }
      await client.request("turn/interrupt", {
        threadId: record.threadId,
        turnId: record.turnId,
      });
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "control.applied", commandId: command.id, method: "turn/interrupt" },
        at: new Date().toISOString(),
      });
    }
    if (command.type === "approval.resolve") {
      await resolveApprovalCommand(record, client, dir, command);
    }
  }
  await writeJobRecord(dir, record);
  return result.offset;
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

export function approvalResponseFor(
  approval: ApprovalRecord,
  decision: ApprovalResolveCommand["decision"],
): { supported: true; response: unknown } | { supported: false; error: string } {
  if (approval.method === "item/commandExecution/requestApproval" || approval.method === "item/fileChange/requestApproval") {
    return { supported: true, response: { decision: modernApprovalDecision(approval, decision) } };
  }
  if (approval.method === "execCommandApproval" || approval.method === "applyPatchApproval") {
    return { supported: true, response: { decision: legacyApprovalDecision(decision) } };
  }
  if (approval.method === "item/permissions/requestApproval") {
    if (decision === "reject" || decision === "cancel") {
      return { supported: false, error: "Permission approval requests only support approve or approveForSession responses" };
    }
    if (!isObject(approval.params) || !isObject(approval.params.permissions)) {
      return { supported: false, error: "Permission approval request params did not include a permissions object" };
    }
    return {
      supported: true,
      response: {
        permissions: approval.params.permissions,
        scope: decision === "approveForSession" ? "session" : "turn",
      },
    };
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
  const { availableDecisions } = params;
  if (Array.isArray(availableDecisions)) {
    const sessionDecision = availableDecisions.find((candidate) => isObject(candidate) && "acceptWithExecpolicyAmendment" in candidate);
    if (sessionDecision) return sessionDecision;
  }
  return null;
}

function legacyApprovalDecision(decision: ApprovalResolveCommand["decision"]): unknown {
  if (decision === "approve") return "approved";
  if (decision === "approveForSession") return "approved_for_session";
  if (decision === "cancel") return "abort";
  return { denied: { rejection: "Rejected via codexctl" } };
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

// Atomic replacement keeps CLI readers from observing a partially written JSON file.
let recordWrite = Promise.resolve();
function writeJobRecord(dir: string, record: JobRecord): Promise<void> {
  const json = JSON.stringify(record, null, 2) + "\n";
  recordWrite = recordWrite.then(async () => {
    await Bun.write(`${dir}/job.json.tmp`, json);
    await rename(`${dir}/job.json.tmp`, `${dir}/job.json`);
  });
  return recordWrite;
}

function summarizeJob(job: JobRecord): JobListItem {
  const pendingApprovals = job.approvals.filter((approval) => approval.status === "pending");
  const canResolveApprovals = job.status === "running" && !job.cancelRequestedAt;
  const actionableApprovals = canResolveApprovals ? pendingApprovals : [];
  return {
    key: job.key,
    jobIncarnation: job.jobIncarnation,
    status: job.status,
    updatedAt: job.updatedAt,
    workerId: job.workerId,
    workerPid: job.workerPid,
    workerAlive: isProcessAlive(job.workerPid),
    threadId: job.threadId,
    turnId: job.turnId,
    pendingApprovals: pendingApprovals.length,
    actionableApprovals: actionableApprovals.length,
    cancelRequestedAt: job.cancelRequestedAt,
    error: job.error,
  };
}

function isTerminalStatus(status: JobStatus | "unreadable"): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function readyReasonFor(summary: JobSummary, ignoredApprovalIds: string[]): JobWaitResult["reason"] | null {
  if (
    summary.status === "running"
    && summary.pendingApprovals.ids.some(id => !ignoredApprovalIds.includes(id))
  ) {
    return "approval_required";
  }
  if (summary.status === "completed" || summary.status === "failed" || summary.status === "cancelled") return "terminal";
  return null;
}

async function readJobRootEntries(root: string) {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isErrorWithCode(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}
