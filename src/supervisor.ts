import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  listJobs,
  jobRecoveryStateId,
  reconcileJobs,
  readApprovals,
  readJobSummary,
  recoverJob,
  type ApprovalRecord,
  type JobReconcileReport,
  type JobListItem,
  type JobRecoveryResult,
  type JobSummary,
} from "./job.ts";

const HISTORY_READ_CHUNK_BYTES = 64 * 1024;
const WAIT_CANCEL_ATTENTION_MS = 60_000;
const WAIT_CANCEL_CRITICAL_MS = 5 * 60_000;
const STALE_WORKER_CRITICAL_MS = 5 * 60_000;
const POLICY_PERSISTENCE_TICKS = 3;
const RECOVER_DEAD_WORKER_CONFIRMATION = "recover-dead-worker";
const START_STATE_WAIT_MS = 1_000;
const SUPERVISOR_LOCK_ATTEMPTS = 300;
const SUPERVISOR_LOCK_RETRY_MS = 25;
const SUPERVISOR_LOCK_STALE_MS = 30_000;

export type SupervisorTick = {
  at: string;
  health: SupervisorHealthSummary;
  actions: SupervisorAction[];
  recovered: JobRecoveryResult[];
  reconciliation: JobReconcileReport | null;
};

export type SupervisorActionHistory = {
  at: string;
  tickLimit: number;
  eventsScanned: number;
  tickCount: number;
  latestTickAt: string | null;
  latestActions: SupervisorAction[];
  ticks: SupervisorActionHistoryTick[];
};

export type SupervisorActionHistoryTick = {
  eventAt: string | null;
  tickAt: string;
  health: SupervisorHealthSummary;
  actions: SupervisorAction[];
};

export type SupervisorHealthSummary = {
  total: number;
  unreadable: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  staleWorkers: number;
  deadWorkers: number;
  pendingApprovals: number;
  actionableApprovals: number;
  waitingCancel: number;
  inspectError: number;
};

export type SupervisorActionKind =
  | "resolve_approval"
  | "wait_cancel"
  | "inspect_error"
  | "inspect_stale_worker"
  | "inspect_dead_worker"
  | "inspect_unreadable";

export type SupervisorAction = {
  id: string;
  jobKey: string;
  kind: SupervisorActionKind;
  severity: "info" | "attention" | "critical";
  reason: string;
  nextCommand: string;
  ageMs?: number | null;
  thresholdMs?: number | null;
  firstSeenAt?: string;
  seenTicks?: number;
  criticalSeenTicks?: number;
  policy?: SupervisorPolicyRecommendation;
};

export class SupervisorOperationError extends Error {
  constructor(
    readonly code: "supervisor_action_not_found" | "supervisor_action_not_applicable" | "supervisor_confirmation_required" | "supervisor_locked" | "supervisor_identity_unverified",
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

export type SupervisorPolicyRecommendation = {
  recommendation: "inspect" | "escalate";
  reason: string;
  basedOn: Array<"severity" | "persistence">;
  thresholdTicks?: number;
};

export type SupervisorState = {
  status: "idle" | "running" | "stopped";
  startedAt: string | null;
  updatedAt: string;
  pid: number | null;
  supervisorId: string | null;
  tickCount: number;
  lastTick: SupervisorTick | null;
};

export type SupervisorRunOptions = {
  intervalMs: number;
  once?: boolean;
  maxTicks?: number;
  supervisorId?: string;
};

export type SupervisorStartOptions = {
  intervalMs: number;
  maxTicks?: number;
};

export type SupervisorStartResult = {
  action: "started" | "already_running";
  pid: number;
  intervalMs: number;
  maxTicks: number | null;
  state: SupervisorState | null;
  logPath: string;
  errorLogPath: string;
};

export type SupervisorStopOptions = {
  timeoutMs?: number;
};

export type SupervisorStopResult = {
  action: "stop_requested" | "already_stopped" | "stale_state";
  pid: number | null;
  signal: "SIGTERM" | null;
  waitedMs: number;
  state: SupervisorState | null;
};

export type SupervisorWaitOptions = {
  afterTick?: number;
  intervalMs?: number;
  timeoutMs?: number | null;
};

export type SupervisorWaitResult = {
  ready: boolean;
  reason: "actions" | "stale" | "stopped" | "tick" | "timeout";
  elapsedMs: number;
  intervalMs: number;
  afterTick: number;
  timeoutMs: number | null;
  deadlineAt: string | null;
  state: SupervisorState | null;
  actions: SupervisorAction[];
};

export type SupervisorNextOptions = SupervisorWaitOptions & {
  startIntervalMs?: number;
  startMaxTicks?: number;
};

export type SupervisorInboxOptions = SupervisorNextOptions & {
  limit?: number;
};

export type SupervisorNextResult = {
  at: string;
  start: SupervisorStartResult;
  wait: SupervisorWaitResult;
  action: SupervisorAction | null;
  inspection: SupervisorActionInspection | null;
};

export type SupervisorInboxItem = {
  action: SupervisorAction;
  inspection: SupervisorActionInspection;
};

export type SupervisorInboxResult = {
  at: string;
  start: SupervisorStartResult;
  wait: SupervisorWaitResult;
  items: SupervisorInboxItem[];
};

export type SupervisorActionInspection = {
  at: string;
  planAt: string;
  readOnly: true;
  action: SupervisorAction;
  inspection: SupervisorActionInspectionPayload;
};

export type SupervisorActionInspectionPayload =
  | {
    type: "approval_list";
    approvals: ApprovalRecord[];
  }
  | {
    type: "job_summary";
    eventLimit: number;
    summary: JobSummary;
  }
  | {
    type: "unreadable_job";
    error: string;
  };

export type SupervisorActionApplyOptions = {
  actionId?: string | null;
  confirm?: string | null;
  dryRun?: boolean;
};

export type SupervisorActionInspectOptions = {
  actionId?: string | null;
};

export type SupervisorActionApplication = {
  at: string;
  planAt: string;
  readOnly: false;
  dryRun: boolean;
  applied: boolean;
  requiredConfirmation: string;
  action: SupervisorAction;
  application: {
    type: "job_recovery";
    result: JobRecoveryResult | null;
  };
};

export async function runSupervisor(options: SupervisorRunOptions): Promise<SupervisorState> {
  const dir = supervisorDir(process.cwd());
  await mkdir(dir, { recursive: true });
  const previousState = await readSupervisorStateIfExists(dir);
  let stopRequested = false;
  const requestStop = () => {
    stopRequested = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const state: SupervisorState = {
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    supervisorId: options.supervisorId ?? null,
    tickCount: previousState?.tickCount ?? 0,
    lastTick: previousState?.lastTick ?? null,
  };
  let previousTick: SupervisorTick | null = null;
  let runTickCount = 0;
  await writeSupervisorState(dir, state);
  await appendSupervisorEvent(dir, { type: "supervisor.started", pid: process.pid, intervalMs: options.intervalMs });

  try {
    while (!stopRequested) {
      const tick = await supervisorTick(previousTick);
      state.tickCount++;
      runTickCount++;
      state.lastTick = tick;
      previousTick = tick;
      state.updatedAt = tick.at;
      await writeSupervisorState(dir, state);
      await appendSupervisorEvent(dir, { type: "supervisor.tick", tick });

      if (options.once || (options.maxTicks !== undefined && runTickCount >= options.maxTicks)) {
        break;
      }
      await sleepUntilStop(options.intervalMs, () => stopRequested);
    }
    state.status = "stopped";
    state.updatedAt = new Date().toISOString();
    await writeSupervisorState(dir, state);
    await appendSupervisorEvent(dir, { type: "supervisor.stopped", pid: process.pid, tickCount: state.tickCount });
    return state;
  } catch (error) {
    state.status = "stopped";
    state.updatedAt = new Date().toISOString();
    await writeSupervisorState(dir, state);
    await appendSupervisorEvent(dir, {
      type: "supervisor.failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}

export async function startSupervisor(options: SupervisorStartOptions): Promise<SupervisorStartResult> {
  const dir = supervisorDir(process.cwd());
  await mkdir(dir, { recursive: true });
  return await withSupervisorLifecycleLock(dir, async () => {
    const existing = await readSupervisorStateIfExists(dir);
    if (existing?.status === "running" && existing.pid !== null) {
      const identity = await supervisorProcessIdentity(existing);
      if (identity === "match") {
        return {
          action: "already_running",
          pid: existing.pid,
          intervalMs: options.intervalMs,
          maxTicks: options.maxTicks ?? null,
          state: existing,
          logPath: join(dir, "supervisor.log"),
          errorLogPath: join(dir, "supervisor.err.log"),
        };
      }
      if (identity === "unknown") {
        throw unverifiedSupervisorIdentityError(existing);
      }
      await markStaleSupervisorState(dir, existing, identity);
    }

    const supervisorId = randomUUID();
    const cmd = [
      process.execPath,
      import.meta.resolveSync("./cli.ts"),
      "internal",
      "supervisor",
      "--interval-ms",
      String(options.intervalMs),
      "--supervisor-id",
      supervisorId,
    ];
    if (options.maxTicks !== undefined) {
      cmd.push("--max-ticks", String(options.maxTicks));
    }
    const proc = Bun.spawn({
      cmd,
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: Bun.file(join(dir, "supervisor.log")),
      stderr: Bun.file(join(dir, "supervisor.err.log")),
      detached: true,
    });
    proc.unref();
    const state = await waitForSupervisorLaunchState(dir, proc.pid, supervisorId, START_STATE_WAIT_MS)
      ?? await writeFallbackLaunchState(dir, proc.pid, supervisorId);
    return {
      action: "started",
      pid: proc.pid,
      intervalMs: options.intervalMs,
      maxTicks: options.maxTicks ?? null,
      state,
      logPath: join(dir, "supervisor.log"),
      errorLogPath: join(dir, "supervisor.err.log"),
    };
  });
}

export async function stopSupervisor(options: SupervisorStopOptions = {}): Promise<SupervisorStopResult> {
  const dir = supervisorDir(process.cwd());
  await mkdir(dir, { recursive: true });
  return await withSupervisorLifecycleLock(dir, async () => {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const startedAt = Date.now();
    const state = await readSupervisorStateIfExists(dir);
    if (!state || state.status !== "running" || state.pid === null) {
      return {
        action: "already_stopped",
        pid: state?.pid ?? null,
        signal: null,
        waitedMs: 0,
        state,
      };
    }
    const identity = await supervisorProcessIdentity(state);
    if (identity === "unknown") {
      throw unverifiedSupervisorIdentityError(state);
    }
    if (identity !== "match") {
      const stopped = await markStaleSupervisorState(dir, state, identity);
      return {
        action: "stale_state",
        pid: state.pid,
        signal: null,
        waitedMs: 0,
        state: stopped,
      };
    }

    try {
      process.kill(state.pid, "SIGTERM");
    } catch (error) {
      if (isErrorWithCode(error) && error.code === "ESRCH") {
        const stopped = await markStaleSupervisorState(dir, state, "dead");
        return {
          action: "stale_state",
          pid: state.pid,
          signal: null,
          waitedMs: Math.max(0, Date.now() - startedAt),
          state: stopped,
        };
      }
      throw error;
    }
    let latest: SupervisorState | null = state;
    while (Date.now() - startedAt < timeoutMs) {
      await Bun.sleep(50);
      latest = await readSupervisorStateIfExists(dir);
      if (latest?.status !== "running" || !isProcessAlive(state.pid)) break;
    }
    return {
      action: "stop_requested",
      pid: state.pid,
      signal: "SIGTERM",
      waitedMs: Math.max(0, Date.now() - startedAt),
      state: latest,
    };
  });
}

export async function readSupervisorState(): Promise<SupervisorState> {
  const state = await Bun.file(join(supervisorDir(process.cwd()), "state.json")).json() as SupervisorState;
  return normalizeSupervisorState(state);
}

export async function readSupervisorEvents(): Promise<unknown[]> {
  const file = Bun.file(join(supervisorDir(process.cwd()), "events.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export async function readSupervisorActionHistory(tickLimit = 10): Promise<SupervisorActionHistory> {
  const { eventsScanned, ticks } = await readRecentSupervisorActionTicks(supervisorDir(process.cwd()), tickLimit);
  const latest = ticks.at(-1) ?? null;
  return {
    at: new Date().toISOString(),
    tickLimit,
    eventsScanned,
    tickCount: ticks.length,
    latestTickAt: latest?.tickAt ?? null,
    latestActions: latest?.actions ?? [],
    ticks,
  };
}

export async function waitForSupervisor(options: SupervisorWaitOptions = {}): Promise<SupervisorWaitResult> {
  const dir = supervisorDir(process.cwd());
  const afterTick = options.afterTick ?? 0;
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? null;
  const startedAt = Date.now();
  const deadline = timeoutMs === null ? null : startedAt + timeoutMs;

  while (true) {
    const state = await readSupervisorStateIfExists(dir);
    const rawActions = state?.lastTick?.actions ?? [];
    const actions = state !== null && state.tickCount > afterTick ? rawActions : [];
    const now = Date.now();
    if (await supervisorWaitStateIsStale(state)) {
      return supervisorWaitResult(state, [], true, "stale", startedAt, now, intervalMs, afterTick, timeoutMs, deadline);
    }
    const reason = supervisorWaitReadyReason(state, actions, afterTick);
    if (reason) {
      return supervisorWaitResult(state, actions, true, reason, startedAt, now, intervalMs, afterTick, timeoutMs, deadline);
    }
    if (deadline !== null && now >= deadline) {
      return supervisorWaitResult(state, actions, false, "timeout", startedAt, now, intervalMs, afterTick, timeoutMs, deadline);
    }
    const sleepMs = deadline === null ? intervalMs : Math.max(0, Math.min(intervalMs, deadline - now));
    await Bun.sleep(sleepMs);
  }
}

export async function nextSupervisorAction(options: SupervisorNextOptions = {}): Promise<SupervisorNextResult> {
  const inbox = await readSupervisorInbox({ ...options, limit: 1 });
  const item = inbox.items[0] ?? null;
  return {
    at: inbox.at,
    start: inbox.start,
    wait: inbox.wait,
    action: item?.action ?? null,
    inspection: item?.inspection ?? null,
  };
}

export async function readSupervisorInbox(options: SupervisorInboxOptions = {}): Promise<SupervisorInboxResult> {
  const previousState = await readSupervisorStateIfExists(supervisorDir(process.cwd()));
  const start = await startSupervisor({
    intervalMs: options.startIntervalMs ?? options.intervalMs ?? 1000,
    maxTicks: options.startMaxTicks,
  });
  const afterTick = options.afterTick ?? previousState?.tickCount ?? 0;
  const wait = await waitForSupervisor({
    afterTick,
    intervalMs: options.intervalMs,
    timeoutMs: options.timeoutMs,
  });
  const at = new Date().toISOString();
  const actions = sortSupervisorActions(wait.actions).slice(0, options.limit ?? wait.actions.length);
  return {
    at,
    start,
    wait,
    items: await Promise.all(actions.map(async (action) => ({
      action,
      inspection: await inspectWaitAction(action, wait, at),
    }))),
  };
}

async function readRecentSupervisorActionTicks(
  dir: string,
  tickLimit: number,
): Promise<{ eventsScanned: number; ticks: SupervisorActionHistoryTick[] }> {
  if (tickLimit <= 0) return { eventsScanned: 0, ticks: [] };
  const path = join(dir, "events.jsonl");
  if (!(await Bun.file(path).exists())) return { eventsScanned: 0, ticks: [] };

  const file = await open(path, "r");
  const ticks: SupervisorActionHistoryTick[] = [];
  let eventsScanned = 0;
  let remainder = Buffer.alloc(0);
  try {
    const stat = await file.stat();
    let position = stat.size;
    while (position > 0 && ticks.length < tickLimit) {
      const readSize = Math.min(HISTORY_READ_CHUNK_BYTES, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      const { bytesRead } = await file.read(chunk, 0, readSize, position);
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), remainder]);
      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(index + 1, end).toString("utf8");
        const tick = parseSupervisorActionTickLine(line);
        if (line.trim().length > 0) eventsScanned++;
        if (tick) ticks.unshift(tick);
        end = index;
        if (ticks.length >= tickLimit) break;
      }
      remainder = combined.subarray(0, end);
    }

    if (position === 0 && ticks.length < tickLimit && remainder.length > 0) {
      const line = remainder.toString("utf8");
      const tick = parseSupervisorActionTickLine(line);
      if (line.trim().length > 0) eventsScanned++;
      if (tick) ticks.unshift(tick);
    }
  } finally {
    await file.close();
  }

  return { eventsScanned, ticks };
}

function parseSupervisorActionTickLine(line: string): SupervisorActionHistoryTick | null {
  if (line.trim().length === 0) return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isSupervisorTickEvent(event)) return null;
  return {
    eventAt: typeof event.at === "string" ? event.at : null,
    tickAt: event.tick.at,
    health: event.tick.health,
    actions: event.tick.actions.map(normalizeSupervisorAction),
  };
}

function supervisorWaitReadyReason(
  state: SupervisorState | null,
  actions: SupervisorAction[],
  afterTick: number,
): SupervisorWaitResult["reason"] | null {
  const hasFreshTick = state !== null && state.tickCount > afterTick;
  if (actions.length > 0) return "actions";
  if (state?.status === "running" && !isProcessAlive(state.pid)) return "stale";
  if (hasFreshTick) return "tick";
  if (state?.status === "stopped") return "stopped";
  return null;
}

async function supervisorWaitStateIsStale(state: SupervisorState | null): Promise<boolean> {
  if (state?.status !== "running") return false;
  const identity = await supervisorProcessIdentity(state);
  return identity === "dead" || identity === "mismatch";
}

function supervisorWaitResult(
  state: SupervisorState | null,
  actions: SupervisorAction[],
  ready: boolean,
  reason: SupervisorWaitResult["reason"],
  startedAt: number,
  now: number,
  intervalMs: number,
  afterTick: number,
  timeoutMs: number | null,
  deadline: number | null,
): SupervisorWaitResult {
  return {
    ready,
    reason,
    elapsedMs: Math.max(0, now - startedAt),
    intervalMs,
    afterTick,
    timeoutMs,
    deadlineAt: deadline === null ? null : new Date(deadline).toISOString(),
    state,
    actions,
  };
}

async function inspectWaitAction(
  action: SupervisorAction,
  wait: SupervisorWaitResult,
  at: string,
): Promise<SupervisorActionInspection> {
  return {
    at,
    planAt: wait.state?.lastTick?.at ?? at,
    readOnly: true,
    action,
    inspection: await inspectActionPayload(action),
  };
}

function sortSupervisorActions(actions: SupervisorAction[]): SupervisorAction[] {
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) =>
      severityRank(right.action.severity) - severityRank(left.action.severity)
      || left.index - right.index
    )
    .map((entry) => entry.action);
}

function severityRank(severity: SupervisorAction["severity"]): number {
  if (severity === "critical") return 3;
  if (severity === "attention") return 2;
  return 1;
}

export async function planSupervisorActions(): Promise<{ at: string; health: SupervisorHealthSummary; actions: SupervisorAction[] }> {
  const jobs = await listJobs();
  const at = new Date().toISOString();
  return {
    at,
    health: summarizeJobHealth(jobs),
    actions: annotatePolicyRecommendations(planJobActions(jobs)),
  };
}

export async function inspectSupervisorAction(
  jobKey: string,
  kind: SupervisorActionKind,
  options: SupervisorActionInspectOptions = {},
): Promise<SupervisorActionInspection> {
  const plan = await planSupervisorActions();
  const action = requireCurrentAction(plan, jobKey, kind, options.actionId);
  return {
    at: new Date().toISOString(),
    planAt: plan.at,
    readOnly: true,
    action,
    inspection: await inspectActionPayload(action),
  };
}

export async function applySupervisorAction(
  jobKey: string,
  kind: SupervisorActionKind,
  options: SupervisorActionApplyOptions = {},
): Promise<SupervisorActionApplication> {
  const plan = await planSupervisorActions();
  const action = requireCurrentAction(plan, jobKey, kind, options.actionId);
  if (action.kind !== "inspect_dead_worker") {
    throw new SupervisorOperationError(
      "supervisor_action_not_applicable",
      `Supervisor action '${kind}' for job '${jobKey}' has no mutating apply operation`,
    );
  }
  const dryRun = options.dryRun ?? false;
  if (!dryRun && options.confirm !== RECOVER_DEAD_WORKER_CONFIRMATION) {
    throw new SupervisorOperationError(
      "supervisor_confirmation_required",
      `Applying '${kind}' for job '${jobKey}' requires --confirm ${RECOVER_DEAD_WORKER_CONFIRMATION}`,
    );
  }
  return {
    at: new Date().toISOString(),
    planAt: plan.at,
    readOnly: false,
    dryRun,
    applied: !dryRun,
    requiredConfirmation: RECOVER_DEAD_WORKER_CONFIRMATION,
    action,
    application: {
      type: "job_recovery",
      result: dryRun ? null : await recoverJob(jobKey, {
        expectedRecoveryStateId: deadWorkerRecoveryStateId(action),
      }),
    },
  };
}

function requireCurrentAction(
  plan: { actions: SupervisorAction[] },
  jobKey: string,
  kind: SupervisorActionKind,
  actionId?: string | null,
): SupervisorAction {
  const action = plan.actions.find((candidate) =>
    candidate.jobKey === jobKey
    && candidate.kind === kind
    && (actionId === undefined || actionId === null || candidate.id === actionId)
  );
  if (!action) {
    const idClause = actionId ? ` with id '${actionId}'` : "";
    throw new SupervisorOperationError(
      "supervisor_action_not_found",
      `No supervisor action '${kind}' for job '${jobKey}'${idClause}`,
    );
  }
  return action;
}

async function inspectActionPayload(action: SupervisorAction): Promise<SupervisorActionInspectionPayload> {
  if (action.kind === "resolve_approval") {
    return {
      type: "approval_list",
      approvals: await readApprovals(action.jobKey, false),
    };
  }
  if (action.kind === "inspect_unreadable") {
    return {
      type: "unreadable_job",
      error: action.reason,
    };
  }
  const eventLimit = action.kind === "wait_cancel" ? 0 : 20;
  return {
    type: "job_summary",
    eventLimit,
    summary: await readJobSummary(action.jobKey, eventLimit),
  };
}

async function supervisorTick(previousTick: SupervisorTick | null): Promise<SupervisorTick> {
  const reconciliation = await reconcileJobs();
  const recovered = reconciliation.items.flatMap((item) => item.result ? [item.result] : []);
  const jobs = await listJobs();
  const at = new Date().toISOString();
  return {
    at,
    health: summarizeJobHealth(jobs),
    actions: annotatePolicyRecommendations(annotateActionPersistence(planJobActions(jobs), previousTick)),
    recovered,
    reconciliation,
  };
}

function summarizeJobHealth(jobs: JobListItem[]): SupervisorHealthSummary {
  const summary: SupervisorHealthSummary = {
    total: jobs.length,
    unreadable: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    staleWorkers: 0,
    deadWorkers: 0,
    pendingApprovals: 0,
    actionableApprovals: 0,
    waitingCancel: 0,
    inspectError: 0,
  };

  for (const job of jobs) {
    if (job.status === "unreadable") {
      summary.unreadable++;
    } else {
      summary[job.status]++;
    }
    if (job.workerHealth?.stale) summary.staleWorkers++;
    if (job.workerHealth && !job.workerHealth.alive && job.status === "running") summary.deadWorkers++;
    summary.pendingApprovals += job.pendingApprovals;
    summary.actionableApprovals += job.actionableApprovals;
    if (job.nextAction === "wait_cancel") summary.waitingCancel++;
    if (job.nextAction === "inspect_error") summary.inspectError++;
  }

  return summary;
}

function planJobActions(jobs: JobListItem[]): SupervisorAction[] {
  const actions: SupervisorAction[] = [];
  for (const job of jobs) {
    if (job.status === "unreadable") {
      actions.push({
        id: supervisorActionId({
          jobKey: job.key,
          kind: "inspect_unreadable",
          reason: job.error ?? "job record is unreadable",
        }),
        jobKey: job.key,
        kind: "inspect_unreadable",
        severity: "critical",
        reason: job.error ?? "job record is unreadable",
        nextCommand: `codexctl job result ${job.key} --json`,
      });
      continue;
    }

    if (job.nextAction === "resolve_approval") {
      actions.push({
        id: supervisorActionId({
          jobKey: job.key,
          kind: "resolve_approval",
          reason: `${job.actionableApprovals} approval request(s) can be resolved`,
        }),
        jobKey: job.key,
        kind: "resolve_approval",
        severity: "attention",
        reason: `${job.actionableApprovals} approval request(s) can be resolved`,
        nextCommand: `codexctl approval list ${job.key} --json`,
      });
    }

    if (job.nextAction === "wait_cancel") {
      const cancelAgeMs = ageSince(job.cancelRequestedAt);
      const severity = severityForAge(cancelAgeMs, WAIT_CANCEL_ATTENTION_MS, WAIT_CANCEL_CRITICAL_MS);
      actions.push({
        id: supervisorActionId({
          jobKey: job.key,
          kind: "wait_cancel",
          reason: `turn interrupt is queued${ageText(cancelAgeMs)}${job.cancelRequestedAt ? ` since ${job.cancelRequestedAt}` : ""}`,
        }),
        jobKey: job.key,
        kind: "wait_cancel",
        severity,
        reason: `turn interrupt is queued${ageText(cancelAgeMs)}${job.cancelRequestedAt ? ` since ${job.cancelRequestedAt}` : ""}`,
        nextCommand: `codexctl job summary ${job.key} --events 0 --json`,
        ageMs: cancelAgeMs,
        thresholdMs: thresholdForSeverity(severity, WAIT_CANCEL_ATTENTION_MS, WAIT_CANCEL_CRITICAL_MS),
      });
    }

    if (job.nextAction === "inspect_error") {
      actions.push({
        id: supervisorActionId({
          jobKey: job.key,
          kind: "inspect_error",
          reason: job.error ?? "job failed",
        }),
        jobKey: job.key,
        kind: "inspect_error",
        severity: "critical",
        reason: job.error ?? "job failed",
        nextCommand: `codexctl job summary ${job.key} --events 20 --json`,
      });
    }

    if (job.status === "running" && job.workerHealth?.reason === "alive_stale") {
      const heartbeatAgeMs = job.workerHealth.heartbeatAgeMs;
      const severity = heartbeatAgeMs !== null && heartbeatAgeMs >= STALE_WORKER_CRITICAL_MS ? "critical" : "attention";
      actions.push({
        id: supervisorActionId({
          jobKey: job.key,
          kind: "inspect_stale_worker",
          reason: `worker heartbeat is stale${ageText(heartbeatAgeMs)}`,
        }),
        jobKey: job.key,
        kind: "inspect_stale_worker",
        severity,
        reason: `worker heartbeat is stale${ageText(heartbeatAgeMs)}`,
        nextCommand: `codexctl job summary ${job.key} --events 20 --json`,
        ageMs: heartbeatAgeMs,
        thresholdMs: STALE_WORKER_CRITICAL_MS,
      });
    }

    if (job.status === "running" && job.workerHealth && !job.workerHealth.alive) {
      actions.push({
        id: supervisorActionId({
          jobKey: job.key,
          kind: "inspect_dead_worker",
          reason: `worker is not alive (${job.workerHealth.reason})${ageText(job.workerHealth.heartbeatAgeMs)}`,
          identity: jobRecoveryStateId(job),
        }),
        jobKey: job.key,
        kind: "inspect_dead_worker",
        severity: "critical",
        reason: `worker is not alive (${job.workerHealth.reason})${ageText(job.workerHealth.heartbeatAgeMs)}`,
        nextCommand: `codexctl job summary ${job.key} --events 20 --json`,
        ageMs: job.workerHealth.heartbeatAgeMs,
      });
    }
  }
  return actions;
}

function ageSince(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Date.now() - parsed);
}

function severityForAge(
  ageMs: number | null,
  attentionMs: number,
  criticalMs: number,
): SupervisorAction["severity"] {
  if (ageMs === null) return "info";
  if (ageMs >= criticalMs) return "critical";
  if (ageMs >= attentionMs) return "attention";
  return "info";
}

function thresholdForSeverity(
  severity: SupervisorAction["severity"],
  attentionMs: number,
  criticalMs: number,
): number {
  return severity === "critical" ? criticalMs : attentionMs;
}

function ageText(ageMs: number | null): string {
  return ageMs === null ? "" : ` for ${ageMs}ms`;
}

function annotateActionPersistence(
  actions: SupervisorAction[],
  previousTick: SupervisorTick | null,
): SupervisorAction[] {
  if (actions.length === 0 || previousTick === null) return actions;
  const previousActions = new Map<string, SupervisorAction>();
  for (const action of previousTick?.actions ?? []) {
    const key = persistenceKey(action);
    if (key !== null) previousActions.set(key, action);
  }
  return actions.map((action) => {
    const key = persistenceKey(action);
    const previous = key === null ? undefined : previousActions.get(key);
    if (!previous) return action;
    return {
      ...action,
      firstSeenAt: previous.firstSeenAt ?? previousTick.at,
      seenTicks: previous ? (previous.seenTicks ?? 1) + 1 : 1,
      ...criticalPersistence(action, previous),
    };
  });
}

function persistenceKey(action: SupervisorAction): string | null {
  if (action.kind === "resolve_approval") return null;
  return action.id;
}

function deadWorkerRecoveryStateId(action: SupervisorAction): string | null {
  if (action.kind !== "inspect_dead_worker") return null;
  const prefix = `${action.jobKey}:${action.kind}:`;
  if (!action.id.startsWith(prefix)) return null;
  return action.id.slice(prefix.length);
}

function normalizeSupervisorAction(action: SupervisorAction): SupervisorAction {
  if (typeof action.id === "string" && action.id.length > 0) return action;
  return { ...action, id: supervisorActionId(action) };
}

function supervisorActionId(
  action: Pick<SupervisorAction, "jobKey" | "kind" | "reason"> & { identity?: string | null },
): string {
  const base = `${action.jobKey}:${action.kind}`;
  if (action.kind === "inspect_error" || action.kind === "inspect_unreadable") {
    return `${base}:${shortStableHash(action.reason)}`;
  }
  if (action.kind === "inspect_dead_worker") {
    return `${base}:${action.identity ?? shortStableHash(action.reason)}`;
  }
  return base;
}

function shortStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function annotatePolicyRecommendations(actions: SupervisorAction[]): SupervisorAction[] {
  return actions.map((action) => {
    const policy = policyRecommendation(action);
    return policy ? { ...action, policy } : action;
  });
}

function policyRecommendation(action: SupervisorAction): SupervisorPolicyRecommendation | null {
  const criticalSeenTicks = action.criticalSeenTicks ?? 0;
  const isCriticalPersistent = criticalSeenTicks >= POLICY_PERSISTENCE_TICKS;
  const isCritical = action.severity === "critical";
  if (isCritical && isCriticalPersistent) {
    return {
      recommendation: "escalate",
      reason: `critical recommendation persisted for ${criticalSeenTicks} critical ticks`,
      basedOn: ["severity", "persistence"],
      thresholdTicks: POLICY_PERSISTENCE_TICKS,
    };
  }
  if (isCritical) {
    return {
      recommendation: "inspect",
      reason: "critical recommendation",
      basedOn: ["severity"],
    };
  }
  return null;
}

function criticalPersistence(
  action: SupervisorAction,
  previous: SupervisorAction,
): Pick<SupervisorAction, "criticalSeenTicks"> {
  if (action.severity !== "critical") return {};
  if (previous.severity !== "critical") return { criticalSeenTicks: 1 };
  return { criticalSeenTicks: (previous.criticalSeenTicks ?? 1) + 1 };
}

function isSupervisorTickEvent(event: unknown): event is { type: "supervisor.tick"; at?: unknown; tick: SupervisorTick } {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as { type?: unknown; tick?: unknown };
  if (candidate.type !== "supervisor.tick") return false;
  if (typeof candidate.tick !== "object" || candidate.tick === null) return false;
  const tick = candidate.tick as Partial<SupervisorTick>;
  return typeof tick.at === "string"
    && Array.isArray(tick.actions)
    && typeof tick.health === "object"
    && tick.health !== null;
}

async function writeSupervisorState(dir: string, state: SupervisorState): Promise<void> {
  await writeJsonFileAtomic(join(dir, "state.json"), state);
}

async function withSupervisorLifecycleLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lockDir = join(dir, "lifecycle.lock");
  for (let attempt = 0; attempt < SUPERVISOR_LOCK_ATTEMPTS; attempt++) {
    let acquired = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      await mkdir(lockDir);
      acquired = true;
      const ownerToken = randomUUID();
      const createdAt = new Date().toISOString();
      await writeSupervisorLifecycleLockOwner(lockDir, {
        token: ownerToken,
        pid: process.pid,
        createdAt,
        heartbeatAt: createdAt,
      });
      acquired = false;
      heartbeat = setInterval(() => {
        void writeSupervisorLifecycleLockOwner(lockDir, {
          token: ownerToken,
          pid: process.pid,
          createdAt,
          heartbeatAt: new Date().toISOString(),
        }).catch(() => {});
      }, Math.max(1_000, Math.floor(SUPERVISOR_LOCK_STALE_MS / 3)));
      try {
        return await work();
      } finally {
        if (heartbeat !== null) clearInterval(heartbeat);
        await releaseSupervisorLifecycleLock(lockDir, ownerToken);
      }
    } catch (error) {
      if (acquired) {
        await rm(lockDir, { recursive: true, force: true });
      }
      if (!isErrorWithCode(error) || error.code !== "EEXIST") throw error;
      if (await breakStaleSupervisorLifecycleLock(lockDir)) continue;
      await Bun.sleep(SUPERVISOR_LOCK_RETRY_MS);
    }
  }
  throw new SupervisorOperationError("supervisor_locked", "Supervisor lifecycle state is locked by another writer");
}

type SupervisorLifecycleLockOwner = {
  token: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
};

async function writeSupervisorLifecycleLockOwner(lockDir: string, owner: SupervisorLifecycleLockOwner): Promise<void> {
  await writeJsonFileAtomic(join(lockDir, "owner.json"), owner);
}

async function breakStaleSupervisorLifecycleLock(lockDir: string): Promise<boolean> {
  try {
    const ownerText = await Bun.file(join(lockDir, "owner.json")).text();
    const owner = JSON.parse(ownerText) as unknown;
    if (!isObject(owner)) return await breakStaleSupervisorLifecycleLockByMtime(lockDir, ownerText);
    const token = typeof owner.token === "string" ? owner.token : null;
    const pid = typeof owner.pid === "number" ? owner.pid : null;
    const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
    const heartbeatAt = typeof owner.heartbeatAt === "string" ? Date.parse(owner.heartbeatAt) : createdAt;
    if (token === null || pid === null || !Number.isFinite(heartbeatAt)) return await breakStaleSupervisorLifecycleLockByMtime(lockDir, ownerText);
    if (!isProcessAlive(pid) || Date.now() - heartbeatAt > SUPERVISOR_LOCK_STALE_MS) {
      if (!await supervisorLifecycleLockTokenStillMatches(lockDir, token)) return false;
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return await breakStaleSupervisorLifecycleLockByMtime(lockDir, null);
  }
  return false;
}

async function breakStaleSupervisorLifecycleLockByMtime(lockDir: string, expectedOwnerText: string | null): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > SUPERVISOR_LOCK_STALE_MS) {
      if (expectedOwnerText !== null && !await supervisorLifecycleLockOwnerTextStillMatches(lockDir, expectedOwnerText)) return false;
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function supervisorLifecycleLockTokenStillMatches(lockDir: string, expectedToken: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await Bun.file(join(lockDir, "owner.json")).text()) as unknown;
    return isObject(owner) && owner.token === expectedToken;
  } catch {
    return false;
  }
}

async function supervisorLifecycleLockOwnerTextStillMatches(lockDir: string, expectedOwnerText: string): Promise<boolean> {
  try {
    return await Bun.file(join(lockDir, "owner.json")).text() === expectedOwnerText;
  } catch {
    return false;
  }
}

async function releaseSupervisorLifecycleLock(lockDir: string, expectedToken: string): Promise<void> {
  if (await supervisorLifecycleLockTokenStillMatches(lockDir, expectedToken)) {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function readSupervisorStateIfExists(dir: string): Promise<SupervisorState | null> {
  const file = Bun.file(join(dir, "state.json"));
  if (!(await file.exists())) return null;
  return normalizeSupervisorState(await file.json() as SupervisorState);
}

function normalizeSupervisorState(state: SupervisorState): SupervisorState {
  const normalized = state as SupervisorState & { supervisorId?: string | null };
  if (normalized.supervisorId === undefined) {
    normalized.supervisorId = null;
  }
  const lastTick = state.lastTick;
  if (lastTick !== null && typeof lastTick === "object" && !("reconciliation" in lastTick)) {
    state.lastTick = Object.assign({}, lastTick, { reconciliation: null }) as SupervisorTick;
  }
  return state;
}

async function waitForSupervisorLaunchState(
  dir: string,
  pid: number,
  supervisorId: string,
  timeoutMs: number,
): Promise<SupervisorState | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readSupervisorStateIfExists(dir);
    if (stateBelongsToLaunch(state, pid, supervisorId)) return state;
    if (!isProcessAlive(pid)) break;
    await Bun.sleep(25);
  }
  return null;
}

async function writeFallbackLaunchState(dir: string, pid: number, supervisorId: string): Promise<SupervisorState> {
  const now = new Date().toISOString();
  const previousState = await readSupervisorStateIfExists(dir);
  const state: SupervisorState = {
    status: isProcessAlive(pid) ? "running" : "stopped",
    startedAt: now,
    updatedAt: now,
    pid,
    supervisorId,
    tickCount: previousState?.tickCount ?? 0,
    lastTick: previousState?.lastTick ?? null,
  };
  await writeSupervisorState(dir, state);
  await appendSupervisorEvent(dir, {
    type: "supervisor.launch_state_fallback",
    pid,
    supervisorId,
    status: state.status,
  });
  return state;
}

function stateBelongsToLaunch(state: SupervisorState | null, pid: number, supervisorId: string): state is SupervisorState {
  return state?.pid === pid && state.supervisorId === supervisorId;
}

async function markStaleSupervisorState(
  dir: string,
  state: SupervisorState,
  reason: SupervisorProcessIdentity,
): Promise<SupervisorState> {
  const stopped = { ...state, status: "stopped" as const, updatedAt: new Date().toISOString(), pid: null };
  await writeSupervisorState(dir, stopped);
  await appendSupervisorEvent(dir, { type: "supervisor.stale_state", pid: state.pid, supervisorId: state.supervisorId, reason });
  return stopped;
}

function unverifiedSupervisorIdentityError(state: SupervisorState): SupervisorOperationError {
  return new SupervisorOperationError(
    "supervisor_identity_unverified",
    `Recorded supervisor pid ${state.pid ?? "unknown"} is alive but cannot be verified; refusing to spawn another supervisor or mark it stopped`,
  );
}

type SupervisorProcessIdentity = "match" | "dead" | "mismatch" | "unknown";

async function supervisorProcessIdentity(state: SupervisorState): Promise<SupervisorProcessIdentity> {
  if (state.pid === null || !isProcessAlive(state.pid)) return "dead";
  if (state.supervisorId === null) return "unknown";
  const args = await readProcessArgs(state.pid);
  if (args !== null && supervisorArgsMatch(args, state.supervisorId)) {
    return "match";
  }
  if (args !== null) return "mismatch";
  const command = await readProcessCommand(state.pid);
  if (command === null) return "unknown";
  if (supervisorCommandMatches(command, state.supervisorId)) return "match";
  return "mismatch";
}

async function readProcessArgs(pid: number): Promise<string[] | null> {
  try {
    const bytes = await readFile(`/proc/${pid}/cmdline`);
    return bytes
      .toString("utf8")
      .split("\0")
      .filter((arg) => arg.length > 0);
  } catch {
    return null;
  }
}

function hasFlagValue(args: string[], name: string, value: string): boolean {
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === name && args[index + 1] === value) return true;
  }
  return false;
}

function supervisorArgsMatch(args: string[], supervisorId: string): boolean {
  return args.includes("internal")
    && args.includes("supervisor")
    && hasFlagValue(args, "--supervisor-id", supervisorId);
}

async function readProcessCommand(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const command = stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

function supervisorCommandMatches(command: string, supervisorId: string): boolean {
  return command.includes(" internal supervisor ")
    && (
      command.includes(` --supervisor-id ${supervisorId}`)
      || command.includes(` --supervisor-id=${supervisorId}`)
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string";
}

async function sleepUntilStop(intervalMs: number, stopped: () => boolean): Promise<void> {
  let remainingMs = intervalMs;
  while (!stopped() && remainingMs > 0) {
    const sleepMs = Math.min(50, remainingMs);
    await Bun.sleep(sleepMs);
    remainingMs -= sleepMs;
  }
}

async function appendSupervisorEvent(dir: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(dir, "events.jsonl"), JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await Bun.write(tempPath, JSON.stringify(value, null, 2) + "\n");
  await rename(tempPath, path);
}

function supervisorDir(root: string): string {
  return join(root, ".codexctl", "supervisor");
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM") {
      return true;
    }
    return false;
  }
}
