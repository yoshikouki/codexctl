import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AppServerClient, type AppServerEvent, jobDir } from "./app-server.ts";
import { compactJobEvent, type CompactJobEvent } from "./events.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export class JobOperationError extends Error {
  constructor(
    readonly code: "job_not_terminal" | "job_worker_alive" | "job_unreadable" | "job_state_changed",
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

class StaleWorkerWriteError extends Error {}

export type JobRecord = {
  key: string;
  jobIncarnation: string | null;
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
  workerId: string | null;
  workerGeneration: number;
  workerPid: number | null;
  workerHeartbeatAt: string | null;
  threadId: string | null;
  turnId: string | null;
  cancelRequestedAt: string | null;
  cancelCommandId: string | null;
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

export type TurnInterruptCommand = {
  id: string;
  type: "turn.interrupt";
  at: string;
};

export type ControlCommand = TurnSteerCommand | ApprovalResolveCommand | TurnInterruptCommand;

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

export type JobRecoveryResult = {
  action: "none" | "restarted" | "failed";
  reason: string;
  job: JobRecord;
};

export type JobRecoveryOptions = {
  expectedRecoveryStateId?: string | null;
};

export type JobReconcileOptions = {
  dryRun?: boolean;
};

export type JobReconcileDecision =
  | "restart_queued"
  | "restart_before_thread"
  | "fail_in_flight_dead_worker"
  | "skip_worker_alive"
  | "skip_terminal"
  | "skip_unreadable";

export type JobReconcileItem = {
  key: string;
  jobIncarnation: string | null;
  status: JobStatus | "unreadable";
  decision: JobReconcileDecision;
  reason: string;
  mutates: boolean;
  applied: boolean;
  recoveryStateId: string | null;
  workerId: string | null;
  workerGeneration: number | null;
  workerPid: number | null;
  workerHealth: WorkerHealth | null;
  threadId: string | null;
  turnId: string | null;
  result: JobRecoveryResult | null;
  error: string | null;
};

export type JobReconcileReport = {
  at: string;
  dryRun: boolean;
  scanned: number;
  candidates: number;
  mutations: number;
  applied: number;
  items: JobReconcileItem[];
};

export type JobCancelResult = {
  action: "cancelled" | "interrupt_queued" | "already_requested" | "failed" | "none";
  reason: string;
  job: JobRecord;
  command: TurnInterruptCommand | null;
};

export type JobRemoveOptions = {
  dryRun?: boolean;
  force?: boolean;
};

export type JobRemoveResult = {
  action: "removed" | "would_remove";
  key: string;
  status: JobStatus | "unreadable";
  reason: string;
};

export type JobPruneOptions = {
  dryRun?: boolean;
  keep?: number;
  status?: JobPruneStatus;
};

export type JobPruneResult = {
  scanned: number;
  matched: number;
  keep: number;
  status: JobPruneStatus;
  dryRun: boolean;
  removed: JobRemoveResult[];
};

export type JobPruneStatus = "completed" | "failed" | "cancelled" | "terminal";

export type JobListItem = {
  key: string;
  jobIncarnation: string | null;
  status: JobStatus | "unreadable";
  nextAction: JobNextAction | null;
  updatedAt: string | null;
  workerId: string | null;
  workerGeneration: number | null;
  workerPid: number | null;
  workerHeartbeatAt: string | null;
  workerAlive: boolean | null;
  workerHealth: WorkerHealth | null;
  threadId: string | null;
  turnId: string | null;
  pendingApprovals: number;
  actionableApprovals: number;
  cancelRequestedAt: string | null;
  error: string | null;
};

export type JobNextAction = "wait" | "wait_cancel" | "resolve_approval" | "read_result" | "inspect_error" | "cancelled";

export type JobSummary = {
  key: string;
  jobIncarnation: string | null;
  status: JobStatus;
  nextAction: JobNextAction;
  repo: string;
  prompt: string;
  model: string | null;
  approvalPolicy: JobRecord["approvalPolicy"];
  sandbox: JobRecord["sandbox"];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
  workerGeneration: number;
  workerPid: number | null;
  workerHealth: WorkerHealth;
  threadId: string | null;
  turnId: string | null;
  cancelRequestedAt: string | null;
  cancelCommandId: string | null;
  pendingApprovals: ApprovalRecord[];
  actionableApprovals: ApprovalRecord[];
  canResolveApprovals: boolean;
  approvalCounts: Record<ApprovalStatus, number>;
  finalResponse: string;
  error: string | null;
  diagnostics: JobSummaryDiagnostics;
  recentEvents: CompactJobEvent[];
};

export type JobWaitOptions = {
  eventLimit?: number;
  intervalMs?: number;
  timeoutMs?: number | null;
};

export type JobWaitResult = {
  key: string;
  ready: boolean;
  reason: "terminal" | "approval_required" | "timeout";
  elapsedMs: number;
  intervalMs: number;
  timeoutMs: number | null;
  deadlineAt: string | null;
  status: JobStatus;
  nextAction: JobNextAction;
  summary: JobSummary;
};

export type WorkerHealth = {
  pid: number | null;
  alive: boolean;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  stale: boolean;
  reason: "terminal" | "queued" | "no_worker_pid" | "alive_recent" | "alive_stale" | "dead";
};

export type JobSummaryDiagnostics = {
  compactEventCount: number;
  recentEventsLimit: number;
  recentEventsTruncated: boolean;
  warningCount: number;
  mcpFailureCount: number;
  appServerErrorCount: number;
  commandCounts: {
    started: number;
    completed: number;
    failed: number;
  };
  lastWarning: Extract<CompactJobEvent, { type: "warning" }> | null;
  lastError: Extract<CompactJobEvent, { type: "app_server.error" }> | null;
  lastFailedCommand: Extract<CompactJobEvent, { type: "command.completed" }> | null;
};

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_HEARTBEAT_STALE_MS = 30_000;
const JOB_RECORD_LOCK_STALE_MS = 30_000;
const JOB_RECORD_LOCK_RETRY_MS = 25;
const JOB_RECORD_LOCK_ATTEMPTS = 80;

export async function startJob(options: StartJobOptions): Promise<JobRecord> {
  const record = await createJob(options);
  if (options.detach) {
    const dir = jobDir(process.cwd(), record.key);
    return await spawnDetachedWorker(record, dir, "start");
  }
  return await runJobWorker(record.key);
}

export async function recoverJob(key: string, options: JobRecoveryOptions = {}): Promise<JobRecoveryResult> {
  const dir = jobDir(process.cwd(), key);
  const record = await readJob(key);
  if (
    options.expectedRecoveryStateId
    && jobRecoveryStateId(record) !== options.expectedRecoveryStateId
  ) {
    throw new JobOperationError("job_state_changed", `Job '${key}' changed before recovery could be applied`);
  }
  if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
    return { action: "none", reason: `job is already ${record.status}`, job: record };
  }
  if (record.status === "queued") {
    return { action: "restarted", reason: "queued job had no worker", job: await spawnDetachedWorker(record, dir, "recover") };
  }
  if (isProcessAlive(record.workerPid)) {
    return { action: "none", reason: `worker ${record.workerPid} is alive`, job: record };
  }
  if (!record.threadId && !record.turnId) {
    return { action: "restarted", reason: "worker died before starting a thread", job: await spawnDetachedWorker(record, dir, "recover") };
  }

  return await withJobRecordLock(dir, key, async () => {
    const current = await readPersistedJobRecord(dir, key);
    if (jobRecoveryStateId(current) !== jobRecoveryStateId(record)) {
      throw new JobOperationError("job_state_changed", `Job '${key}' changed before recovery failure could be applied`);
    }
    current.status = "failed";
    current.error = "worker process is not alive; in-flight app-server stdio sessions cannot be resumed";
    current.completedAt = new Date().toISOString();
    current.updatedAt = new Date().toISOString();
    await writeJobRecordUnlocked(dir, current);
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "recovery.failed", reason: "in_flight_stdio_session_not_resumable", workerPid: current.workerPid },
      at: new Date().toISOString(),
    });
    return { action: "failed", reason: "in-flight app-server stdio session cannot be resumed", job: current };
  });
}

export function jobRecoveryStateId(job: {
  jobIncarnation?: string | null;
  updatedAt: string | null;
  workerId?: string | null;
  workerGeneration?: number | null;
  workerPid: number | null;
  threadId: string | null;
  turnId: string | null;
}): string {
  return shortStableHash([job.jobIncarnation ?? null, job.updatedAt, job.workerId ?? null, job.workerGeneration ?? null, job.workerPid, job.threadId, job.turnId].join("\u0000"));
}

function shortStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function listJobs(): Promise<JobListItem[]> {
  const root = jobsRoot(process.cwd());
  const entries = await readJobRootEntries(root);
  const jobs = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<JobListItem> => {
      try {
        const job = await readPersistedJobRecord(join(root, entry.name), entry.name);
        return summarizeJob(job);
      } catch (error) {
        return {
          key: entry.name,
          jobIncarnation: null,
          status: "unreadable",
          nextAction: null,
          updatedAt: null,
          workerId: null,
          workerGeneration: null,
          workerPid: null,
          workerHeartbeatAt: null,
          workerAlive: null,
          workerHealth: null,
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

export async function sweepJobs(): Promise<JobRecoveryResult[]> {
  const report = await reconcileJobs();
  return report.items.flatMap((item) => item.result ? [item.result] : []);
}

export async function reconcileJobs(options: JobReconcileOptions = {}): Promise<JobReconcileReport> {
  const dryRun = options.dryRun ?? false;
  const jobs = await listJobs();
  const items: JobReconcileItem[] = [];
  for (const job of jobs) {
    const item = classifyJobReconciliation(job);
    if (!item) continue;
    if (!dryRun && item.mutates) {
      try {
        item.result = await recoverJob(job.key, { expectedRecoveryStateId: item.recoveryStateId });
        item.applied = true;
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    items.push(item);
  }
  return {
    at: new Date().toISOString(),
    dryRun,
    scanned: jobs.length,
    candidates: items.length,
    mutations: items.filter((item) => item.mutates).length,
    applied: items.filter((item) => item.applied).length,
    items,
  };
}

export async function removeJob(key: string, options: JobRemoveOptions = {}): Promise<JobRemoveResult> {
  const dir = jobDir(process.cwd(), key);
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

export async function pruneJobs(options: JobPruneOptions = {}): Promise<JobPruneResult> {
  const keep = options.keep ?? 10;
  const status = options.status ?? "completed";
  const jobs = await listJobs();
  const matchedJobs = jobs
    .filter((job) => matchesPruneStatus(job.status, status))
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  const candidates = matchedJobs.slice(keep);
  const removed: JobRemoveResult[] = [];
  for (const job of candidates) {
    removed.push(await removeJob(job.key, { dryRun: options.dryRun }));
  }
  return {
    scanned: jobs.length,
    matched: matchedJobs.length,
    keep,
    status,
    dryRun: options.dryRun ?? false,
    removed,
  };
}

export async function cancelJob(key: string): Promise<JobCancelResult> {
  const dir = jobDir(process.cwd(), key);
  return await withJobRecordLock(dir, key, async () => {
    const job = await readPersistedJobRecord(dir, key);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return { action: "none", reason: `job is already ${job.status}`, job, command: null };
    }
    if (job.status === "queued") {
      const now = new Date().toISOString();
      job.status = "cancelled";
      job.error = null;
      job.cancelRequestedAt = now;
      job.completedAt = now;
      job.updatedAt = now;
      await writeJobRecordUnlocked(dir, job);
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "job.cancelled", reason: "queued" },
        at: now,
      });
      return { action: "cancelled", reason: "queued job cancelled before worker start", job, command: null };
    }

    if (job.cancelRequestedAt) {
      return { action: "already_requested", reason: "turn interrupt command was already queued", job, command: null };
    }

    if (!isProcessAlive(job.workerPid)) {
      const now = new Date().toISOString();
      if (!job.threadId && !job.turnId) {
        job.status = "cancelled";
        job.error = null;
        job.cancelRequestedAt = now;
        job.completedAt = now;
        job.updatedAt = now;
        await writeJobRecordUnlocked(dir, job);
        await appendEvent(dir, {
          direction: "worker",
          event: { type: "job.cancelled", reason: "worker_not_alive_before_turn_start", workerPid: job.workerPid },
          at: now,
        });
        return { action: "cancelled", reason: "worker was not alive before turn start", job, command: null };
      }

      job.status = "failed";
      job.error = "worker process is not alive; in-flight app-server stdio sessions cannot be interrupted";
      job.completedAt = now;
      job.updatedAt = now;
      await writeJobRecordUnlocked(dir, job);
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "cancel.failed", reason: "in_flight_stdio_session_not_interruptible", workerPid: job.workerPid },
        at: now,
      });
      return { action: "failed", reason: "in-flight app-server stdio session cannot be interrupted", job, command: null };
    }

    const now = new Date().toISOString();
    const command: TurnInterruptCommand = {
      id: crypto.randomUUID(),
      type: "turn.interrupt",
      at: now,
    };
    job.cancelRequestedAt = now;
    job.cancelCommandId = command.id;
    job.updatedAt = now;
    await appendFile(`${dir}/control.jsonl`, JSON.stringify(command) + "\n");
    await appendEvent(dir, {
      direction: "control",
      command,
      at: now,
    });
    await writeJobRecordUnlocked(dir, job);
    return { action: "interrupt_queued", reason: "turn interrupt command queued", job, command };
  });
}

export async function createJob(options: StartJobOptions): Promise<JobRecord> {
  const repo = normalizeRepo(options.repo);
  const root = process.cwd();
  const dir = jobDir(root, options.key);
  await mkdir(dir, { recursive: true });
  return await withJobRecordLock(dir, options.key, async () => {
    const existingJob = Bun.file(`${dir}/job.json`);
    if ((await existingJob.exists()) && !options.force) {
      throw new Error(`Job '${options.key}' already exists; use --force to replace its local record`);
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
      model: options.model ?? null,
      approvalPolicy: options.approvalPolicy ?? "on-request",
      sandbox: options.sandbox ?? null,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      workerId: null,
      workerGeneration: 0,
      workerPid: null,
      workerHeartbeatAt: null,
      threadId: null,
      turnId: null,
      cancelRequestedAt: null,
      cancelCommandId: null,
      approvals: [],
      finalResponse: "",
      error: null,
    };
    await writeJobRecordUnlocked(dir, record);
    return record;
  });
}

async function spawnDetachedWorker(record: JobRecord, dir: string, reason: "start" | "recover"): Promise<JobRecord> {
  return await withJobRecordLock(dir, record.key, async () => {
    const current = await readPersistedJobRecord(dir, record.key);
    if (jobRecoveryStateId(current) !== jobRecoveryStateId(record)) {
      throw new JobOperationError("job_state_changed", `Job '${record.key}' changed before worker spawn could be applied`);
    }
    const workerId = crypto.randomUUID();
    const workerGeneration = current.workerGeneration + 1;
    current.status = "running";
    current.workerId = workerId;
    current.workerGeneration = workerGeneration;
    current.workerPid = null;
    current.workerHeartbeatAt = new Date().toISOString();
    current.completedAt = null;
    current.updatedAt = new Date().toISOString();
    await writeJobRecordUnlocked(dir, current);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd: [process.execPath, import.meta.resolveSync("./cli.ts"), "internal", "worker", current.key],
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEXCTL_WORKER_ID: workerId,
          CODEXCTL_WORKER_GENERATION: String(workerGeneration),
        },
        stdin: "ignore",
        stdout: Bun.file(`${dir}/worker.log`),
        stderr: Bun.file(`${dir}/worker.err.log`),
        detached: true,
      });
    } catch (error) {
      current.status = "failed";
      current.workerPid = null;
      current.error = error instanceof Error ? error.message : String(error);
      current.completedAt = new Date().toISOString();
      current.updatedAt = new Date().toISOString();
      await writeJobRecordUnlocked(dir, current);
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "worker.spawn_failed", workerId, workerGeneration, reason, error: current.error },
        at: new Date().toISOString(),
      });
      throw error;
    }
    proc.unref();
    current.workerPid = proc.pid;
    current.workerHeartbeatAt = new Date().toISOString();
    current.updatedAt = new Date().toISOString();
    await writeJobRecordUnlocked(dir, current);
    await writeWorkerHeartbeatUnlocked(dir, current);
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "worker.spawned", pid: proc.pid, workerId, workerGeneration, reason },
      at: new Date().toISOString(),
    });
    return current;
  });
}

export async function runJobWorker(key: string): Promise<JobRecord> {
  const dir = jobDir(process.cwd(), key);
  const record = await readJob(key);
  record.status = "running";
  record.startedAt ??= new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  const envWorkerId = process.env.CODEXCTL_WORKER_ID;
  if (envWorkerId) record.workerId = envWorkerId;
  else if (!record.workerId) record.workerId = crypto.randomUUID();
  const envGeneration = Number(process.env.CODEXCTL_WORKER_GENERATION);
  if (Number.isInteger(envGeneration) && envGeneration > 0) record.workerGeneration = envGeneration;
  else if (record.workerGeneration <= 0) record.workerGeneration = 1;
  record.workerPid ??= process.pid;
  record.workerHeartbeatAt = new Date().toISOString();
  await writeWorkerJobRecord(dir, record);
  await writeWorkerHeartbeat(dir, record);
  await appendEvent(dir, {
    direction: "worker",
    event: { type: "worker.started", pid: process.pid, workerId: record.workerId, workerGeneration: record.workerGeneration },
    at: new Date().toISOString(),
  });

  const processedControlIds = new Set<string>();
  const heartbeatTimer = setInterval(() => {
    void refreshWorkerHeartbeat(record, dir).catch(() => undefined);
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  const client = new AppServerClient(async (event) => {
    await appendEvent(dir, event);
    updateRecordFromEvent(record, event);
    await writeWorkerJobRecord(dir, record);
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
    await writeWorkerJobRecord(dir, record);

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
    if (error instanceof StaleWorkerWriteError) {
      await appendEvent(dir, {
        direction: "worker",
        event: { type: "worker.stale", pid: process.pid, workerId: record.workerId, workerGeneration: record.workerGeneration, error: error.message },
        at: new Date().toISOString(),
      });
      throw error;
    }
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.completedAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    try {
      await writeWorkerJobRecord(dir, record);
    } catch (writeError) {
      if (writeError instanceof StaleWorkerWriteError) {
        await appendEvent(dir, {
          direction: "worker",
          event: { type: "worker.stale", pid: process.pid, workerId: record.workerId, workerGeneration: record.workerGeneration, error: writeError.message },
          at: new Date().toISOString(),
        });
      } else {
        throw writeError;
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    await client.close();
    await appendEvent(dir, {
      direction: "worker",
      event: { type: "worker.exited", pid: process.pid, status: record.status },
      at: new Date().toISOString(),
    });
  }
}

export async function readJob(key: string): Promise<JobRecord> {
  const dir = jobDir(process.cwd(), key);
  return await readPersistedJobRecord(dir, key);
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

export async function readJobSummary(key: string, eventLimit = 10): Promise<JobSummary> {
  const job = await readJob(key);
  const compactEvents = (await readJobEvents(key)).flatMap((event) => compactJobEvent(event));
  const recentEvents = eventLimit <= 0 ? [] : compactEvents.slice(-eventLimit);
  const pendingApprovals = job.approvals.filter((approval) => approval.status === "pending");
  const canResolveApprovals = job.status === "running" && !job.cancelRequestedAt;
  const actionableApprovals = canResolveApprovals ? pendingApprovals : [];
  return {
    key: job.key,
    jobIncarnation: job.jobIncarnation,
    status: job.status,
    nextAction: nextAction(job.status, actionableApprovals, job.cancelRequestedAt),
    repo: job.repo,
    prompt: job.prompt,
    model: job.model,
    approvalPolicy: job.approvalPolicy,
    sandbox: job.sandbox,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    workerId: job.workerId,
    workerGeneration: job.workerGeneration,
    workerPid: job.workerPid,
    workerHealth: workerHealth(job),
    threadId: job.threadId,
    turnId: job.turnId,
    cancelRequestedAt: job.cancelRequestedAt,
    cancelCommandId: job.cancelCommandId,
    pendingApprovals,
    actionableApprovals,
    canResolveApprovals,
    approvalCounts: approvalCounts(job.approvals),
    finalResponse: job.finalResponse,
    error: job.error,
    diagnostics: summarizeCompactEvents(compactEvents, eventLimit),
    recentEvents,
  };
}

export async function waitForJob(key: string, options: JobWaitOptions = {}): Promise<JobWaitResult> {
  const eventLimit = options.eventLimit ?? 10;
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? null;
  const startedAt = Date.now();
  const deadline = timeoutMs === null ? null : startedAt + timeoutMs;

  while (true) {
    const summary = await readJobSummary(key, eventLimit);
    const readyReason = readyReasonFor(summary);
    const now = Date.now();
    if (readyReason) {
      return jobWaitResult(key, summary, true, readyReason, startedAt, now, intervalMs, timeoutMs, deadline);
    }
    if (deadline !== null && now >= deadline) {
      return jobWaitResult(key, summary, false, "timeout", startedAt, now, intervalMs, timeoutMs, deadline);
    }
    const sleepMs = deadline === null ? intervalMs : Math.max(0, Math.min(intervalMs, deadline - now));
    await Bun.sleep(sleepMs);
  }
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
  await appendEvent(dir, {
    direction: "control",
    command,
    at: new Date().toISOString(),
  });
  return command;
}

export async function readNewEventLines(key: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  const path = `${jobDir(process.cwd(), key)}/events.jsonl`;
  return await readNewCompleteLines(path, offset);
}

async function waitForTurnCompletion(
  record: JobRecord,
  client: AppServerClient,
  dir: string,
  processedControlIds: Set<string>,
): Promise<void> {
  let controlOffset = 0;
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
  for (const line of result.lines) {
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
    if (command.type === "turn.interrupt") {
      record.cancelRequestedAt ??= command.at;
      record.cancelCommandId ??= command.id;
      record.updatedAt = new Date().toISOString();
      await writeWorkerJobRecord(dir, record);
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
    await writeWorkerJobRecord(dir, record);
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
  await writeWorkerJobRecord(dir, record);
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
  if (approval.method === "item/commandExecution/requestApproval") {
    return { supported: true, response: { decision: modernApprovalDecision(approval, decision) } };
  }
  if (approval.method === "item/fileChange/requestApproval") {
    return { supported: true, response: { decision: modernApprovalDecision(approval, decision) } };
  }
  if (approval.method === "execCommandApproval" || approval.method === "applyPatchApproval") {
    return { supported: true, response: { decision: legacyApprovalDecision(decision) } };
  }
  if (approval.method === "item/permissions/requestApproval") {
    return permissionsApprovalResponseFor(approval, decision);
  }
  return { supported: false, error: `Approval method '${approval.method}' is not supported yet` };
}

function permissionsApprovalResponseFor(
  approval: ApprovalRecord,
  decision: ApprovalResolveCommand["decision"],
): { supported: true; response: unknown } | { supported: false; error: string } {
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

async function readNewCompleteLines(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], offset };
  const size = file.size;
  if (offset > size) offset = 0;
  if (offset === size) return { lines: [], offset };

  const chunk = await file.slice(offset, size).text();
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) return { lines: [], offset };

  const consumed = chunk.slice(0, lastNewline + 1);
  return {
    lines: consumed
      .split("\n")
      .filter((line) => line.trim().length > 0),
    offset: offset + new TextEncoder().encode(consumed).byteLength,
  };
}

async function writeJobRecord(dir: string, record: JobRecord): Promise<void> {
  await mkdir(dirname(`${dir}/job.json`), { recursive: true });
  await withJobRecordLock(dir, record.key, async () => {
    await writeJobRecordUnlocked(dir, record);
  });
}

async function writeJobRecordUnlocked(dir: string, record: JobRecord): Promise<void> {
  await Bun.write(`${dir}/job.json`, JSON.stringify(record, null, 2) + "\n");
}

async function writeWorkerJobRecord(dir: string, record: JobRecord): Promise<void> {
  await withJobRecordLock(dir, record.key, async () => {
    await assertCurrentWorkerRecordUnlocked(dir, record);
    await mergePersistedControlFields(dir, record);
    await assertCurrentWorkerRecordUnlocked(dir, record);
    await writeJobRecordUnlocked(dir, record);
  });
}

async function assertCurrentWorkerRecordUnlocked(dir: string, record: JobRecord): Promise<void> {
  let latest: JobRecord;
  try {
    latest = normalizeJobRecord(await Bun.file(`${dir}/job.json`).json(), record.key);
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      throw new StaleWorkerWriteError(`job record for '${record.key}' no longer exists`);
    }
    throw error;
  }
  if (latest.workerId !== null && record.workerId !== null && latest.workerId !== record.workerId) {
    throw new StaleWorkerWriteError(`worker ${record.workerId} is stale; current worker is ${latest.workerId}`);
  }
  if (latest.jobIncarnation !== null && latest.jobIncarnation !== record.jobIncarnation) {
    throw new StaleWorkerWriteError(`job incarnation ${record.jobIncarnation ?? "legacy"} is stale; current incarnation is ${latest.jobIncarnation}`);
  }
  if (latest.workerGeneration > 0 && record.workerGeneration > 0 && latest.workerGeneration !== record.workerGeneration) {
    throw new StaleWorkerWriteError(`worker generation ${record.workerGeneration} is stale; current generation is ${latest.workerGeneration}`);
  }
}

async function withJobRecordLock<T>(dir: string, key: string, work: () => Promise<T>): Promise<T> {
  const lockDir = `${dir}/job.lock`;
  for (let attempt = 0; attempt < JOB_RECORD_LOCK_ATTEMPTS; attempt++) {
    const ownerToken = crypto.randomUUID();
    try {
      await mkdir(lockDir);
      await Bun.write(`${lockDir}/owner.json`, JSON.stringify({
        token: ownerToken,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n");
      try {
        return await work();
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== "EEXIST") throw error;
      if (await breakStaleJobRecordLock(lockDir)) continue;
      await sleep(JOB_RECORD_LOCK_RETRY_MS);
    }
  }
  throw new JobOperationError("job_state_changed", `Job '${key}' job record is locked by another writer`);
}

async function breakStaleJobRecordLock(lockDir: string): Promise<boolean> {
  try {
    const ownerText = await Bun.file(`${lockDir}/owner.json`).text();
    const owner = JSON.parse(ownerText) as unknown;
    if (!isObject(owner)) return await breakStaleJobRecordLockByMtime(lockDir, ownerText);
    const pid = typeof owner.pid === "number" ? owner.pid : null;
    const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
    const age = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
    if ((pid !== null && !isProcessAlive(pid)) || age > JOB_RECORD_LOCK_STALE_MS) {
      if (!await jobRecordLockOwnerStillMatches(lockDir, ownerText)) return false;
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return await breakStaleJobRecordLockByMtime(lockDir, null);
  }
  return false;
}

async function breakStaleJobRecordLockByMtime(lockDir: string, expectedOwnerText: string | null): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > JOB_RECORD_LOCK_STALE_MS) {
      if (expectedOwnerText !== null && !await jobRecordLockOwnerStillMatches(lockDir, expectedOwnerText)) return false;
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function jobRecordLockOwnerStillMatches(lockDir: string, expectedOwnerText: string): Promise<boolean> {
  try {
    return await Bun.file(`${lockDir}/owner.json`).text() === expectedOwnerText;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mergePersistedControlFields(dir: string, record: JobRecord): Promise<void> {
  try {
    const latest = normalizeJobRecord(await Bun.file(`${dir}/job.json`).json(), record.key);
    record.cancelRequestedAt = latest.cancelRequestedAt ?? record.cancelRequestedAt;
    record.cancelCommandId = latest.cancelCommandId ?? record.cancelCommandId;
  } catch {
    return;
  }
}

async function refreshWorkerHeartbeat(record: JobRecord, dir: string): Promise<void> {
  const now = Date.now();
  const previous = record.workerHeartbeatAt ? Date.parse(record.workerHeartbeatAt) : 0;
  if (Number.isFinite(previous) && now - previous < WORKER_HEARTBEAT_INTERVAL_MS) return;
  record.workerHeartbeatAt = new Date(now).toISOString();
  await writeWorkerHeartbeat(dir, record);
}

async function writeWorkerHeartbeat(dir: string, record: JobRecord): Promise<void> {
  await withJobRecordLock(dir, record.key, async () => {
    await assertCurrentWorkerRecordUnlocked(dir, record);
    await writeWorkerHeartbeatUnlocked(dir, record);
  });
}

async function writeWorkerHeartbeatUnlocked(dir: string, record: JobRecord): Promise<void> {
  await Bun.write(`${dir}/worker-heartbeat.json`, JSON.stringify({
    jobIncarnation: record.jobIncarnation,
    workerId: record.workerId,
    workerGeneration: record.workerGeneration,
    workerPid: record.workerPid,
    workerHeartbeatAt: record.workerHeartbeatAt,
  }, null, 2) + "\n");
}

async function readPersistedJobRecord(dir: string, key: string): Promise<JobRecord> {
  const record = normalizeJobRecord(await Bun.file(`${dir}/job.json`).json(), key);
  await overlayCancelRequest(record, dir);
  return await overlayWorkerHeartbeat(record, dir);
}

async function overlayCancelRequest(record: JobRecord, dir: string): Promise<void> {
  const file = Bun.file(`${dir}/control.jsonl`);
  if (!(await file.exists())) return;
  try {
    const text = await file.text();
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const command = JSON.parse(line) as Partial<ControlCommand>;
      if (command.type !== "turn.interrupt") continue;
      if (typeof command.at === "string") record.cancelRequestedAt = command.at;
      if (typeof command.id === "string") record.cancelCommandId = command.id;
      return;
    }
  } catch {
    return;
  }
}

async function overlayWorkerHeartbeat(record: JobRecord, dir: string): Promise<JobRecord> {
  const file = Bun.file(`${dir}/worker-heartbeat.json`);
  if (!(await file.exists())) return record;
  try {
    const heartbeat = await file.json();
    if (isObject(heartbeat) && typeof heartbeat.workerHeartbeatAt === "string") {
      if (!heartbeatMatchesCurrentWorker(heartbeat, record)) return record;
      record.workerHeartbeatAt = heartbeat.workerHeartbeatAt;
    }
  } catch {
    return record;
  }
  return record;
}

function heartbeatMatchesCurrentWorker(heartbeat: Record<string, unknown>, record: JobRecord): boolean {
  if (record.jobIncarnation !== null && heartbeat.jobIncarnation !== record.jobIncarnation) {
    return false;
  }
  if (record.workerId !== null && typeof heartbeat.workerId !== "string") {
    return false;
  }
  if (typeof heartbeat.workerId === "string" && record.workerId !== null && heartbeat.workerId !== record.workerId) {
    return false;
  }
  if (record.workerGeneration > 0 && typeof heartbeat.workerGeneration !== "number") {
    return false;
  }
  if (
    typeof heartbeat.workerGeneration === "number"
    && record.workerGeneration > 0
    && heartbeat.workerGeneration !== record.workerGeneration
  ) {
    return false;
  }
  return true;
}

function summarizeJob(job: JobRecord): JobListItem {
  const pendingApprovals = job.approvals.filter((approval) => approval.status === "pending");
  const canResolveApprovals = job.status === "running" && !job.cancelRequestedAt;
  const actionableApprovals = canResolveApprovals ? pendingApprovals : [];
  const health = workerHealth(job);
  return {
    key: job.key,
    jobIncarnation: job.jobIncarnation,
    status: job.status,
    nextAction: nextAction(job.status, actionableApprovals, job.cancelRequestedAt),
    updatedAt: job.updatedAt,
    workerId: job.workerId,
    workerGeneration: job.workerGeneration,
    workerPid: job.workerPid,
    workerHeartbeatAt: job.workerHeartbeatAt,
    workerAlive: health.alive,
    workerHealth: health,
    threadId: job.threadId,
    turnId: job.turnId,
    pendingApprovals: pendingApprovals.length,
    actionableApprovals: actionableApprovals.length,
    cancelRequestedAt: job.cancelRequestedAt,
    error: job.error,
  };
}

function classifyJobReconciliation(job: JobListItem): JobReconcileItem | null {
  if (job.status === "unreadable") {
    return reconcileItem(job, "skip_unreadable", job.error ?? "job record is unreadable", false);
  }
  if (isTerminalStatus(job.status)) {
    return null;
  }
  if (job.status === "queued") {
    return reconcileItem(job, "restart_queued", "queued job has no worker", true);
  }
  if (job.workerHealth?.alive) {
    return reconcileItem(job, "skip_worker_alive", `worker ${job.workerPid} is alive`, false);
  }
  if (!job.threadId && !job.turnId) {
    return reconcileItem(job, "restart_before_thread", "worker died before starting a thread", true);
  }
  return reconcileItem(job, "fail_in_flight_dead_worker", "in-flight app-server stdio session cannot be resumed", true);
}

function reconcileItem(
  job: JobListItem,
  decision: JobReconcileDecision,
  reason: string,
  mutates: boolean,
): JobReconcileItem {
  return {
    key: job.key,
    jobIncarnation: job.jobIncarnation,
    status: job.status,
    decision,
    reason,
    mutates,
    applied: false,
    recoveryStateId: job.status === "unreadable" ? null : jobRecoveryStateId(job),
    workerId: job.workerId,
    workerGeneration: job.workerGeneration,
    workerPid: job.workerPid,
    workerHealth: job.workerHealth,
    threadId: job.threadId,
    turnId: job.turnId,
    result: null,
    error: job.status === "unreadable" ? job.error : null,
  };
}

function isTerminalStatus(status: JobStatus | "unreadable"): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function matchesPruneStatus(status: JobStatus | "unreadable", filter: JobPruneStatus): boolean {
  if (filter === "terminal") return isTerminalStatus(status);
  return status === filter;
}

function approvalCounts(approvals: ApprovalRecord[]): Record<ApprovalStatus, number> {
  const counts: Record<ApprovalStatus, number> = {
    approved: 0,
    cancelled: 0,
    pending: 0,
    rejected: 0,
    unsupported: 0,
  };
  for (const approval of approvals) {
    counts[approval.status]++;
  }
  return counts;
}

function nextAction(
  status: JobStatus,
  actionableApprovals: ApprovalRecord[],
  cancelRequestedAt: string | null = null,
): JobSummary["nextAction"] {
  if (status === "running" && cancelRequestedAt) return "wait_cancel";
  if (actionableApprovals.length > 0) return "resolve_approval";
  if (status === "queued" || status === "running") return "wait";
  if (status === "failed") return "inspect_error";
  if (status === "cancelled") return "cancelled";
  return "read_result";
}

function readyReasonFor(summary: JobSummary): JobWaitResult["reason"] | null {
  if (summary.nextAction === "resolve_approval") return "approval_required";
  if (summary.status === "completed" || summary.status === "failed" || summary.status === "cancelled") return "terminal";
  return null;
}

function jobWaitResult(
  key: string,
  summary: JobSummary,
  ready: boolean,
  reason: JobWaitResult["reason"],
  startedAt: number,
  endedAt: number,
  intervalMs: number,
  timeoutMs: number | null,
  deadline: number | null,
): JobWaitResult {
  return {
    key,
    ready,
    reason,
    elapsedMs: Math.max(0, endedAt - startedAt),
    intervalMs,
    timeoutMs,
    deadlineAt: deadline === null ? null : new Date(deadline).toISOString(),
    status: summary.status,
    nextAction: summary.nextAction,
    summary,
  };
}

function summarizeCompactEvents(events: CompactJobEvent[], eventLimit: number): JobSummaryDiagnostics {
  const diagnostics: JobSummaryDiagnostics = {
    compactEventCount: events.length,
    recentEventsLimit: eventLimit,
    recentEventsTruncated: eventLimit <= 0 ? events.length > 0 : events.length > eventLimit,
    warningCount: 0,
    mcpFailureCount: 0,
    appServerErrorCount: 0,
    commandCounts: {
      started: 0,
      completed: 0,
      failed: 0,
    },
    lastWarning: null,
    lastError: null,
    lastFailedCommand: null,
  };

  for (const event of events) {
    if (event.type === "warning") {
      diagnostics.warningCount++;
      diagnostics.lastWarning = event;
      continue;
    }
    if (event.type === "mcp.failed") {
      diagnostics.mcpFailureCount++;
      continue;
    }
    if (event.type === "app_server.error") {
      diagnostics.appServerErrorCount++;
      diagnostics.lastError = event;
      continue;
    }
    if (event.type === "command.started") {
      diagnostics.commandCounts.started++;
      continue;
    }
    if (event.type === "command.completed") {
      diagnostics.commandCounts.completed++;
      if (event.status === "failed" || (event.exitCode !== null && event.exitCode !== 0)) {
        diagnostics.commandCounts.failed++;
        diagnostics.lastFailedCommand = event;
      }
    }
  }

  return diagnostics;
}

function normalizeJobRecord(value: unknown, fallbackKey: string): JobRecord {
  if (!isObject(value)) throw new Error("job.json did not contain an object");
  const now = new Date().toISOString();
  const status = value.status === "queued" || value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled"
    ? value.status
    : "failed";
  return {
    key: typeof value.key === "string" ? value.key : fallbackKey,
    jobIncarnation: typeof value.jobIncarnation === "string" ? value.jobIncarnation : null,
    repo: typeof value.repo === "string" ? value.repo : process.cwd(),
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    model: typeof value.model === "string" ? value.model : null,
    approvalPolicy: isApprovalPolicy(value.approvalPolicy) ? value.approvalPolicy : "on-request",
    sandbox: isSandbox(value.sandbox) ? value.sandbox : null,
    status,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
    workerId: typeof value.workerId === "string" ? value.workerId : null,
    workerGeneration: typeof value.workerGeneration === "number" && Number.isInteger(value.workerGeneration) && value.workerGeneration >= 0
      ? value.workerGeneration
      : 0,
    workerPid: typeof value.workerPid === "number" ? value.workerPid : null,
    workerHeartbeatAt: typeof value.workerHeartbeatAt === "string" ? value.workerHeartbeatAt : null,
    threadId: typeof value.threadId === "string" ? value.threadId : null,
    turnId: typeof value.turnId === "string" ? value.turnId : null,
    cancelRequestedAt: typeof value.cancelRequestedAt === "string" ? value.cancelRequestedAt : null,
    cancelCommandId: typeof value.cancelCommandId === "string" ? value.cancelCommandId : null,
    approvals: Array.isArray(value.approvals) ? value.approvals as ApprovalRecord[] : [],
    finalResponse: typeof value.finalResponse === "string" ? value.finalResponse : "",
    error: typeof value.error === "string" ? value.error : null,
  };
}

function isApprovalPolicy(value: unknown): value is JobRecord["approvalPolicy"] {
  return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
}

function isSandbox(value: unknown): value is NonNullable<JobRecord["sandbox"]> {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

async function readJobRootEntries(root: string) {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeRepo(repo: string): string {
  return isAbsolute(repo) ? repo : resolve(process.cwd(), repo);
}

function jobsRoot(root: string): string {
  return join(root, ".codexctl", "jobs");
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

export function workerHealth(job: JobRecord): WorkerHealth {
  if (isTerminalStatus(job.status)) {
    return {
      pid: job.workerPid,
      alive: job.workerPid === null ? false : isProcessAlive(job.workerPid),
      heartbeatAt: job.workerHeartbeatAt,
      heartbeatAgeMs: heartbeatAgeMs(job.workerHeartbeatAt),
      stale: false,
      reason: "terminal",
    };
  }
  if (job.status === "queued") {
    return {
      pid: job.workerPid,
      alive: job.workerPid === null ? false : isProcessAlive(job.workerPid),
      heartbeatAt: job.workerHeartbeatAt,
      heartbeatAgeMs: heartbeatAgeMs(job.workerHeartbeatAt),
      stale: false,
      reason: "queued",
    };
  }
  if (job.workerPid === null) {
    return {
      pid: null,
      alive: false,
      heartbeatAt: job.workerHeartbeatAt,
      heartbeatAgeMs: heartbeatAgeMs(job.workerHeartbeatAt),
      stale: true,
      reason: "no_worker_pid",
    };
  }

  const alive = isProcessAlive(job.workerPid);
  const age = heartbeatAgeMs(job.workerHeartbeatAt);
  const stale = !alive || age === null || age > WORKER_HEARTBEAT_STALE_MS;
  return {
    pid: job.workerPid,
    alive,
    heartbeatAt: job.workerHeartbeatAt,
    heartbeatAgeMs: age,
    stale,
    reason: alive ? (stale ? "alive_stale" : "alive_recent") : "dead",
  };
}

function heartbeatAgeMs(heartbeatAt: string | null): number | null {
  if (!heartbeatAt) return null;
  const timestamp = Date.parse(heartbeatAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Date.now() - timestamp);
}

function isErrorWithCode(value: unknown): value is { code: string } {
  return typeof value === "object" && value !== null && "code" in value;
}
