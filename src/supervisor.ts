import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listJobs, sweepJobs, type JobListItem, type JobRecoveryResult } from "./job.ts";

const WAIT_CANCEL_ATTENTION_MS = 60_000;
const WAIT_CANCEL_CRITICAL_MS = 5 * 60_000;
const STALE_WORKER_CRITICAL_MS = 5 * 60_000;

export type SupervisorTick = {
  at: string;
  health: SupervisorHealthSummary;
  actions: SupervisorAction[];
  recovered: JobRecoveryResult[];
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

export type SupervisorAction = {
  jobKey: string;
  kind: "resolve_approval" | "wait_cancel" | "inspect_error" | "inspect_stale_worker" | "inspect_dead_worker" | "inspect_unreadable";
  severity: "info" | "attention" | "critical";
  reason: string;
  nextCommand: string;
  ageMs?: number | null;
  thresholdMs?: number | null;
  firstSeenAt?: string;
  seenTicks?: number;
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

export async function planSupervisorActions(): Promise<{ at: string; health: SupervisorHealthSummary; actions: SupervisorAction[] }> {
  const jobs = await listJobs();
  const at = new Date().toISOString();
  return {
    at,
    health: summarizeJobHealth(jobs),
    actions: planJobActions(jobs),
  };
}

async function supervisorTick(previousTick: SupervisorTick | null): Promise<SupervisorTick> {
  const recovered = await sweepJobs();
  const jobs = await listJobs();
  const at = new Date().toISOString();
  return {
    at,
    health: summarizeJobHealth(jobs),
    actions: annotateActionPersistence(planJobActions(jobs), previousTick),
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

async function writeSupervisorState(dir: string, state: SupervisorState): Promise<void> {
  await Bun.write(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function appendSupervisorEvent(dir: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(dir, "events.jsonl"), JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

function supervisorDir(root: string): string {
  return join(root, ".codexctl", "supervisor");
}
