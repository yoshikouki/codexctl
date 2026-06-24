import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertJobKey } from "../src/app-server.ts";
import { parseArgs } from "../src/cli.ts";
import { compactJobEvent } from "../src/events.ts";
import {
  approvalResponseFor,
  createJob,
  enqueueApprovalDecision,
  enqueueSteer,
  listJobs,
  readApprovals,
  readJobEvents,
  readNewEventLines,
  recoverJob,
  sweepJobs,
} from "../src/job.ts";
import { readSupervisorEvents, readSupervisorState, runSupervisor } from "../src/supervisor.ts";

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
      stale.threadId = "thread-1";
      stale.turnId = "turn-1";
      await Bun.write(stalePath, JSON.stringify(stale));

      const jobs = await listJobs();
      expect(jobs.map((job) => job.key).sort()).toEqual(["completed-job", "legacy-job", "stale-job"]);
      expect(jobs.find((job) => job.key === "completed-job")?.pendingApprovals).toBe(1);
      expect(jobs.find((job) => job.key === "legacy-job")?.pendingApprovals).toBe(0);

      const sweep = await sweepJobs();
      expect(sweep).toHaveLength(1);
      expect(sweep[0]?.job.key).toBe("stale-job");
      expect(sweep[0]?.action).toBe("failed");
    } finally {
      process.chdir(cwd);
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("supervisor", () => {
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
      expect((await readSupervisorState()).tickCount).toBe(1);
      expect(await Bun.file(".codexctl/supervisor/state.json").exists()).toBe(true);
      expect((await readSupervisorEvents()).map((event) => (event as { type?: string }).type)).toContain("supervisor.tick");
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
