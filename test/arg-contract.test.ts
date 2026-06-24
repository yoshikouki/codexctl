import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertJobKey } from "../src/app-server.ts";
import { parseArgs } from "../src/cli.ts";
import { compactJobEvent } from "../src/events.ts";
import {
  approvalResponseFor,
  cancelJob,
  createJob,
  enqueueApprovalDecision,
  enqueueSteer,
  listJobs,
  readApprovals,
  readJobEvents,
  readJobSummary,
  readNewEventLines,
  removeJob,
  pruneJobs,
  recoverJob,
  sweepJobs,
} from "../src/job.ts";
import { planSupervisorActions, readSupervisorActionHistory, readSupervisorEvents, readSupervisorState, runSupervisor } from "../src/supervisor.ts";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

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
      job.workerPid = process.pid;
      job.workerHeartbeatAt = "1970-01-01T00:00:00.000Z";
      await Bun.write(jobPath, JSON.stringify(job));
      const freshHeartbeat = new Date().toISOString();
      await Bun.write(".codexctl/jobs/status-health-test/worker-heartbeat.json", JSON.stringify({
        workerPid: process.pid,
        workerHeartbeatAt: freshHeartbeat,
      }));
      await Bun.write(".codexctl/jobs/status-health-test/events.jsonl", "{not-json}\n");

      const status = await runCli(["job", "status", "status-health-test", "--json"], tmp);
      expect(status.exitCode).toBe(0);
      const body = JSON.parse(status.stdout);
      expect(body.workerHeartbeatAt).toBe(freshHeartbeat);
      expect(body.workerHealth.heartbeatAt).toBe(freshHeartbeat);
      expect(body.workerHealth.alive).toBe(true);
      expect(body.workerHealth.reason).toBe("alive_recent");
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
      expect(staleAction?.kind).toBe("inspect_stale_worker");
      expect(staleAction?.severity).toBe("critical");
      expect(staleAction?.thresholdMs).toBe(5 * 60_000);
      expect(staleAction?.policy?.recommendation).toBe("inspect");
      const missingHeartbeatAction = plan.actions.find((action) => action.jobKey === "missing-heartbeat-plan");
      expect(missingHeartbeatAction?.kind).toBe("inspect_stale_worker");
      expect(missingHeartbeatAction?.severity).toBe("attention");
      expect(missingHeartbeatAction?.ageMs).toBeNull();
      expect(missingHeartbeatAction?.thresholdMs).toBe(5 * 60_000);
      expect(plan.actions.find((action) => action.kind === "inspect_dead_worker")?.nextCommand).toBe("codexctl job summary dead-plan --events 20 --json");
      expect(plan.actions.find((action) => action.kind === "inspect_unreadable")?.severity).toBe("critical");

      const cli = await runCli(["supervisor", "plan", "--json"], tmp);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).actions).toHaveLength(10);
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
        await Bun.file(".codexctl/supervisor/events.jsonl").text() + "{not-json}\n",
      );
      const corruptTailHistory = await readSupervisorActionHistory(1);
      expect(corruptTailHistory.tickCount).toBe(1);
      expect(corruptTailHistory.latestActions[0]?.seenTicks).toBe(2);
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
