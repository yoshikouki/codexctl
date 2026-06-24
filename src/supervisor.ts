import { Buffer } from "node:buffer";
import { appendFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  listJobs,
  readApprovals,
  readJobSummary,
  recoverJob,
  sweepJobs,
  type ApprovalRecord,
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

export type SupervisorTick = {
  at: string;
  health: SupervisorHealthSummary;
  actions: SupervisorAction[];
  recovered: JobRecoveryResult[];
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
    readonly code: "supervisor_action_not_found" | "supervisor_action_not_applicable" | "supervisor_confirmation_required",
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
  tickCount: number;
  lastTick: SupervisorTick | null;
};

export type SupervisorRunOptions = {
  intervalMs: number;
  once?: boolean;
  maxTicks?: number;
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
  confirm?: string | null;
  dryRun?: boolean;
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
    tickCount: 0,
    lastTick: null,
  };
  let previousTick: SupervisorTick | null = null;
  await writeSupervisorState(dir, state);
  await appendSupervisorEvent(dir, { type: "supervisor.started", pid: process.pid, intervalMs: options.intervalMs });

  try {
    while (!stopRequested) {
      const tick = await supervisorTick(previousTick);
      state.tickCount++;
      state.lastTick = tick;
      previousTick = tick;
      state.updatedAt = tick.at;
      await writeSupervisorState(dir, state);
      await appendSupervisorEvent(dir, { type: "supervisor.tick", tick });

      if (options.once || (options.maxTicks !== undefined && state.tickCount >= options.maxTicks)) {
        break;
      }
      await Bun.sleep(options.intervalMs);
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

export async function readSupervisorState(): Promise<SupervisorState> {
  return await Bun.file(join(supervisorDir(process.cwd()), "state.json")).json() as SupervisorState;
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
    actions: event.tick.actions,
  };
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
): Promise<SupervisorActionInspection> {
  const plan = await planSupervisorActions();
  const action = requireCurrentAction(plan, jobKey, kind);
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
  const action = requireCurrentAction(plan, jobKey, kind);
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
      result: dryRun ? null : await recoverJob(jobKey),
    },
  };
}

function requireCurrentAction(
  plan: { actions: SupervisorAction[] },
  jobKey: string,
  kind: SupervisorActionKind,
): SupervisorAction {
  const action = plan.actions.find((candidate) => candidate.jobKey === jobKey && candidate.kind === kind);
  if (!action) {
    throw new SupervisorOperationError(
      "supervisor_action_not_found",
      `No supervisor action '${kind}' for job '${jobKey}'`,
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
  const recovered = await sweepJobs();
  const jobs = await listJobs();
  const at = new Date().toISOString();
  return {
    at,
    health: summarizeJobHealth(jobs),
    actions: annotatePolicyRecommendations(annotateActionPersistence(planJobActions(jobs), previousTick)),
    recovered,
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
  if (action.kind === "wait_cancel") return `${action.jobKey}\u0000${action.kind}`;
  if (action.kind === "inspect_error" || action.kind === "inspect_unreadable") {
    return `${action.jobKey}\u0000${action.kind}\u0000${action.reason}`;
  }
  return `${action.jobKey}\u0000${action.kind}`;
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
  await Bun.write(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function appendSupervisorEvent(dir: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(dir, "events.jsonl"), JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

function supervisorDir(root: string): string {
  return join(root, ".codexctl", "supervisor");
}
