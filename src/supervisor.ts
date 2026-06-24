import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listJobs, sweepJobs, type JobListItem, type JobRecoveryResult } from "./job.ts";

export type SupervisorTick = {
  at: string;
  health: SupervisorHealthSummary;
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
  await writeSupervisorState(dir, state);
  await appendSupervisorEvent(dir, { type: "supervisor.started", pid: process.pid, intervalMs: options.intervalMs });

  try {
    while (!stopRequested) {
      const tick = await supervisorTick();
      state.tickCount++;
      state.lastTick = tick;
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

async function supervisorTick(): Promise<SupervisorTick> {
  const recovered = await sweepJobs();
  const jobs = await listJobs();
  return {
    at: new Date().toISOString(),
    health: summarizeJobHealth(jobs),
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

async function writeSupervisorState(dir: string, state: SupervisorState): Promise<void> {
  await Bun.write(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

async function appendSupervisorEvent(dir: string, event: Record<string, unknown>): Promise<void> {
  await appendFile(join(dir, "events.jsonl"), JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

function supervisorDir(root: string): string {
  return join(root, ".codexctl", "supervisor");
}
