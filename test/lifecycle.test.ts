import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createJob, readJob, readJobEvents, runJobWorker } from "../src/job.ts";
import { jobDir } from "../src/state.ts";

const cliPath = join(import.meta.dir, "../src/cli.ts");
let tmp: string;
let env: NodeJS.ProcessEnv;
let server: ReturnType<typeof Bun.serve>;
let notifications: any[];
beforeEach(async () => {
  env = { ...process.env };
  tmp = await realpath(await mkdtemp("/tmp/codexctl-lifecycle-"));
  for (const name of ["a", "b", "bin"]) await mkdir(join(tmp, name));
  process.env.CODEXCTL_HOME = join(tmp, "state");
  delete process.env.CODEXCTL_RESUME_COMMAND_ID;
  notifications = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    notifications.push(await req.json());
    // Keep the terminal worker alive while a resume is submitted.
    await Bun.sleep(150);
    return new Response("ok");
  } });
  process.env.CODEXCTL_GROK_BOT_NOTIFY_URL = `http://127.0.0.1:${server.port}`;
  process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY = "fixture";
  process.env.TEST_RELEASE = join(tmp, "release");
  await Bun.write(join(tmp, "bin/codex"), `#!${process.execPath}
const send = m => console.log(JSON.stringify(m));
let turnId;
let finished = false;
function finish(status = "completed") {
  if (finished) return;
  finished = true;
  send({method:"item/completed",params:{item:{type:"agentMessage",phase:"final_answer",text:"OK"}}});
  send({method:"turn/completed",params:{turn:{id:turnId,status}}});
}
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({id:m.id,result:{}});
  if (m.method === "thread/start" || m.method === "thread/resume") send({id:m.id,result:{thread:{id:m.params.threadId ?? "same-thread"}}});
  if (m.method === "turn/start") {
    turnId = crypto.randomUUID();
    send({id:m.id,result:{turn:{id:turnId}}});
    send({method:"item/started",params:{item:{type:"agentMessage",phase:"commentary"}}});
    send({method:"item/agentMessage/delta",params:{delta:"😀".repeat(2100)}});
    const timer = setInterval(async () => {
      if (await Bun.file(process.env.TEST_RELEASE).exists()) { clearInterval(timer); finish(process.env.TEST_STATUS); }
    }, 20);
  }
  if (m.method === "turn/steer") send({id:m.id,result:{}});
  if (m.method === "turn/interrupt") { send({id:m.id,result:{}}); finish("interrupted"); }
}
`);
  await chmod(join(tmp, "bin/codex"), 0o755);
  process.env.PATH = `${join(tmp, "bin")}:${env.PATH}`;
  delete process.env.TEST_STATUS;
});
afterEach(async () => {
  await Bun.write(process.env.TEST_RELEASE!, "");
  try {
    const job = await readJob("demo");
    if (job.workerPid && job.workerPid !== process.pid) {
      await until(async () => {
        try { process.kill(job.workerPid!, 0); return false; } catch { return true; }
      });
    }
  } finally {
    server.stop(true);
  }
  process.env = env;
  await rm(tmp, { recursive: true, force: true });
});
async function cli(args: string[], cwd = "b") {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], { cwd: join(tmp, cwd), env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, value: JSON.parse(out || err) };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await Bun.sleep(20); }
  throw new Error("fixture timed out");
}
async function exited(count = 1) {
  await until(async () => (await readJobEvents("demo") as any[]).filter(e => e.event?.type === "worker.exited").length === count);
}
async function start() {
  const result = await cli(["job", "run", "--key", "demo", "--repo", ".", "--prompt", "fixture"], "a");
  expect(result.code).toBe(0);
  expect(result.value.status).toBe("queued");
  await until(async () => (await readJob("demo")).latestAgentMessage.length > 0);
}

test("run detaches; global state, JSON summary, notify and live steer work across cwd", async () => {
  const started = Date.now();
  await start();
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await Bun.file(join(tmp, "state/jobs/demo/job.json")).exists()).toBe(true);
  const summary = await cli(["job", "summary", "demo"]);
  expect(summary.value.repo).toBe(join(tmp, "a"));
  expect(summary.value.status).toBe("running");
  expect(Array.from(summary.value.latestAgentMessage)).toHaveLength(2000);
  expect(summary.value.finalResponse).toBe("");
  expect(summary.value.recentEvents).toHaveLength(5);
  expect(Object.keys(summary.value).sort()).toEqual(["key", "status", "repo", "threadId", "turnId", "createdAt", "startedAt", "completedAt", "pendingApprovals", "latestAgentMessage", "finalResponse", "error", "recentEvents"].sort());
  expect((await cli(["job", "notify", "demo"])).code).toBe(0);
  expect((await cli(["job", "steer", "demo", "--prompt", "adjust"])).code).toBe(0);
  await until(async () => (await readJobEvents("demo") as any[]).some(e => e.message?.method === "turn/steer"));
  const duplicate = await cli(["job", "run", "--key", "demo", "--prompt", "duplicate"]);
  expect(duplicate.code).not.toBe(0);
  await Bun.write(process.env.TEST_RELEASE!, "");
  await exited();
  expect((await cli(["job", "summary", "demo", "--json=false"])).value.finalResponse).toBe("OK");
});

for (const [serverStatus, status] of [["completed", "completed"], ["failed", "failed"], ["interrupted", "cancelled"]]) {
  test(`steer resumes ${status} on same thread, waits for new turn and notifies again`, async () => {
    process.env.TEST_STATUS = serverStatus;
    await start();
    await cli(["job", "steer", "demo", "--prompt", "old 日本語"]);
    await until(async () => (await readJobEvents("demo") as any[]).some(e => e.message?.method === "turn/steer"));
    await Bun.write(process.env.TEST_RELEASE!, "");
    await until(async () => (await readJob("demo")).status === status);
    const previous = await readJob("demo");
    delete process.env.TEST_STATUS;
    const resumed = status === "completed"
      ? await cli(["job", "steer", "demo", "--prompt", "new 日本語", "--wait", "--interval-ms", "10", "--timeout-ms", "4000"])
      : await (async () => {
        expect((await cli(["job", "steer", "demo", "--prompt", "new 日本語"])).code).toBe(0);
        const result = await cli(["job", "wait", "demo", "--interval-ms", "10", "--timeout-ms", "4000"]);
        return { code: result.code, value: { wait: result.value } };
      })();
    expect(resumed.code).toBe(0);
    expect(resumed.value.wait.reason).toBe("terminal");
    expect(resumed.value.wait.status).toBe("completed");
    expect(resumed.value.wait.summary.turnId).not.toBe(previous.turnId);
    expect(resumed.value.wait.summary.threadId).toBe(previous.threadId);
    await exited(2);
    const requests = (await readJobEvents("demo") as any[]).filter(e => e.direction === "client" && e.message?.method).map(e => e.message);
    expect(requests.filter(m => m.method === "thread/start")).toHaveLength(1);
    expect(requests.filter(m => m.method === "thread/resume").map(m => m.params)).toEqual([{ threadId: "same-thread", cwd: join(tmp, "a") }]);
    expect(requests.filter(m => m.method === "turn/start").map(m => m.params.input[0].text)).toEqual(["fixture", "new 日本語"]);
    expect(requests.filter(m => m.method === "turn/steer")).toHaveLength(1);
    expect(notifications.map(n => n.event)).toEqual([`job.${status}`, "job.completed"]);
  });
}

test("CLI control commands leave job.json byte-for-byte unchanged", async () => {
  const record = await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  record.status = "running";
  record.approvals = [{ id: "1", serverRequestId: 1, method: "item/commandExecution/requestApproval", params: {}, status: "pending", createdAt: record.createdAt, resolvedAt: null, decision: null, error: null }];
  await Bun.write(join(jobDir("demo"), "job.json"), JSON.stringify(record));
  const before = await Bun.file(join(jobDir("demo"), "job.json")).text();
  for (const args of [["job", "steer", "demo", "--prompt", "adjust"], ["job", "cancel", "demo"], ["approval", "approve", "demo", "1"], ["job", "notify", "demo"]]) {
    expect((await cli(args)).code).toBe(0);
    expect(await Bun.file(join(jobDir("demo"), "job.json")).text()).toBe(before);
  }
  expect((await Bun.file(join(jobDir("demo"), "control.jsonl")).text()).trim().split("\n")).toHaveLength(3);
});

test("queued cancel is written only by worker and starts no app-server", async () => {
  const record = await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  await cli(["job", "cancel", "demo"]);
  expect((await readJob("demo")).status).toBe("queued");
  expect((await runJobWorker("demo")).status).toBe("cancelled");
  expect((await readJobEvents("demo") as any[]).some(e => e.direction === "client")).toBe(false);
  expect(notifications.map(n => n.event)).toEqual(["job.cancelled"]);
});

test("cancelled turn resumes without replaying its interrupt", async () => {
  await start();
  const cancelled = await cli(["job", "cancel", "demo", "--wait", "--interval-ms", "10", "--timeout-ms", "4000"]);
  expect(cancelled.value.wait.status).toBe("cancelled");
  const before = await readJob("demo");
  await Bun.write(process.env.TEST_RELEASE!, "");
  const resumed = await cli(["job", "steer", "demo", "--prompt", "continue", "--wait", "--interval-ms", "10", "--timeout-ms", "4000"]);
  expect(resumed.value.wait.status).toBe("completed");
  expect(resumed.value.wait.summary.turnId).not.toBe(before.turnId);
  await exited(2);
  const job = await readJob("demo");
  expect(job.cancelRequestedAt).toBeNull();
  expect(job.cancelCommandId).toBeNull();
  const interrupts = (await readJobEvents("demo") as any[]).filter(e => e.direction === "client" && e.message?.method === "turn/interrupt");
  expect(interrupts).toHaveLength(1);
  expect(notifications.map(n => n.event)).toEqual(["job.cancelled", "job.completed"]);
});

test("terminal job without a thread returns a JSON error without modifying state", async () => {
  const record = await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  record.status = "failed";
  const path = join(jobDir("demo"), "job.json");
  await Bun.write(path, JSON.stringify(record));
  const before = await Bun.file(path).text();
  const result = await cli(["job", "steer", "demo", "--prompt", "continue"]);
  expect(result.code).not.toBe(0);
  expect(result.value.error.message).toContain("no threadId");
  expect(await Bun.file(path).text()).toBe(before);
  expect(await Bun.file(join(jobDir("demo"), "control.jsonl")).text()).toBe("");
});

test("old repository state and state override variables are ignored", async () => {
  const oldDir = join(tmp, "state/repos/old/jobs/old");
  await mkdir(oldDir, { recursive: true });
  await Bun.write(join(oldDir, "job.json"), JSON.stringify({ key: "old", status: "completed" }));
  process.env.CODEXCTL_STATE_DIR = join(tmp, "other-state");
  process.env.CODEXCTL_STATE_REPO = join(tmp, "a");
  expect((await cli(["job", "list"])).value).toEqual([]);
  expect((await cli(["job", "summary", "old"])).code).not.toBe(0);
  await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  expect((await cli(["job", "summary", "demo"])).code).toBe(0);
  expect(await Bun.file(join(oldDir, "job.json")).json()).toEqual({ key: "old", status: "completed" });
});
