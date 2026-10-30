import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { assertJobKey } from "../src/app-server.ts";
import { parseArgs } from "../src/cli.ts";
import { isApprovalRequest } from "../src/events.ts";
import { codexctlHome, stateRoot } from "../src/state.ts";
import {
  approvalResponseFor,
  cancelJob,
  cancelJobAndWait,
  createJob,
  enqueueApprovalDecisionAndWait,
  enqueueApprovalDecision,
  enqueueSteer,
  enqueueSteerAndWait,
  listJobs,
  readApprovals,
  readJobEvents,
  readJobSummary,
  readNewEventLines,
  removeJob,
  waitForJob,
} from "../src/job.ts";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const repoRoot = join(import.meta.dir, "..");

beforeEach(() => {
  process.env.CODEXCTL_STATE_DIR = ".codexctl";
  delete process.env.CODEXCTL_STATE_REPO;
  process.chdir(repoRoot);
});

async function runCli(args: string[], cwd = import.meta.dir): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: process.env,
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
  test("default state root lives under ~/.codexctl by repo identity", () => {
    const previousStateDir = process.env.CODEXCTL_STATE_DIR;
    const previousHome = process.env.CODEXCTL_HOME;
    try {
      delete process.env.CODEXCTL_STATE_DIR;
      process.env.CODEXCTL_HOME = "/tmp/codexctl-home-test";
      expect(codexctlHome()).toBe("/tmp/codexctl-home-test");
      expect(stateRoot("/tmp/example-repo").startsWith("/tmp/codexctl-home-test/repos/example-repo-")).toBe(true);
    } finally {
      if (previousStateDir === undefined) delete process.env.CODEXCTL_STATE_DIR;
      else process.env.CODEXCTL_STATE_DIR = previousStateDir;
      if (previousHome === undefined) delete process.env.CODEXCTL_HOME;
      else process.env.CODEXCTL_HOME = previousHome;
    }
  });

  test("inline flags preserve equals in values", () => {
    const args = parseArgs(["job", "run", "--key=inline-equals", "--prompt=a=b"]);
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
    const result = await runCli(["job", "run", "--key=missing-prompt", "--json"]);
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
        message: "--format must be raw",
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
    expect(result.stdout).toContain("codexctl job run");
  });

  test("help supports --json", async () => {
    const result = await runCli(["--help", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).usage).toContain("codexctl job run");
  });
});

describe("raw job events", () => {

  test("job events can be emitted as raw JSONL", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "raw-events", repo: ".", prompt: "hello" });
      await Bun.write(".codexctl/jobs/raw-events/events.jsonl", [
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
      const result = await runCli(["job", "events", "raw-events", "--format", "raw", "--json"], tmp);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(await Bun.file(".codexctl/jobs/raw-events/events.jsonl").text());
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("job summary returns final response, approvals, and recent raw events", async () => {
    const cwd = process.cwd();
    const tmp = await mkdtemp(join(import.meta.dir, "tmp-"));
    try {
      process.chdir(tmp);
      await createJob({ key: "summary-test", repo: ".", prompt: "hello" });
      const jobPath = ".codexctl/jobs/summary-test/job.json";
      const job = await Bun.file(jobPath).json();
      job.status = "completed";
      job.workerPid = process.pid;
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
      expect(summary.finalResponse).toBe("done");
      expect(summary.pendingApprovals).toHaveLength(1);
      expect(summary.actionableApprovals).toHaveLength(0);
      expect(summary.canResolveApprovals).toBe(false);
      expect(summary.approvalCounts.pending).toBe(1);
      expect(summary.recentEvents).toEqual((await readJobEvents("summary-test")).slice(-1));

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
  test("detects current and legacy approval requests", () => {
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]) expect(isApprovalRequest(method)).toBe(true);
    expect(isApprovalRequest("turn/completed")).toBe(false);
  });

  test("relays offered decisions without synthesizing policy amendments", () => {
    const approval = {
      id: "1", serverRequestId: 1,
      method: "item/commandExecution/requestApproval",
      params: { proposedExecpolicyAmendment: ["echo"] } as Record<string, unknown>,
      status: "pending" as const, createdAt: "2026-10-30T00:00:00Z",
      resolvedAt: null, decision: null, error: null,
    };
    expect(approvalResponseFor(approval, "approveForSession")).toEqual({
      supported: true, response: { decision: "acceptForSession" },
    });
    const offered = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } };
    approval.params.availableDecisions = ["accept", offered, "decline"];
    expect(approvalResponseFor(approval, "approveForSession")).toEqual({
      supported: true, response: { decision: offered },
    });
    for (const method of ["execCommandApproval", "applyPatchApproval"]) {
      expect(approvalResponseFor({ ...approval, method }, "approve")).toEqual({
        supported: true, response: { decision: "approved" },
      });
      expect(approvalResponseFor({ ...approval, method }, "reject")).toEqual({
        supported: true, response: { decision: "denied" },
      });
    }
  });

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
      const persistedSummary = await readJobSummary("cancel-running-test", 0);
      expect(persistedSummary.nextAction).toBe("wait_cancel");
      expect(persistedSummary.cancelRequestedAt).toBe(result.command?.at);
      expect(persistedSummary.cancelCommandId).toBe(result.command?.id);
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

  test("listJobs summarizes jobs", async () => {
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
      stale.threadId = "thread-1";
      stale.turnId = "turn-1";
      await Bun.write(stalePath, JSON.stringify(stale));

      const jobs = await listJobs();
      expect(jobs.map((job) => job.key).sort()).toEqual(["completed-job", "legacy-job", "stale-job"]);
      expect(jobs.find((job) => job.key === "completed-job")?.pendingApprovals).toBe(1);
      expect(jobs.find((job) => job.key === "completed-job")?.actionableApprovals).toBe(0);
      expect(jobs.find((job) => job.key === "completed-job")?.nextAction).toBe("read_result");
      expect(jobs.find((job) => job.key === "legacy-job")?.pendingApprovals).toBe(0);
      expect(jobs.find((job) => job.key === "stale-job")?.workerAlive).toBe(false);

    } finally {
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
