import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertJobKey } from "../src/app-server.ts";
import { createJob, enqueueApprovalDecision, enqueueSteer, readApprovals, readJobEvents } from "../src/job.ts";

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
