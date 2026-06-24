import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { assertJobKey } from "../src/app-server.ts";
import { parseArgs } from "../src/cli.ts";
import { compactJobEvent } from "../src/events.ts";
import {
  approvalResponseFor,
  cancelJob,
  cancelJobAndWait,
  createJob,
  enqueueApprovalDecisionAndWait,
  enqueueApprovalDecision,
  enqueueSteer,
  enqueueSteerAndWait,
  jobRecoveryStateId,
  listJobs,
  readApprovals,
  readJobEvents,
  readJobSummary,
  readNewEventLines,
  removeJob,
  pruneJobs,
  reconcileJobs,
  recoverJob,
  sweepJobs,
  waitForJob,
} from "../src/job.ts";
import {
  applySupervisorAction,
  inspectSupervisorAction,
  planSupervisorActions,
  readSupervisorActionHistory,
  readSupervisorEvents,
  readSupervisorState,
  runSupervisor,
  startSupervisor,
  stopSupervisor,
  waitForSupervisor,
} from "../src/supervisor.ts";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const repoRoot = join(import.meta.dir, "..");

beforeEach(() => {
  process.chdir(repoRoot);
});

async function runCli(args: string[], cwd = import.meta.dir): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForSupervisorFixtureStop(root: string): Promise<void> {
  const statePath = join(root, ".codexctl/supervisor/state.json");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const state = await Bun.file(statePath).json() as { status?: string };
      if (state.status === "stopped") return;
    } catch {
      // State may not have been written yet, or may be between atomic writes.
    }
    await Bun.sleep(10);
  }
}

describe("cli output contract", () => {
  test("inline flags preserve equals in values", () => {
    const args = parseArgs(["job", "start", "--key=inline-equals", "--prompt=a=b"]);
    expect(args.flags.get("key")).toBe("inline-equals");
    expect(args.flags.get("prompt")).toBe("a=b");
  });

  test("public commands require --json", async () => {
    const result = await runCli(["job", "list"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Public commands require --json");
  });

  test("--json errors are structured for machine callers", async () => {
    const result = await runCli(["job", "start", "--key=missing-prompt", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "usage_error",
        message: "Missing required --prompt",
      },
    });
  });

  test("job run validates required prompt before spawning", async () => {
    const result = await runCli(["job", "run", "--key=missing-prompt", "--timeout-ms", "1", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "usage_error",
        message: "Missing required --prompt",
      },
    });
  });

  test("--json parse errors stay structured", async () => {
    const result = await runCli(["--=x", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "invalid_flag",
        message: "Flag name cannot be empty",
      },
    });
  });

  test("unknown flags are rejected", async () => {
    const result = await runCli(["job", "list", "--json", "--unknown-flag"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "invalid_flag",
        message: "Unknown flag --unknown-flag",
      },
    });
  });

  test("invalid event format is rejected", async () => {
    const result = await runCli(["job", "events", "missing-test-job", "--format", "tiny", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "invalid_flag",
        message: "--format must be one of: raw, compact",
      },
    });
  });

  test("job run validates wait flags before spawning", async () => {
    const result = await runCli(["job", "run", "--key=bad-wait", "--prompt", "hello", "--timeout-ms", "", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "invalid_flag",
        message: "--timeout-ms must be a positive integer",
      },
    });
  });

  test("help is human-readable without --json", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("codexctl job start");
  });

  test("help supports --json", async () => {
    const result = await runCli(["--help", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).usage).toContain("codexctl job start");
  });
});

describe("compact job events", () => {
  test("summarizes important app-server lifecycle events", () => {
    expect(compactJobEvent({
      direction: "server",
      message: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      },
      at: "2026-06-24T00:00:00.000Z",
    })).toEqual([{
      type: "turn.completed",
      at: "2026-06-24T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      error: null,
    }]);

    expect(compactJobEvent({
      direction: "server",
      message: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            phase: "final_answer",
            text: "ok",
          },
        },
      },
      at: "2026-06-24T00:00:01.000Z",
    })).toEqual([{
      type: "agent_message.completed",
      at: "2026-06-24T00:00:01.000Z",
      itemId: "msg-1",
      phase: "final_answer",
      text: "ok",
      threadId: null,
      turnId: null,
    }]);
  });

  test("preserves app-server errors", () => {
    expect(compactJobEvent({
      direction: "server",
      message: {
        id: 7,
        error: { code: -32000, message: "boom", data: { detail: true } },
      },
      at: "2026-06-24T00:00:00.000Z",
    })).toEqual([{
      type: "app_server.error",
      at: "2026-06-24T00:00:00.000Z",
      requestId: 7,
      code: -32000,
      message: "boom",
      data: { detail: true },
      params: null,
      threadId: null,
      turnId: null,
    }]);

    expect(compactJobEvent({
      direction: "server",
      message: {
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          message: "turn exploded",
        },
      },
      at: "2026-06-24T00:00:01.000Z",
    })).toEqual([{
      type: "app_server.error",
      at: "2026-06-24T00:00:01.000Z",
      requestId: null,
      code: null,
      message: "turn exploded",
      data: null,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        message: "turn exploded",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    }]);
  });

  test("filters noisy app-server deltas", () => {
    expect(compactJobEvent({
      direction: "server",
      message: {
        method: "item/reasoning/summaryTextDelta",
        params: { delta: "thinking" },
      },
      at: "2026-06-24T00:00:00.000Z",
    })).toEqual([]);
  });

  test("job events can be emitted as compact JSONL", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "compact-events", repo: ".", prompt: "hello" });
      await Bun.write(".codexctl/jobs/compact-events/events.jsonl", [
        JSON.stringify({
          direction: "server",
          message: {
            method: "item/agentMessage/delta",
            params: { delta: "ignore me" },
          },
          at: "2026-06-24T00:00:00.000Z",
        }),
        JSON.stringify({
          direction: "server",
          message: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            },
          },
          at: "2026-06-24T00:00:01.000Z",
        }),
        "",
      ].join("\n"));
      const result = await runCli(["job", "events", "compact-events", "--format", "compact", "--json"], tmp);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([{
        type: "turn.completed",
        at: "2026-06-24T00:00:01.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        error: null,
      }]);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job summary returns final response, approvals, and recent compact events", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "summary-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/summary-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "completed";
      job.workerPid = process.pid;
      job.workerHeartbeatAt = "2026-06-24T00:00:00.000Z";
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      job.finalResponse = "done";
      job.completedAt = new Date().toISOString();
      job.approvals.push({
        id: "approval-1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: {},
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(jobPath, JSON.stringify(job));
      await Bun.write(".codexctl/jobs/summary-test/events.jsonl", [
        JSON.stringify({
          direction: "server",
          message: {
            method: "thread/started",
            params: { thread: { id: "thread-1" } },
          },
          at: "2026-06-24T00:00:00.000Z",
        }),
        JSON.stringify({
          direction: "server",
          message: {
            method: "warning",
            params: { message: "careful", threadId: "thread-1", turnId: "turn-1" },
          },
          at: "2026-06-24T00:00:00.500Z",
        }),
        JSON.stringify({
          direction: "server",
          message: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                type: "commandExecution",
                id: "cmd-1",
                command: "false",
                status: "failed",
                exitCode: 1,
                durationMs: 12,
              },
            },
          },
          at: "2026-06-24T00:00:00.750Z",
        }),
        JSON.stringify({
          direction: "server",
          message: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            },
          },
          at: "2026-06-24T00:00:01.000Z",
        }),
        "",
      ].join("\n"));

      const summary = await readJobSummary("summary-test", 1);
      expect(summary.status).toBe("completed");
      expect(summary.nextAction).toBe("read_result");
      expect(summary.workerHealth.reason).toBe("terminal");
      expect(summary.workerHealth.pid).toBe(process.pid);
      expect(summary.workerHealth.stale).toBe(false);
      expect(summary.finalResponse).toBe("done");
      expect(summary.pendingApprovals).toHaveLength(1);
      expect(summary.actionableApprovals).toHaveLength(0);
      expect(summary.canResolveApprovals).toBe(false);
      expect(summary.approvalCounts.pending).toBe(1);
      expect(summary.diagnostics.compactEventCount).toBe(4);
      expect(summary.diagnostics.recentEventsLimit).toBe(1);
      expect(summary.diagnostics.recentEventsTruncated).toBe(true);
      expect(summary.diagnostics.warningCount).toBe(1);
      expect(summary.diagnostics.commandCounts.failed).toBe(1);
      expect(summary.diagnostics.lastWarning?.message).toBe("careful");
      expect(summary.diagnostics.lastFailedCommand?.command).toBe("false");
      expect(summary.recentEvents).toEqual([{
        type: "turn.completed",
        at: "2026-06-24T00:00:01.000Z",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        error: null,
      }]);

      const cli = await runCli(["job", "summary", "summary-test", "--events", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(cli.stderr).toBe("");
      expect(JSON.parse(cli.stdout).finalResponse).toBe("done");

      const wait = await waitForJob("summary-test", { eventLimit: 0, intervalMs: 1, timeoutMs: 10 });
      expect(wait).toMatchObject({
        key: "summary-test",
        ready: true,
        reason: "terminal",
        status: "completed",
        nextAction: "read_result",
      });
      expect(wait.summary.finalResponse).toBe("done");

      const waitCli = await runCli(["job", "wait", "summary-test", "--events", "0", "--timeout-ms", "10", "--interval-ms", "1", "--json"], tmp);
      expect(waitCli.exitCode).toBe(0);
      expect(waitCli.stderr).toBe("");
      expect(JSON.parse(waitCli.stdout)).toMatchObject({
        ready: true,
        reason: "terminal",
        status: "completed",
        nextAction: "read_result",
        summary: {
          finalResponse: "done",
        },
      });

      const status = await runCli(["job", "status", "summary-test", "--json"], tmp);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout).workerHealth.reason).toBe("terminal");

      const noEvents = await runCli(["job", "summary", "summary-test", "--events", "0", "--json"], tmp);
      expect(noEvents.exitCode).toBe(0);
      expect(JSON.parse(noEvents.stdout).recentEvents).toEqual([]);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job wait returns when approval is required", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "approval-wait", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/approval-wait/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.approvals.push({
        id: "approval-1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: {},
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(jobPath, JSON.stringify(job));

      const wait = await waitForJob("approval-wait", { eventLimit: 0, intervalMs: 1, timeoutMs: 10 });
      expect(wait).toMatchObject({
        ready: true,
        reason: "approval_required",
        status: "running",
        nextAction: "resolve_approval",
      });
      expect(wait.summary.actionableApprovals).toHaveLength(1);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job wait returns the current summary on timeout", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "timeout-wait", repo: ".", prompt: "hello" });

      const wait = await waitForJob("timeout-wait", { eventLimit: 0, intervalMs: 1, timeoutMs: 1 });
      expect(wait).toMatchObject({
        key: "timeout-wait",
        ready: false,
        reason: "timeout",
        status: "queued",
        nextAction: "wait",
      });
      expect(wait.timeoutMs).toBe(1);
      expect(wait.summary.recentEvents).toEqual([]);

      const cli = await runCli(["job", "wait", "timeout-wait", "--events", "0", "--timeout-ms", "1", "--interval-ms", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        ready: false,
        reason: "timeout",
        status: "queued",
        nextAction: "wait",
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("approval protocol", () => {
  test("maps permissions approval to a scoped permission grant", () => {
    const approval = {
      id: "1",
      serverRequestId: 1,
      method: "item/permissions/requestApproval",
      params: {
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      decision: null,
      error: null,
    };

    expect(approvalResponseFor(approval, "approve")).toEqual({
      supported: true,
      response: {
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
        scope: "turn",
      },
    });
    expect(approvalResponseFor(approval, "approveForSession")).toEqual({
      supported: true,
      response: {
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
        scope: "session",
      },
    });
    expect(approvalResponseFor(approval, "reject")).toMatchObject({ supported: false });
  });
});

describe("event store", () => {
  test("missing job events read as an empty list", async () => {
    expect(await readJobEvents("missing-test-job")).toEqual([]);
  });

  test("job status reports worker health without parsing event logs", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "status-health-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/status-health-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerId = "worker-current";
      job.workerGeneration = 2;
      job.workerPid = process.pid;
      job.workerHeartbeatAt = "1970-01-01T00:00:00.000Z";
      await Bun.write(jobPath, JSON.stringify(job));
      const freshHeartbeat = new Date().toISOString();
      await Bun.write(".codexctl/jobs/status-health-test/worker-heartbeat.json", JSON.stringify({
        jobIncarnation: job.jobIncarnation,
        workerId: "worker-current",
        workerGeneration: 2,
        workerPid: process.pid,
        workerHeartbeatAt: freshHeartbeat,
      }));
      await Bun.write(".codexctl/jobs/status-health-test/events.jsonl", "{not-json}\n");

      const status = await runCli(["job", "status", "status-health-test", "--json"], tmp);
      expect(status.exitCode).toBe(0);
      const body = JSON.parse(status.stdout);
      expect(typeof body.jobIncarnation).toBe("string");
      expect(body.workerHeartbeatAt).toBe(freshHeartbeat);
      expect(body.workerId).toBe("worker-current");
      expect(body.workerGeneration).toBe(2);
      expect(body.workerHealth.heartbeatAt).toBe(freshHeartbeat);
      expect(body.workerHealth.alive).toBe(true);
      expect(body.workerHealth.reason).toBe("alive_recent");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job status ignores stale heartbeat files from older worker generations", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "stale-heartbeat-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/stale-heartbeat-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerId = "worker-current";
      job.workerGeneration = 2;
      job.workerPid = process.pid;
      job.workerHeartbeatAt = "1970-01-01T00:00:00.000Z";
      await Bun.write(jobPath, JSON.stringify(job));

      const staleHeartbeat = new Date().toISOString();
      await Bun.write(".codexctl/jobs/stale-heartbeat-test/worker-heartbeat.json", JSON.stringify({
        workerId: "worker-previous",
        workerGeneration: 1,
        workerPid: process.pid,
        workerHeartbeatAt: staleHeartbeat,
      }));

      const status = await runCli(["job", "status", "stale-heartbeat-test", "--json"], tmp);
      expect(status.exitCode).toBe(0);
      const body = JSON.parse(status.stdout);
      expect(body.workerId).toBe("worker-current");
      expect(body.workerGeneration).toBe(2);
      expect(body.workerHeartbeatAt).toBe("1970-01-01T00:00:00.000Z");
      expect(body.workerHealth.heartbeatAt).toBe("1970-01-01T00:00:00.000Z");
      expect(body.workerHealth.reason).toBe("alive_stale");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job status ignores legacy heartbeat files after worker identity exists", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "legacy-heartbeat-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/legacy-heartbeat-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerId = "worker-current";
      job.workerGeneration = 2;
      job.workerPid = process.pid;
      job.workerHeartbeatAt = "1970-01-01T00:00:00.000Z";
      await Bun.write(jobPath, JSON.stringify(job));

      const legacyHeartbeat = new Date().toISOString();
      await Bun.write(".codexctl/jobs/legacy-heartbeat-test/worker-heartbeat.json", JSON.stringify({
        workerPid: process.pid,
        workerHeartbeatAt: legacyHeartbeat,
      }));

      const status = await runCli(["job", "status", "legacy-heartbeat-test", "--json"], tmp);
      expect(status.exitCode).toBe(0);
      const body = JSON.parse(status.stdout);
      expect(body.workerId).toBe("worker-current");
      expect(body.workerGeneration).toBe(2);
      expect(body.workerHeartbeatAt).toBe("1970-01-01T00:00:00.000Z");
      expect(body.workerHealth.heartbeatAt).toBe("1970-01-01T00:00:00.000Z");
      expect(body.workerHealth.reason).toBe("alive_stale");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("enqueueApprovalDecision appends an approval resolve command", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "approval-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/approval-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.approvals.push({
        id: "1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: { command: "true" },
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(jobPath, JSON.stringify(job));
      const command = await enqueueApprovalDecision("approval-test", "1", "approve");
      expect(command.type).toBe("approval.resolve");
      expect(await readApprovals("approval-test")).toHaveLength(1);
      expect(await Bun.file(".codexctl/jobs/approval-test/control.jsonl").text()).toContain("approval.resolve");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("approval wait ignores the approval it just enqueued", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "approval-wait-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/approval-wait-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.approvals.push({
        id: "approval-1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: { command: "true" },
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(jobPath, JSON.stringify(job));

      const result = await enqueueApprovalDecisionAndWait("approval-wait-test", "approval-1", "approve", {
        eventLimit: 0,
        intervalMs: 1,
        timeoutMs: 1,
      });
      expect(result.command.type).toBe("approval.resolve");
      expect(result.wait).toMatchObject({
        ready: false,
        reason: "timeout",
        ignoredApprovalIds: ["approval-1"],
        nextAction: "resolve_approval",
      });

      await createJob({ key: "approval-wait-cli", repo: ".", prompt: "hello" });
      const cliJobPath = ".codexctl/jobs/approval-wait-cli/job.json";
      const cliJob = await Bun.file(cliJobPath).json();
      cliJob.status = "running";
      cliJob.approvals.push({
        id: "approval-1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: { command: "true" },
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(cliJobPath, JSON.stringify(cliJob));
      const cli = await runCli(["approval", "approve", "approval-wait-cli", "approval-1", "--wait", "--events", "0", "--timeout-ms", "1", "--interval-ms", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        command: {
          type: "approval.resolve",
          approvalId: "approval-1",
        },
        wait: {
          ready: false,
          reason: "timeout",
          ignoredApprovalIds: ["approval-1"],
        },
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("approval wait validates wait flags before enqueueing", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "approval-wait-invalid", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/approval-wait-invalid/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.approvals.push({
        id: "approval-1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: { command: "true" },
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(jobPath, JSON.stringify(job));

      const cli = await runCli(["approval", "approve", "approval-wait-invalid", "approval-1", "--wait", "--timeout-ms", "", "--json"], tmp);
      expect(cli.exitCode).toBe(2);
      expect(JSON.parse(cli.stderr).error).toEqual({
        code: "invalid_flag",
        message: "--timeout-ms must be a positive integer",
      });
      expect(await Bun.file(".codexctl/jobs/approval-wait-invalid/control.jsonl").text()).toBe("");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("enqueueApprovalDecision rejects unsupported permission denials", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "permission-approval-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/permission-approval-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.approvals.push({
        id: "1",
        serverRequestId: 1,
        method: "item/permissions/requestApproval",
        params: { permissions: { network: { enabled: true }, fileSystem: null } },
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(jobPath, JSON.stringify(job));
      await expect(enqueueApprovalDecision("permission-approval-test", "1", "reject")).rejects.toThrow("do not support reject/cancel");
      const command = await enqueueApprovalDecision("permission-approval-test", "1", "approveForSession");
      expect(command.decision).toBe("approveForSession");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("readNewEventLines consumes only complete lines using byte offsets", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "tail-test", repo: ".", prompt: "hello" });
      const path = ".codexctl/jobs/tail-test/events.jsonl";
      const first = JSON.stringify({ message: "日本語" }) + "\n";
      const second = JSON.stringify({ message: "next" }) + "\n";
      await Bun.write(path, first + second.slice(0, -1));
      const firstRead = await readNewEventLines("tail-test", 0);
      expect(firstRead.lines).toEqual([first.trimEnd()]);
      expect(firstRead.offset).toBe(new TextEncoder().encode(first).byteLength);

      await Bun.write(path, first + second);
      const secondRead = await readNewEventLines("tail-test", firstRead.offset);
      expect(secondRead.lines).toEqual([second.trimEnd()]);
      expect(secondRead.offset).toBe(new TextEncoder().encode(first + second).byteLength);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("cancelJob enqueues an interrupt control command for running jobs", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "cancel-running-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/cancel-running-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = process.pid;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));

      const result = await cancelJob("cancel-running-test");
      expect(result.action).toBe("interrupt_queued");
      expect(result.command?.type).toBe("turn.interrupt");
      if (!result.command) throw new Error("expected cancel command");
      expect(typeof result.job.cancelRequestedAt).toBe("string");
      const summary = await readJobSummary("cancel-running-test", 0);
      expect(summary.nextAction).toBe("wait_cancel");
      expect(summary.canResolveApprovals).toBe(false);
      expect(await Bun.file(".codexctl/jobs/cancel-running-test/control.jsonl").text()).toContain("turn.interrupt");

      const staleWorkerRecord = await Bun.file(jobPath).json();
      staleWorkerRecord.cancelRequestedAt = null;
      staleWorkerRecord.cancelCommandId = null;
      await Bun.write(jobPath, JSON.stringify(staleWorkerRecord));
      const recoveredSummary = await readJobSummary("cancel-running-test", 0);
      expect(recoveredSummary.nextAction).toBe("wait_cancel");
      expect(recoveredSummary.cancelRequestedAt).toBe(result.command?.at);
      expect(recoveredSummary.cancelCommandId).toBe(result.command?.id);
      const cancelListItem = (await listJobs()).find((candidate) => candidate.key === "cancel-running-test");
      expect(cancelListItem?.nextAction).toBe("wait_cancel");
      expect(cancelListItem?.cancelRequestedAt).toBe(result.command?.at);

      const cli = await runCli(["job", "cancel", "cancel-running-test", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).action).toBe("already_requested");

      const waitCli = await runCli(["job", "cancel", "cancel-running-test", "--wait", "--events", "0", "--timeout-ms", "1", "--interval-ms", "1", "--json"], tmp);
      expect(waitCli.exitCode).toBe(0);
      expect(JSON.parse(waitCli.stdout)).toMatchObject({
        cancel: {
          action: "already_requested",
        },
        wait: {
          ready: false,
          reason: "timeout",
          nextAction: "wait_cancel",
        },
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("cancelJob fails stale in-flight jobs instead of queuing unreachable interrupts", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "cancel-stale-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/cancel-stale-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));

      const result = await cancelJob("cancel-stale-test");
      expect(result.action).toBe("failed");
      expect(result.job.status).toBe("failed");
      expect(result.job.error).toContain("cannot be interrupted");
      expect(await Bun.file(".codexctl/jobs/cancel-stale-test/control.jsonl").text()).toBe("");
      expect(await Bun.file(".codexctl/jobs/cancel-stale-test/events.jsonl").text()).toContain("cancel.failed");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("removeJob removes terminal jobs and refuses active live workers", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "remove-terminal", repo: ".", prompt: "hello" });
      const terminalPath = ".codexctl/jobs/remove-terminal/job.json";
      const terminal = await Bun.file(terminalPath).json();
      terminal.status = "completed";
      terminal.completedAt = new Date().toISOString();
      await Bun.write(terminalPath, JSON.stringify(terminal));

      const dryRun = await removeJob("remove-terminal", { dryRun: true });
      expect(dryRun.action).toBe("would_remove");
      expect(await Bun.file(terminalPath).exists()).toBe(true);

      const cli = await runCli(["job", "rm", "remove-terminal", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).action).toBe("removed");
      expect(await Bun.file(terminalPath).exists()).toBe(false);

      await createJob({ key: "remove-running", repo: ".", prompt: "hello" });
      const runningPath = ".codexctl/jobs/remove-running/job.json";
      const running = await Bun.file(runningPath).json();
      running.status = "running";
      running.workerPid = process.pid;
      await Bun.write(runningPath, JSON.stringify(running));
      await expect(removeJob("remove-running", { force: true })).rejects.toThrow("still has live worker");
      expect(await Bun.file(runningPath).exists()).toBe(true);

      const rejected = await runCli(["job", "rm", "remove-running", "--force", "--json"], tmp);
      expect(rejected.exitCode).toBe(2);
      expect(JSON.parse(rejected.stderr).error.code).toBe("job_worker_alive");

      const extra = await runCli(["job", "rm", "remove-running", "extra", "--json"], tmp);
      expect(extra.exitCode).toBe(2);
      expect(JSON.parse(extra.stderr).error.code).toBe("usage_error");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("pruneJobs removes old completed jobs after keeping the newest", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      for (const [key, updatedAt] of [
        ["new-terminal", "2026-06-24T00:00:03.000Z"],
        ["old-terminal", "2026-06-24T00:00:01.000Z"],
        ["failed-job", "2026-06-24T00:00:02.000Z"],
        ["active-job", "2026-06-24T00:00:00.000Z"],
      ] as const) {
        await createJob({ key, repo: ".", prompt: "hello" });
        const path = `.codexctl/jobs/${key}/job.json`;
        const job = await Bun.file(path).json();
        job.updatedAt = updatedAt;
        if (key === "failed-job") {
          job.status = "failed";
          job.error = "boom";
          job.completedAt = updatedAt;
        } else if (key !== "active-job") {
          job.status = "completed";
          job.completedAt = updatedAt;
        } else {
          job.status = "running";
          job.workerPid = process.pid;
        }
        await Bun.write(path, JSON.stringify(job));
      }

      const dryRun = await pruneJobs({ keep: 1, dryRun: true });
      expect(dryRun.removed.map((job) => job.key)).toEqual(["old-terminal"]);
      expect(dryRun.removed[0]?.action).toBe("would_remove");
      expect(await Bun.file(".codexctl/jobs/old-terminal/job.json").exists()).toBe(true);

      const result = await pruneJobs({ keep: 1 });
      expect(result.removed.map((job) => job.key)).toEqual(["old-terminal"]);
      expect(await Bun.file(".codexctl/jobs/new-terminal/job.json").exists()).toBe(true);
      expect(await Bun.file(".codexctl/jobs/old-terminal/job.json").exists()).toBe(false);
      expect(await Bun.file(".codexctl/jobs/failed-job/job.json").exists()).toBe(true);
      expect(await Bun.file(".codexctl/jobs/active-job/job.json").exists()).toBe(true);

      const cli = await runCli(["job", "prune", "--keep", "1", "--dry-run", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).removed).toEqual([]);

      const terminal = await runCli(["job", "prune", "--keep", "0", "--status", "terminal", "--dry-run", "--json"], tmp);
      expect(terminal.exitCode).toBe(0);
      expect(JSON.parse(terminal.stdout).removed.map((job: { key: string }) => job.key)).toEqual(["new-terminal", "failed-job"]);

      const extra = await runCli(["job", "prune", "unexpected", "--json"], tmp);
      expect(extra.exitCode).toBe(2);
      expect(JSON.parse(extra.stderr).error.code).toBe("usage_error");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("job control files", () => {
  test("createJob initializes control and event logs", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "control-test", repo: ".", prompt: "hello" });
      expect(await Bun.file(".codexctl/jobs/control-test/events.jsonl").text()).toBe("");
      expect(await Bun.file(".codexctl/jobs/control-test/control.jsonl").text()).toBe("");
      expect(await Bun.file(".codexctl/jobs/control-test/job.json").json()).toMatchObject({
        key: "control-test",
        status: "queued",
      });
      const first = await Bun.file(".codexctl/jobs/control-test/job.json").json();
      expect(typeof first.jobIncarnation).toBe("string");
      await createJob({ key: "control-test", repo: ".", prompt: "hello again", force: true });
      const replacement = await Bun.file(".codexctl/jobs/control-test/job.json").json();
      expect(replacement.jobIncarnation).not.toBe(first.jobIncarnation);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("createJob force refuses to replace live workers", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "live-force-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/live-force-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = process.pid;
      await Bun.write(jobPath, JSON.stringify(job));

      await expect(createJob({ key: "live-force-test", repo: ".", prompt: "replacement", force: true })).rejects.toThrow("cancel or wait before replacing it");
      expect((await Bun.file(jobPath).json()).prompt).toBe("hello");

      const cli = await runCli(["job", "run", "--key", "live-force-test", "--repo", ".", "--prompt", "replacement", "--force", "--timeout-ms", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(2);
      expect(JSON.parse(cli.stderr).error).toMatchObject({
        code: "job_worker_alive",
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("createJob breaks stale job record locks", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await mkdir(".codexctl/jobs/lock-test/job.lock", { recursive: true });
      await Bun.write(".codexctl/jobs/lock-test/job.lock/owner.json", JSON.stringify({
        pid: 999_999_999,
        createdAt: new Date().toISOString(),
      }));
      await createJob({ key: "lock-test", repo: ".", prompt: "hello" });
      expect(await Bun.file(".codexctl/jobs/lock-test/job.lock").exists()).toBe(false);
      expect((await Bun.file(".codexctl/jobs/lock-test/job.json").json()).key).toBe("lock-test");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("createJob breaks stale job record locks with invalid owner metadata", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      const lockDir = ".codexctl/jobs/invalid-lock-test/job.lock";
      await mkdir(lockDir, { recursive: true });
      await Bun.write(`${lockDir}/owner.json`, "null");
      const staleTime = new Date(Date.now() - 31_000);
      await utimes(lockDir, staleTime, staleTime);
      await createJob({ key: "invalid-lock-test", repo: ".", prompt: "hello" });
      expect(await Bun.file(lockDir).exists()).toBe(false);
      expect((await Bun.file(".codexctl/jobs/invalid-lock-test/job.json").json()).key).toBe("invalid-lock-test");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("enqueueSteer appends a control command for running jobs", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "steer-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/steer-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      await Bun.write(jobPath, JSON.stringify(job));
      const command = await enqueueSteer("steer-test", "adjust");
      expect(command.type).toBe("turn.steer");
      expect(await Bun.file(".codexctl/jobs/steer-test/control.jsonl").text()).toContain("adjust");

      const waited = await enqueueSteerAndWait("steer-test", "wait-adjust", {
        eventLimit: 0,
        intervalMs: 1,
        timeoutMs: 1,
      });
      expect(waited.command.type).toBe("turn.steer");
      expect(waited.wait).toMatchObject({
        ready: false,
        reason: "timeout",
        nextAction: "wait",
      });

      const cli = await runCli(["job", "steer", "steer-test", "--prompt", "cli-adjust", "--wait", "--events", "0", "--timeout-ms", "1", "--interval-ms", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        command: {
          type: "turn.steer",
        },
        wait: {
          ready: false,
          reason: "timeout",
          nextAction: "wait",
        },
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("cancelJob marks queued jobs cancelled without a worker command", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "cancel-queued-test", repo: ".", prompt: "hello" });
      const result = await cancelJob("cancel-queued-test");
      expect(result.action).toBe("cancelled");
      expect(result.command).toBeNull();
      expect(result.job.status).toBe("cancelled");
      expect(result.job.error).toBeNull();
      expect((await readJobSummary("cancel-queued-test", 0)).nextAction).toBe("cancelled");
      expect(await Bun.file(".codexctl/jobs/cancel-queued-test/events.jsonl").text()).toContain("job.cancelled");

      await createJob({ key: "cancel-queued-wait-test", repo: ".", prompt: "hello" });
      const waited = await cancelJobAndWait("cancel-queued-wait-test", {
        eventLimit: 0,
        intervalMs: 1,
        timeoutMs: 10,
      });
      expect(waited.cancel.action).toBe("cancelled");
      expect(waited.wait).toMatchObject({
        ready: true,
        reason: "terminal",
        status: "cancelled",
        nextAction: "cancelled",
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("recoverJob fails in-flight jobs whose worker is gone", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "recover-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/recover-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));
      const result = await recoverJob("recover-test");
      expect(result.action).toBe("failed");
      expect(result.job.status).toBe("failed");
      expect(result.job.error).toContain("cannot be resumed");
      expect(await Bun.file(".codexctl/jobs/recover-test/events.jsonl").text()).toContain("recovery.failed");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("reconcileJobs reports lifecycle decisions without applying in dry-run", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "queued-reconcile", repo: ".", prompt: "hello" });
      await createJob({ key: "alive-reconcile", repo: ".", prompt: "hello" });
      await createJob({ key: "dead-reconcile", repo: ".", prompt: "hello" });
      await createJob({ key: "completed-reconcile", repo: ".", prompt: "hello" });
      await mkdir(".codexctl/jobs/unreadable-reconcile", { recursive: true });
      await Bun.write(".codexctl/jobs/unreadable-reconcile/job.json", "{not-json}\n");

      const alive = await Bun.file(".codexctl/jobs/alive-reconcile/job.json").json();
      alive.status = "running";
      alive.workerPid = process.pid;
      alive.workerHeartbeatAt = new Date().toISOString();
      await Bun.write(".codexctl/jobs/alive-reconcile/job.json", JSON.stringify(alive));

      const dead = await Bun.file(".codexctl/jobs/dead-reconcile/job.json").json();
      dead.status = "running";
      dead.workerPid = null;
      dead.threadId = "thread-1";
      dead.turnId = "turn-1";
      await Bun.write(".codexctl/jobs/dead-reconcile/job.json", JSON.stringify(dead));

      const completed = await Bun.file(".codexctl/jobs/completed-reconcile/job.json").json();
      completed.status = "completed";
      completed.completedAt = new Date().toISOString();
      await Bun.write(".codexctl/jobs/completed-reconcile/job.json", JSON.stringify(completed));

      const report = await reconcileJobs({ dryRun: true });
      expect(report.dryRun).toBe(true);
      expect(report.scanned).toBe(5);
      expect(report.candidates).toBe(4);
      expect(report.mutations).toBe(2);
      expect(report.applied).toBe(0);
      const byKey = new Map(report.items.map((item) => [item.key, item]));
      expect(byKey.get("dead-reconcile")).toMatchObject({ decision: "fail_in_flight_dead_worker", mutates: true });
      expect(byKey.get("alive-reconcile")).toMatchObject({ decision: "skip_worker_alive", mutates: false });
      expect(byKey.get("unreadable-reconcile")).toMatchObject({ decision: "skip_unreadable", mutates: false });
      expect(byKey.get("queued-reconcile")).toMatchObject({ decision: "restart_queued", mutates: true });
      expect(report.items.find((item) => item.key === "queued-reconcile")?.result).toBeNull();
      expect((await Bun.file(".codexctl/jobs/queued-reconcile/job.json").json()).status).toBe("queued");

      const cli = await runCli(["job", "reconcile", "--dry-run", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).mutations).toBe(2);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job reconcile applies dead in-flight failure decisions", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "apply-reconcile", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/apply-reconcile/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));

      const cli = await runCli(["job", "reconcile", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      const report = JSON.parse(cli.stdout);
      expect(report.dryRun).toBe(false);
      expect(report.mutations).toBe(1);
      expect(report.applied).toBe(1);
      expect(report.items[0]).toMatchObject({
        key: "apply-reconcile",
        decision: "fail_in_flight_dead_worker",
        applied: true,
        result: {
          action: "failed",
        },
      });
      expect((await Bun.file(jobPath).json()).status).toBe("failed");
      expect(await Bun.file(".codexctl/jobs/apply-reconcile/events.jsonl").text()).toContain("recovery.failed");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("jobRecoveryStateId changes with worker identity", () => {
    const base = {
      jobIncarnation: "job-a",
      updatedAt: "2026-06-24T00:00:00.000Z",
      workerId: "worker-a",
      workerGeneration: 1,
      workerPid: 123,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(jobRecoveryStateId({ ...base, jobIncarnation: "job-b" })).not.toBe(jobRecoveryStateId(base));
    expect(jobRecoveryStateId({ ...base, workerId: "worker-b" })).not.toBe(jobRecoveryStateId(base));
    expect(jobRecoveryStateId({ ...base, workerGeneration: 2 })).not.toBe(jobRecoveryStateId(base));
  });

  test("listJobs summarizes jobs and sweepJobs recovers active jobs", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "completed-job", repo: ".", prompt: "hello" });
      await createJob({ key: "legacy-job", repo: ".", prompt: "hello" });
      await createJob({ key: "stale-job", repo: ".", prompt: "hello" });

      const completedPath = ".codexctl/jobs/completed-job/job.json";
      const completed = await Bun.file(completedPath).json();
      completed.status = "completed";
      completed.completedAt = new Date().toISOString();
      completed.approvals.push({
        id: "1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: {},
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(completedPath, JSON.stringify(completed));

      const legacyPath = ".codexctl/jobs/legacy-job/job.json";
      const legacy = await Bun.file(legacyPath).json();
      legacy.status = "completed";
      delete legacy.approvals;
      await Bun.write(legacyPath, JSON.stringify(legacy));

      const stalePath = ".codexctl/jobs/stale-job/job.json";
      const stale = await Bun.file(stalePath).json();
      stale.status = "running";
      stale.workerPid = null;
      stale.workerHeartbeatAt = "2026-06-24T00:00:00.000Z";
      stale.threadId = "thread-1";
      stale.turnId = "turn-1";
      await Bun.write(stalePath, JSON.stringify(stale));

      const jobs = await listJobs();
      expect(jobs.map((job) => job.key).sort()).toEqual(["completed-job", "legacy-job", "stale-job"]);
      expect(jobs.find((job) => job.key === "completed-job")?.pendingApprovals).toBe(1);
      expect(jobs.find((job) => job.key === "completed-job")?.actionableApprovals).toBe(0);
      expect(jobs.find((job) => job.key === "completed-job")?.nextAction).toBe("read_result");
      expect(jobs.find((job) => job.key === "legacy-job")?.pendingApprovals).toBe(0);
      expect(jobs.find((job) => job.key === "legacy-job")?.workerHeartbeatAt).toBe(null);
      expect(jobs.find((job) => job.key === "stale-job")?.workerAlive).toBe(false);
      expect(jobs.find((job) => job.key === "stale-job")?.workerHealth?.reason).toBe("no_worker_pid");
      expect(jobs.find((job) => job.key === "stale-job")?.workerHealth?.stale).toBe(true);

      const sweep = await sweepJobs();
      expect(sweep).toHaveLength(1);
      expect(sweep[0]?.job.key).toBe("stale-job");
      expect(sweep[0]?.action).toBe("failed");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job summary reports stale live worker heartbeat", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "heartbeat-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/heartbeat-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = process.pid;
      job.workerHeartbeatAt = "1970-01-01T00:00:00.000Z";
      await Bun.write(jobPath, JSON.stringify(job));

      const summary = await readJobSummary("heartbeat-test", 0);
      expect(summary.workerHealth.alive).toBe(true);
      expect(summary.workerHealth.stale).toBe(true);
      expect(summary.workerHealth.reason).toBe("alive_stale");
      expect(summary.workerHealth.heartbeatAgeMs).toBeGreaterThan(30_000);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("supervisor", () => {
  test("planSupervisorActions returns non-executing next action recommendations", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    const realDateNow = Date.now;
    try {
      process.chdir(tmp);
      const fixedNow = Date.now();
      await createJob({ key: "approval-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "cancel-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "cancel-attention-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "cancel-critical-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "stale-attention-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "stale-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "missing-heartbeat-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "dead-plan", repo: ".", prompt: "hello" });
      await createJob({ key: "failed-plan", repo: ".", prompt: "hello" });
      await mkdir(".codexctl/jobs/unreadable-plan", { recursive: true });
      await Bun.write(".codexctl/jobs/unreadable-plan/job.json", "{not-json}\n");

      const approval = await Bun.file(".codexctl/jobs/approval-plan/job.json").json();
      approval.status = "running";
      approval.workerPid = process.pid;
      approval.workerHeartbeatAt = new Date().toISOString();
      approval.approvals.push({
        id: "1",
        serverRequestId: 1,
        method: "item/commandExecution/requestApproval",
        params: {},
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        decision: null,
        error: null,
      });
      await Bun.write(".codexctl/jobs/approval-plan/job.json", JSON.stringify(approval));

      const cancel = await Bun.file(".codexctl/jobs/cancel-plan/job.json").json();
      cancel.status = "running";
      cancel.workerPid = process.pid;
      cancel.workerHeartbeatAt = new Date().toISOString();
      cancel.threadId = "thread-1";
      cancel.turnId = "turn-1";
      await Bun.write(".codexctl/jobs/cancel-plan/job.json", JSON.stringify(cancel));
      await Bun.write(
        ".codexctl/jobs/cancel-plan/control.jsonl",
        JSON.stringify({ id: "fresh-cancel", type: "turn.interrupt", at: "2999-01-01T00:00:00.000Z" }) + "\n",
      );

      const cancelAttention = await Bun.file(".codexctl/jobs/cancel-attention-plan/job.json").json();
      cancelAttention.status = "running";
      cancelAttention.workerPid = process.pid;
      cancelAttention.workerHeartbeatAt = new Date().toISOString();
      cancelAttention.threadId = "thread-1";
      cancelAttention.turnId = "turn-1";
      await Bun.write(".codexctl/jobs/cancel-attention-plan/job.json", JSON.stringify(cancelAttention));
      await Bun.write(
        ".codexctl/jobs/cancel-attention-plan/control.jsonl",
        JSON.stringify({ id: "attention-cancel", type: "turn.interrupt", at: new Date(fixedNow - 2 * 60_000).toISOString() }) + "\n",
      );

      const cancelCritical = await Bun.file(".codexctl/jobs/cancel-critical-plan/job.json").json();
      cancelCritical.status = "running";
      cancelCritical.workerPid = process.pid;
      cancelCritical.workerHeartbeatAt = new Date().toISOString();
      cancelCritical.threadId = "thread-1";
      cancelCritical.turnId = "turn-1";
      await Bun.write(".codexctl/jobs/cancel-critical-plan/job.json", JSON.stringify(cancelCritical));
      await Bun.write(
        ".codexctl/jobs/cancel-critical-plan/control.jsonl",
        JSON.stringify({ id: "old-cancel", type: "turn.interrupt", at: "1970-01-01T00:00:00.000Z" }) + "\n",
      );

      const staleAttention = await Bun.file(".codexctl/jobs/stale-attention-plan/job.json").json();
      staleAttention.status = "running";
      staleAttention.workerPid = process.pid;
      staleAttention.workerHeartbeatAt = new Date(fixedNow - 31_000).toISOString();
      await Bun.write(".codexctl/jobs/stale-attention-plan/job.json", JSON.stringify(staleAttention));

      const stale = await Bun.file(".codexctl/jobs/stale-plan/job.json").json();
      stale.status = "running";
      stale.workerPid = process.pid;
      stale.workerHeartbeatAt = "1970-01-01T00:00:00.000Z";
      await Bun.write(".codexctl/jobs/stale-plan/job.json", JSON.stringify(stale));

      const missingHeartbeat = await Bun.file(".codexctl/jobs/missing-heartbeat-plan/job.json").json();
      missingHeartbeat.status = "running";
      missingHeartbeat.workerPid = process.pid;
      missingHeartbeat.workerHeartbeatAt = null;
      await Bun.write(".codexctl/jobs/missing-heartbeat-plan/job.json", JSON.stringify(missingHeartbeat));

      const dead = await Bun.file(".codexctl/jobs/dead-plan/job.json").json();
      dead.status = "running";
      dead.workerPid = null;
      dead.threadId = "thread-1";
      dead.turnId = "turn-1";
      await Bun.write(".codexctl/jobs/dead-plan/job.json", JSON.stringify(dead));

      const failed = await Bun.file(".codexctl/jobs/failed-plan/job.json").json();
      failed.status = "failed";
      failed.error = "boom";
      await Bun.write(".codexctl/jobs/failed-plan/job.json", JSON.stringify(failed));

      Date.now = () => fixedNow;
      const plan = await planSupervisorActions();
      expect(plan.health.total).toBe(10);
      expect(plan.health.unreadable).toBe(1);
      expect(plan.health.actionableApprovals).toBe(1);
      expect(plan.health.waitingCancel).toBe(3);
      expect(plan.health.staleWorkers).toBe(4);
      expect(plan.health.deadWorkers).toBe(1);
      expect(plan.health.inspectError).toBe(1);
      expect(plan.actions).toHaveLength(10);
      expect(plan.actions.filter((action) => action.kind === "wait_cancel")).toHaveLength(3);
      expect(plan.actions.find((action) => action.kind === "resolve_approval")?.nextCommand).toBe("codexctl approval list approval-plan --json");
      const cancelAction = plan.actions.find((action) => action.jobKey === "cancel-plan");
      expect(cancelAction?.id).toBe("cancel-plan:wait_cancel");
      expect(cancelAction?.kind).toBe("wait_cancel");
      expect(cancelAction?.severity).toBe("info");
      expect(cancelAction?.thresholdMs).toBe(60_000);
      expect(cancelAction?.seenTicks).toBeUndefined();
      expect(cancelAction?.firstSeenAt).toBeUndefined();
      const attentionCancelAction = plan.actions.find((action) => action.jobKey === "cancel-attention-plan");
      expect(attentionCancelAction?.kind).toBe("wait_cancel");
      expect(attentionCancelAction?.severity).toBe("attention");
      expect(attentionCancelAction?.ageMs).toBe(2 * 60_000);
      expect(attentionCancelAction?.thresholdMs).toBe(60_000);
      const oldCancelAction = plan.actions.find((action) => action.jobKey === "cancel-critical-plan");
      expect(oldCancelAction?.kind).toBe("wait_cancel");
      expect(oldCancelAction?.severity).toBe("critical");
      expect(oldCancelAction?.ageMs).toBeGreaterThan(5 * 60_000);
      expect(oldCancelAction?.thresholdMs).toBe(5 * 60_000);
      expect(oldCancelAction?.policy).toEqual({
        recommendation: "inspect",
        reason: "critical recommendation",
        basedOn: ["severity"],
      });
      const staleAttentionAction = plan.actions.find((action) => action.jobKey === "stale-attention-plan");
      expect(staleAttentionAction?.kind).toBe("inspect_stale_worker");
      expect(staleAttentionAction?.severity).toBe("attention");
      expect(staleAttentionAction?.ageMs).toBe(31_000);
      expect(staleAttentionAction?.thresholdMs).toBe(5 * 60_000);
      const staleAction = plan.actions.find((action) => action.jobKey === "stale-plan");
      expect(staleAction?.id).toBe("stale-plan:inspect_stale_worker");
      expect(staleAction?.kind).toBe("inspect_stale_worker");
      expect(staleAction?.severity).toBe("critical");
      expect(staleAction?.thresholdMs).toBe(5 * 60_000);
      expect(staleAction?.policy?.recommendation).toBe("inspect");
      const missingHeartbeatAction = plan.actions.find((action) => action.jobKey === "missing-heartbeat-plan");
      expect(missingHeartbeatAction?.kind).toBe("inspect_stale_worker");
      expect(missingHeartbeatAction?.severity).toBe("attention");
      expect(missingHeartbeatAction?.ageMs).toBeNull();
      expect(missingHeartbeatAction?.thresholdMs).toBe(5 * 60_000);
      const deadAction = plan.actions.find((action) => action.kind === "inspect_dead_worker");
      if (!deadAction) throw new Error("expected dead worker action");
      expect(deadAction.id).toMatch(/^dead-plan:inspect_dead_worker:[0-9a-f]{8}$/);
      expect(deadAction?.nextCommand).toBe("codexctl job summary dead-plan --events 20 --json");
      expect(plan.actions.find((action) => action.kind === "inspect_unreadable")?.severity).toBe("critical");
      expect(plan.actions.find((action) => action.jobKey === "failed-plan")?.id).toMatch(/^failed-plan:inspect_error:[0-9a-f]{8}$/);

      const cli = await runCli(["supervisor", "plan", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).actions).toHaveLength(10);

      const approvalInspection = await inspectSupervisorAction("approval-plan", "resolve_approval");
      expect(approvalInspection.readOnly).toBe(true);
      expect(approvalInspection.action.nextCommand).toBe("codexctl approval list approval-plan --json");
      expect(approvalInspection.inspection.type).toBe("approval_list");
      if (approvalInspection.inspection.type !== "approval_list") throw new Error("expected approval list inspection");
      expect(approvalInspection.inspection.approvals).toHaveLength(1);

      const failedInspection = await inspectSupervisorAction("failed-plan", "inspect_error");
      expect(failedInspection.action.id).toMatch(/^failed-plan:inspect_error:[0-9a-f]{8}$/);
      expect(failedInspection.action.policy?.recommendation).toBe("inspect");
      expect(failedInspection.inspection.type).toBe("job_summary");
      if (failedInspection.inspection.type !== "job_summary") throw new Error("expected job summary inspection");
      expect(failedInspection.inspection.eventLimit).toBe(20);
      expect(failedInspection.inspection.summary.error).toBe("boom");

      const unreadableInspection = await inspectSupervisorAction("unreadable-plan", "inspect_unreadable");
      expect(unreadableInspection.inspection.type).toBe("unreadable_job");
      if (unreadableInspection.inspection.type !== "unreadable_job") throw new Error("expected unreadable job inspection");
      expect(unreadableInspection.inspection.error).toContain("JSON");

      const inspectCli = await runCli(["supervisor", "inspect", "failed-plan", "--kind", "inspect_error", "--json"], tmp);
      expect(inspectCli.exitCode).toBe(0);
      expect(inspectCli.stderr).toBe("");
      expect(JSON.parse(inspectCli.stdout).inspection.summary.error).toBe("boom");

      const inspectByIdCli = await runCli([
        "supervisor",
        "inspect",
        "failed-plan",
        "--kind",
        "inspect_error",
        "--action-id",
        failedInspection.action.id,
        "--json",
      ], tmp);
      expect(inspectByIdCli.exitCode).toBe(0);
      expect(JSON.parse(inspectByIdCli.stdout).action.id).toBe(failedInspection.action.id);

      const wrongIdInspection = await runCli([
        "supervisor",
        "inspect",
        "failed-plan",
        "--kind",
        "inspect_error",
        "--action-id",
        "wrong-action-id",
        "--json",
      ], tmp);
      expect(wrongIdInspection.exitCode).toBe(2);
      expect(JSON.parse(wrongIdInspection.stderr)).toEqual({
        ok: false,
        error: {
          code: "supervisor_action_not_found",
          message: "No supervisor action 'inspect_error' for job 'failed-plan' with id 'wrong-action-id'",
        },
      });

      const missingAction = await runCli(["supervisor", "inspect", "failed-plan", "--kind", "wait_cancel", "--json"], tmp);
      expect(missingAction.exitCode).toBe(2);
      expect(JSON.parse(missingAction.stderr)).toEqual({
        ok: false,
        error: {
          code: "supervisor_action_not_found",
          message: "No supervisor action 'wait_cancel' for job 'failed-plan'",
        },
      });

      const invalidKind = await runCli(["supervisor", "inspect", "failed-plan", "--kind", "recover", "--json"], tmp);
      expect(invalidKind.exitCode).toBe(2);
      expect(JSON.parse(invalidKind.stderr)).toEqual({
        ok: false,
        error: {
          code: "invalid_flag",
          message: "--kind must be one of: resolve_approval, wait_cancel, inspect_error, inspect_stale_worker, inspect_dead_worker, inspect_unreadable",
        },
      });

      const deadPlanJobBeforeDryRun = await Bun.file(".codexctl/jobs/dead-plan/job.json").text();
      const deadPlanEventsBeforeDryRun = await Bun.file(".codexctl/jobs/dead-plan/events.jsonl").text();
      const dryRunApply = await applySupervisorAction("dead-plan", "inspect_dead_worker", { dryRun: true });
      expect(dryRunApply.action.id).toBe(deadAction.id);
      expect(dryRunApply.dryRun).toBe(true);
      expect(dryRunApply.applied).toBe(false);
      expect(dryRunApply.requiredConfirmation).toBe("recover-dead-worker");
      expect(dryRunApply.application.result).toBeNull();
      expect(await Bun.file(".codexctl/jobs/dead-plan/job.json").text()).toBe(deadPlanJobBeforeDryRun);
      expect(await Bun.file(".codexctl/jobs/dead-plan/events.jsonl").text()).toBe(deadPlanEventsBeforeDryRun);

      await expect(applySupervisorAction("failed-plan", "inspect_error", { dryRun: true })).rejects.toThrow("has no mutating apply operation");
      await expect(applySupervisorAction("dead-plan", "inspect_dead_worker")).rejects.toThrow("requires --confirm recover-dead-worker");

      const dryRunCli = await runCli(["supervisor", "apply", "dead-plan", "--kind", "inspect_dead_worker", "--dry-run", "--json"], tmp);
      expect(dryRunCli.exitCode).toBe(0);
      expect(JSON.parse(dryRunCli.stdout).requiredConfirmation).toBe("recover-dead-worker");

      const dryRunByIdCli = await runCli([
        "supervisor",
        "apply",
        "dead-plan",
        "--kind",
        "inspect_dead_worker",
        "--action-id",
        deadAction.id,
        "--dry-run",
        "--json",
      ], tmp);
      expect(dryRunByIdCli.exitCode).toBe(0);
      expect(JSON.parse(dryRunByIdCli.stdout).action.id).toBe(deadAction.id);

      const changedDead = await Bun.file(".codexctl/jobs/dead-plan/job.json").json();
      changedDead.updatedAt = "2026-06-24T00:00:09.000Z";
      await Bun.write(".codexctl/jobs/dead-plan/job.json", JSON.stringify(changedDead));
      const staleIdApply = await runCli([
        "supervisor",
        "apply",
        "dead-plan",
        "--kind",
        "inspect_dead_worker",
        "--action-id",
        deadAction.id,
        "--dry-run",
        "--json",
      ], tmp);
      expect(staleIdApply.exitCode).toBe(2);
      expect(JSON.parse(staleIdApply.stderr).error.code).toBe("supervisor_action_not_found");
      expect((await planSupervisorActions()).actions.find((action) => action.jobKey === "dead-plan")?.id).not.toBe(deadAction.id);
      await expect(recoverJob("dead-plan", { expectedRecoveryStateId: "stale-state" })).rejects.toThrow("changed before recovery");

      const missingConfirmCli = await runCli(["supervisor", "apply", "dead-plan", "--kind", "inspect_dead_worker", "--json"], tmp);
      expect(missingConfirmCli.exitCode).toBe(2);
      expect(JSON.parse(missingConfirmCli.stderr)).toEqual({
        ok: false,
        error: {
          code: "supervisor_confirmation_required",
          message: "Applying 'inspect_dead_worker' for job 'dead-plan' requires --confirm recover-dead-worker",
        },
      });

      const applyCli = await runCli(["supervisor", "apply", "dead-plan", "--kind", "inspect_dead_worker", "--confirm", "recover-dead-worker", "--json"], tmp);
      expect(applyCli.exitCode).toBe(0);
      const applyBody = JSON.parse(applyCli.stdout);
      expect(applyBody.applied).toBe(true);
      expect(applyBody.application.type).toBe("job_recovery");
      expect(applyBody.application.result.action).toBe("failed");
      expect(applyBody.application.result.job.status).toBe("failed");
    } finally {
      Date.now = realDateNow;
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("runSupervisor once sweeps active jobs and records state", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "supervisor-stale", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/supervisor-stale/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));

      const state = await runSupervisor({ intervalMs: 1, once: true });
      expect(state.status).toBe("stopped");
      expect(state.tickCount).toBe(1);
      expect(state.lastTick?.recovered).toHaveLength(1);
      expect(state.lastTick?.recovered[0]?.job.key).toBe("supervisor-stale");
      if (!state.lastTick?.reconciliation) throw new Error("expected reconciliation report");
      expect(state.lastTick.reconciliation.scanned).toBe(1);
      expect(state.lastTick.reconciliation.applied).toBe(1);
      expect(state.lastTick.reconciliation.items[0]).toMatchObject({
        key: "supervisor-stale",
        decision: "fail_in_flight_dead_worker",
        applied: true,
      });
      expect(state.lastTick?.health.total).toBe(1);
      expect(state.lastTick?.health.failed).toBe(1);
      expect(state.lastTick?.health.inspectError).toBe(1);
      expect(state.lastTick?.health.deadWorkers).toBe(0);
      expect(state.lastTick?.actions.map((action) => action.kind)).toEqual(["inspect_error"]);
      expect(state.lastTick?.actions[0]?.policy?.recommendation).toBe("inspect");
      expect((await readSupervisorState()).tickCount).toBe(1);
      expect(await Bun.file(".codexctl/supervisor/state.json").exists()).toBe(true);
      expect((await readSupervisorEvents()).map((event) => (event as { type?: string }).type)).toContain("supervisor.tick");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("readSupervisorState normalizes legacy ticks without reconciliation", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await mkdir(".codexctl/supervisor", { recursive: true });
      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "stopped",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:01.000Z",
        pid: null,
        tickCount: 1,
        lastTick: {
          at: "2026-06-24T00:00:01.000Z",
          health: {
            total: 0,
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
          },
          actions: [],
          recovered: [],
        },
      }));

      const state = await readSupervisorState();
      expect(state.lastTick?.reconciliation).toBeNull();
      expect(state.supervisorId).toBeNull();
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("waitForSupervisor waits for ticks, actions, stopped state, and timeout", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);

      const timeout = await waitForSupervisor({ intervalMs: 1, timeoutMs: 1 });
      expect(timeout).toMatchObject({
        ready: false,
        reason: "timeout",
        afterTick: 0,
        state: null,
        actions: [],
      });

      const tickWait = waitForSupervisor({ afterTick: 0, intervalMs: 1, timeoutMs: 1000 });
      await runSupervisor({ intervalMs: 1, once: true });
      expect(await tickWait).toMatchObject({
        ready: true,
        reason: "tick",
        afterTick: 0,
        actions: [],
        state: {
          tickCount: 1,
        },
      });

      const stopped = await waitForSupervisor({ afterTick: 1, intervalMs: 1, timeoutMs: 10 });
      expect(stopped).toMatchObject({
        ready: true,
        reason: "stopped",
        afterTick: 1,
        actions: [],
      });

      await createJob({ key: "supervisor-wait-action", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/supervisor-wait-action/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));

      await runSupervisor({ intervalMs: 1, once: true });
      const actionWait = await waitForSupervisor({ intervalMs: 1, timeoutMs: 10 });
      expect(actionWait.ready).toBe(true);
      expect(actionWait.reason).toBe("actions");
      expect(actionWait.actions.map((action) => action.kind)).toEqual(["inspect_error"]);

      const cliActions = await runCli(["supervisor", "wait", "--after-tick", "0", "--interval-ms", "1", "--timeout-ms", "10", "--json"], tmp);
      expect(cliActions.exitCode).toBe(0);
      expect(JSON.parse(cliActions.stdout).reason).toBe("actions");

      const staleActionWait = await waitForSupervisor({
        afterTick: actionWait.state?.tickCount ?? 0,
        intervalMs: 1,
        timeoutMs: 1,
      });
      expect(staleActionWait).toMatchObject({
        ready: true,
        reason: "stopped",
        actions: [],
      });

      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "running",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
        pid: 999_999_999,
        supervisorId: "dead-supervisor",
        tickCount: actionWait.state?.tickCount ?? 1,
        lastTick: actionWait.state?.lastTick ?? null,
      }));
      const stale = await waitForSupervisor({
        afterTick: actionWait.state?.tickCount ?? 1,
        intervalMs: 1,
        timeoutMs: 10,
      });
      expect(stale).toMatchObject({
        ready: true,
        reason: "stale",
      });

      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "running",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
        pid: process.pid,
        supervisorId: "not-this-process",
        tickCount: actionWait.state?.tickCount ?? 1,
        lastTick: actionWait.state?.lastTick ?? null,
      }));
      const mismatch = await waitForSupervisor({
        afterTick: 0,
        intervalMs: 1,
        timeoutMs: 10,
      });
      expect(mismatch).toMatchObject({
        ready: true,
        reason: "stale",
        actions: [],
      });

      const cli = await runCli(["supervisor", "wait", "--after-tick", "0", "--interval-ms", "1", "--timeout-ms", "10", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).reason).toBe("stale");

      const badTick = await runCli(["supervisor", "wait", "--after-tick", "--json"], tmp);
      expect(badTick.exitCode).toBe(2);
      expect(JSON.parse(badTick.stderr).error).toEqual({
        code: "invalid_flag",
        message: "--after-tick must be a non-negative integer",
      });
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("runSupervisor keeps tickCount monotonic across restarts for wait cursors", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await mkdir(".codexctl/supervisor", { recursive: true });
      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "stopped",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
        pid: null,
        supervisorId: "previous-supervisor",
        tickCount: 10,
        lastTick: null,
      }));
      await createJob({ key: "supervisor-restart-action", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/supervisor-restart-action/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));

      const state = await runSupervisor({ intervalMs: 1, once: true });
      const result = await waitForSupervisor({ afterTick: 10, intervalMs: 1, timeoutMs: 10 });
      expect(state.tickCount).toBe(11);
      expect(result).toMatchObject({
        ready: true,
        reason: "actions",
        afterTick: 10,
        state: {
          tickCount: 11,
        },
      });
      expect(result.actions.map((action) => action.kind)).toEqual(["inspect_error"]);

      const restarted = await runSupervisor({ intervalMs: 1, maxTicks: 2 });
      expect(restarted.tickCount).toBe(13);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor next starts, waits, and returns an empty action when there is no fresh action", async () => {
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      const cli = await runCli([
        "supervisor",
        "next",
        "--interval-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--max-ticks",
        "1",
        "--json",
      ], tmp);
      if (cli.exitCode !== 0) throw new Error(cli.stderr || cli.stdout);
      expect(cli.exitCode).toBe(0);
      const result = JSON.parse(cli.stdout);
      expect(result.start.action).toBe("started");
      expect(result.wait.ready).toBe(true);
      expect(["tick", "stopped"]).toContain(result.wait.reason);
      expect(result.action).toBeNull();
      expect(result.inspection).toBeNull();
      await waitForSupervisorFixtureStop(tmp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor inbox inspects fresh actions as a severity-ordered batch", async () => {
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      await mkdir(join(tmp, ".codexctl/jobs/supervisor-inbox-failed"), { recursive: true });
      await mkdir(join(tmp, ".codexctl/jobs/supervisor-inbox-stale"), { recursive: true });
      const now = new Date().toISOString();
      const oldHeartbeat = new Date(Date.now() - 31_000).toISOString();
      const baseJob = {
        jobIncarnation: null,
        repo: ".",
        prompt: "hello",
        model: null,
        approvalPolicy: "on-request",
        sandbox: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
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
      await Bun.write(join(tmp, ".codexctl/jobs/supervisor-inbox-failed/job.json"), JSON.stringify({
        ...baseJob,
        key: "supervisor-inbox-failed",
        status: "failed",
        completedAt: now,
        error: "boom",
      }));
      await Bun.write(join(tmp, ".codexctl/jobs/supervisor-inbox-stale/job.json"), JSON.stringify({
        ...baseJob,
        key: "supervisor-inbox-stale",
        status: "running",
        workerPid: process.pid,
        workerHeartbeatAt: oldHeartbeat,
      }));

      const truncated = await runCli([
        "supervisor",
        "inbox",
        "--cursor",
        "batch",
        "--interval-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--limit",
        "1",
        "--json",
      ], tmp);
      expect(truncated.exitCode).toBe(0);
      const truncatedBody = JSON.parse(truncated.stdout);
      expect(truncatedBody.totalActions).toBe(2);
      expect(truncatedBody.hasMore).toBe(true);
      expect(truncatedBody.ack).toBeNull();
      expect(truncatedBody.items).toHaveLength(1);
      const firstStop = await runCli(["supervisor", "stop", "--timeout-ms", "2000", "--json"], tmp);
      expect(firstStop.exitCode).toBe(0);
      await waitForSupervisorFixtureStop(tmp);

      const cli = await runCli([
        "supervisor",
        "inbox",
        "--cursor",
        "batch",
        "--interval-ms",
        "1",
        "--timeout-ms",
        "1000",
        "--limit",
        "2",
        "--json",
      ], tmp);
      expect(cli.exitCode).toBe(0);
      const result = JSON.parse(cli.stdout);
      expect(result.wait.ready).toBe(true);
      expect(result.wait.reason).toBe("actions");
      expect(result.wait.afterTick).toBe(0);
      expect(result.cursor).toMatchObject({ name: "batch", afterTick: 0, updatedAt: null });
      expect(result.totalActions).toBe(2);
      expect(result.hasMore).toBe(false);
      expect(result.ack).toEqual({
        name: "batch",
        tick: result.wait.state.tickCount,
        command: `codexctl supervisor ack batch --tick ${result.wait.state.tickCount} --json`,
      });
      expect(result.items.map((item: { action: { jobKey: string; kind: string; severity: string } }) => ({
        key: item.action.jobKey,
        kind: item.action.kind,
        severity: item.action.severity,
      }))).toEqual([
        { key: "supervisor-inbox-failed", kind: "inspect_error", severity: "critical" },
        { key: "supervisor-inbox-stale", kind: "inspect_stale_worker", severity: "attention" },
      ]);
      expect(result.items[0].inspection.inspection.summary.key).toBe("supervisor-inbox-failed");
      expect(result.items[1].inspection.inspection.summary.key).toBe("supervisor-inbox-stale");
      const ack = await runCli(["supervisor", "ack", "batch", "--tick", String(result.wait.state.tickCount), "--json"], tmp);
      expect(ack.exitCode).toBe(0);
      expect(JSON.parse(ack.stdout).cursor.afterTick).toBe(result.wait.state.tickCount);
      const stop = await runCli(["supervisor", "stop", "--timeout-ms", "2000", "--json"], tmp);
      expect(stop.exitCode).toBe(0);
      await waitForSupervisorFixtureStop(tmp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor ack stores cursors without regression", async () => {
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      const ack = await runCli(["supervisor", "ack", "default", "--tick", "7", "--json"], tmp);
      expect(ack.exitCode).toBe(0);
      expect(JSON.parse(ack.stdout)).toMatchObject({
        previous: { name: "default", afterTick: 0, updatedAt: null },
        cursor: { name: "default", afterTick: 7 },
      });

      const noRegression = await runCli(["supervisor", "ack", "default", "--tick", "3", "--json"], tmp);
      expect(noRegression.exitCode).toBe(0);
      expect(JSON.parse(noRegression.stdout).cursor.afterTick).toBe(7);

      const [highAck, lowAck] = await Promise.all([
        runCli(["supervisor", "ack", "default", "--tick", "10", "--json"], tmp),
        runCli(["supervisor", "ack", "default", "--tick", "4", "--json"], tmp),
      ]);
      expect(highAck.exitCode).toBe(0);
      expect(lowAck.exitCode).toBe(0);
      const finalAck = await runCli(["supervisor", "ack", "default", "--tick", "0", "--json"], tmp);
      expect(finalAck.exitCode).toBe(0);
      expect(JSON.parse(finalAck.stdout).cursor.afterTick).toBe(10);

      const inbox = await runCli([
        "supervisor",
        "inbox",
        "--cursor",
        "default",
        "--interval-ms",
        "1",
        "--timeout-ms",
        "50",
        "--max-ticks",
        "1",
        "--json",
      ], tmp);
      expect(inbox.exitCode).toBe(0);
      const body = JSON.parse(inbox.stdout);
      expect(body.cursor.afterTick).toBe(10);
      expect(body.wait.afterTick).toBe(10);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor start runs detached and stop handles stale state", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      const start = await startSupervisor({ intervalMs: 1, maxTicks: 1 });
      expect(start.action).toBe("started");
      expect(start.pid).toBeGreaterThan(0);
      expect(start.maxTicks).toBe(1);
      expect(start.state?.supervisorId).toEqual(expect.any(String));

      let state = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        await Bun.sleep(50);
        try {
          state = await readSupervisorState();
        } catch {
          state = null;
        }
        if (state?.status === "stopped" && state.tickCount === 1) break;
      }
      expect(state?.status).toBe("stopped");
      expect(state?.tickCount).toBe(1);
      expect(await Bun.file(".codexctl/supervisor/supervisor.log").exists()).toBe(true);
      expect(await Bun.file(".codexctl/supervisor/supervisor.err.log").exists()).toBe(true);

      const longStart = await startSupervisor({ intervalMs: 10_000 });
      expect(longStart.action).toBe("started");
      const immediateStop = await stopSupervisor({ timeoutMs: 2_000 });
      expect(immediateStop.action).toBe("stop_requested");
      expect(immediateStop.pid).toBe(longStart.pid);
      expect(immediateStop.state?.status).toBe("stopped");

      const concurrentStarts = await Promise.all([
        startSupervisor({ intervalMs: 10_000 }),
        startSupervisor({ intervalMs: 10_000 }),
      ]);
      expect(concurrentStarts.map((result) => result.action).sort()).toEqual(["already_running", "started"]);
      expect(new Set(concurrentStarts.map((result) => result.pid)).size).toBe(1);
      const concurrentStop = await stopSupervisor({ timeoutMs: 2_000 });
      expect(concurrentStop.action).toBe("stop_requested");

      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "running",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
        pid: process.pid,
        supervisorId: null,
        tickCount: 0,
        lastTick: null,
      }));
      await expect(startSupervisor({ intervalMs: 1 })).rejects.toThrow("cannot be verified");
      await expect(stopSupervisor({ timeoutMs: 1 })).rejects.toThrow("cannot be verified");
      expect((await readSupervisorState()).status).toBe("running");

      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "running",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
        pid: 999_999_999,
        tickCount: 0,
        lastTick: null,
      }));
      const stop = await stopSupervisor({ timeoutMs: 1 });
      expect(stop.action).toBe("stale_state");
      expect(stop.state?.status).toBe("stopped");

      await Bun.write(".codexctl/supervisor/state.json", JSON.stringify({
        status: "running",
        startedAt: "2026-06-24T00:00:00.000Z",
        updatedAt: "2026-06-24T00:00:00.000Z",
        pid: process.pid,
        supervisorId: "not-this-process",
        tickCount: 0,
        lastTick: null,
      }));
      const liveMismatch = await stopSupervisor({ timeoutMs: 1 });
      expect(liveMismatch.action).toBe("stale_state");
      expect(liveMismatch.signal).toBeNull();

      const cli = await runCli(["supervisor", "stop", "--timeout-ms", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).action).toBe("already_stopped");

      await mkdir(".codexctl/supervisor/lifecycle.lock", { recursive: true });
      await Bun.write(".codexctl/supervisor/lifecycle.lock/owner.json", JSON.stringify({
        token: "old-lock",
        pid: process.pid,
        createdAt: "2026-06-24T00:00:00.000Z",
        heartbeatAt: "2026-06-24T00:00:00.000Z",
      }));
      const lockBreakStart = await startSupervisor({ intervalMs: 1, maxTicks: 1 });
      expect(lockBreakStart.action).toBe("started");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("runSupervisor carries action persistence across ticks", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "persistent-cancel", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/persistent-cancel/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = process.pid;
      job.workerHeartbeatAt = new Date().toISOString();
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));
      await Bun.write(
        ".codexctl/jobs/persistent-cancel/control.jsonl",
        JSON.stringify({ id: "persistent-cancel-command", type: "turn.interrupt", at: new Date().toISOString() }) + "\n",
      );

      const state = await runSupervisor({ intervalMs: 1, maxTicks: 2 });
      expect(state.status).toBe("stopped");
      expect(state.tickCount).toBe(2);
      const lastAction = state.lastTick?.actions.find((action) => action.jobKey === "persistent-cancel");
      expect(lastAction?.kind).toBe("wait_cancel");
      expect(lastAction?.seenTicks).toBe(2);
      expect(typeof lastAction?.firstSeenAt).toBe("string");
      expect(lastAction?.policy).toBeUndefined();

      const tickEvents = (await readSupervisorEvents())
        .filter((event): event is { type: "supervisor.tick"; tick: { at: string; actions: Array<{ firstSeenAt?: string; seenTicks?: number }> } } =>
          (event as { type?: string }).type === "supervisor.tick"
        );
      expect(tickEvents).toHaveLength(2);
      expect(tickEvents[0]?.tick.actions[0]?.seenTicks).toBeUndefined();
      expect(tickEvents[0]?.tick.actions[0]?.firstSeenAt).toBeUndefined();
      expect(tickEvents[1]?.tick.actions[0]?.seenTicks).toBe(2);
      expect(tickEvents[1]?.tick.actions[0]?.firstSeenAt).toBe(tickEvents[0]?.tick.at);

      const history = await readSupervisorActionHistory(1);
      expect(history.tickLimit).toBe(1);
      expect(history.eventsScanned).toBe(2);
      expect(history.tickCount).toBe(1);
      expect(history.latestTickAt).toBe(tickEvents[1]?.tick.at ?? null);
      expect(history.latestActions[0]?.id).toBe("persistent-cancel:wait_cancel");
      expect(history.latestActions[0]?.seenTicks).toBe(2);
      expect(history.ticks[0]?.actions[0]?.seenTicks).toBe(2);

      const cli = await runCli(["supervisor", "actions", "--ticks", "1", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(cli.stderr).toBe("");
      const body = JSON.parse(cli.stdout);
      expect(body.tickCount).toBe(1);
      expect(body.latestActions[0]?.seenTicks).toBe(2);

      const emptyCli = await runCli(["supervisor", "actions", "--ticks", "0", "--json"], tmp);
      expect(emptyCli.exitCode).toBe(0);
      const emptyBody = JSON.parse(emptyCli.stdout);
      expect(emptyBody.tickCount).toBe(0);
      expect(emptyBody.eventsScanned).toBe(0);
      expect(emptyBody.latestActions).toEqual([]);
      expect(emptyBody.ticks).toEqual([]);

      const missingTicks = await runCli(["supervisor", "actions", "--ticks", "--json"], tmp);
      expect(missingTicks.exitCode).toBe(2);
      expect(JSON.parse(missingTicks.stderr)).toEqual({
        ok: false,
        error: {
          code: "invalid_flag",
          message: "--ticks must be a non-negative integer",
        },
      });

      const emptyTicks = await runCli(["supervisor", "actions", "--ticks=", "--json"], tmp);
      expect(emptyTicks.exitCode).toBe(2);
      expect(JSON.parse(emptyTicks.stderr)).toEqual({
        ok: false,
        error: {
          code: "invalid_flag",
          message: "--ticks must be a non-negative integer",
        },
      });

      await Bun.write(
        ".codexctl/supervisor/events.jsonl",
        await Bun.file(".codexctl/supervisor/events.jsonl").text() + JSON.stringify({
          type: "supervisor.tick",
          at: "2026-06-24T00:00:00.000Z",
          tick: {
            at: "2026-06-24T00:00:00.000Z",
            health: state.lastTick?.health,
            actions: [{
              jobKey: "legacy-failed",
              kind: "inspect_error",
              severity: "critical",
              reason: "legacy boom",
              nextCommand: "codexctl job summary legacy-failed --events 20 --json",
            }],
            recovered: [],
          },
        }) + "\n",
      );
      const legacyHistory = await readSupervisorActionHistory(1);
      expect(legacyHistory.latestActions[0]?.id).toMatch(/^legacy-failed:inspect_error:[0-9a-f]{8}$/);

      await Bun.write(
        ".codexctl/supervisor/events.jsonl",
        await Bun.file(".codexctl/supervisor/events.jsonl").text() + "{not-json}\n",
      );
      const corruptTailHistory = await readSupervisorActionHistory(1);
      expect(corruptTailHistory.tickCount).toBe(1);
      expect(corruptTailHistory.latestActions[0]?.id).toMatch(/^legacy-failed:inspect_error:[0-9a-f]{8}$/);
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("runSupervisor keeps action persistence across severity escalation", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    const realDateNow = Date.now;
    try {
      process.chdir(tmp);
      const fixedNow = realDateNow();
      await createJob({ key: "escalating-cancel", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/escalating-cancel/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "running";
      job.workerPid = process.pid;
      job.workerHeartbeatAt = null;
      job.threadId = "thread-1";
      job.turnId = "turn-1";
      await Bun.write(jobPath, JSON.stringify(job));
      await Bun.write(
        ".codexctl/jobs/escalating-cancel/control.jsonl",
        JSON.stringify({ id: "escalating-cancel-command", type: "turn.interrupt", at: new Date(fixedNow - 299_000).toISOString() }) + "\n",
      );

      const nowValues = [fixedNow, fixedNow + 2_000, fixedNow + 3_000, fixedNow + 4_000];
      let nowIndex = 0;
      Date.now = () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? fixedNow;

      const state = await runSupervisor({ intervalMs: 1, maxTicks: 4 });
      const action = state.lastTick?.actions.find((candidate) => candidate.jobKey === "escalating-cancel" && candidate.kind === "wait_cancel");
      expect(action?.severity).toBe("critical");
      expect(action?.seenTicks).toBe(4);
      expect(action?.criticalSeenTicks).toBe(3);
      expect(typeof action?.firstSeenAt).toBe("string");
      expect(action?.policy).toEqual({
        recommendation: "escalate",
        reason: "critical recommendation persisted for 3 critical ticks",
        basedOn: ["severity", "persistence"],
        thresholdTicks: 3,
      });

      const tickEvents = (await readSupervisorEvents())
        .filter((event): event is { type: "supervisor.tick"; tick: { actions: Array<{ jobKey?: string; kind?: string; severity?: string; seenTicks?: number; criticalSeenTicks?: number; policy?: { recommendation?: string } }> } } =>
          (event as { type?: string }).type === "supervisor.tick"
        );
      const firstWait = tickEvents[0]?.tick.actions.find((candidate) => candidate.jobKey === "escalating-cancel" && candidate.kind === "wait_cancel");
      const secondWait = tickEvents[1]?.tick.actions.find((candidate) => candidate.jobKey === "escalating-cancel" && candidate.kind === "wait_cancel");
      const thirdWait = tickEvents[2]?.tick.actions.find((candidate) => candidate.jobKey === "escalating-cancel" && candidate.kind === "wait_cancel");
      const fourthWait = tickEvents[3]?.tick.actions.find((candidate) => candidate.jobKey === "escalating-cancel" && candidate.kind === "wait_cancel");
      expect(firstWait?.severity).toBe("attention");
      expect(firstWait?.seenTicks).toBeUndefined();
      expect(secondWait?.severity).toBe("critical");
      expect(secondWait?.seenTicks).toBe(2);
      expect(secondWait?.criticalSeenTicks).toBe(1);
      expect(secondWait?.policy?.recommendation).toBe("inspect");
      expect(thirdWait?.severity).toBe("critical");
      expect(thirdWait?.seenTicks).toBe(3);
      expect(thirdWait?.criticalSeenTicks).toBe(2);
      expect(thirdWait?.policy?.recommendation).toBe("inspect");
      expect(fourthWait?.severity).toBe("critical");
      expect(fourthWait?.seenTicks).toBe(4);
      expect(fourthWait?.criticalSeenTicks).toBe(3);
      expect(fourthWait?.policy?.recommendation).toBe("escalate");
    } finally {
      Date.now = realDateNow;
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("job key contract", () => {
  test("accepts agent-safe keys", () => {
    expect(() => assertJobKey("dogfood-review_1.2")).not.toThrow();
  });

  test("rejects traversal and empty keys", () => {
    expect(() => assertJobKey("../oops")).toThrow();
    expect(() => assertJobKey("")).toThrow();
  });
});
