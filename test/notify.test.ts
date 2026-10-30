import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createJob, readJob, readJobEvents, runJob, enqueueApprovalDecision } from "../src/job.ts";
import { sendJobNotification } from "../src/notify.ts";
import { jobDir } from "../src/state.ts";

const root = join(import.meta.dir, "..");
const cli = join(root, "src/cli.ts");
let tmp: string;
let savedEnv: NodeJS.ProcessEnv;
let server: ReturnType<typeof Bun.serve>;
let received: Array<{ auth: string | null; contentType: string | null; body: any }>;

beforeEach(async () => {
  savedEnv = { ...process.env };
  tmp = await mkdtemp(join(import.meta.dir, "tmp-notify-"));
  process.env.CODEXCTL_STATE_DIR = join(tmp, "state");
  delete process.env.CODEXCTL_WORKER_ID;
  received = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push({ auth: request.headers.get("authorization"), contentType: request.headers.get("content-type"), body: await request.json() });
    return new Response("ok");
  } });
  process.env.CODEXCTL_GROK_BOT_NOTIFY_URL = `http://127.0.0.1:${server.port}/private-webhook`;
  process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY = "test-notification-secret";
  await mkdir(join(tmp, "bin"));
  await Bun.write(join(tmp, "bin/codex"), `#!${process.execPath}
const send = (message) => console.log(JSON.stringify(message));
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({id:m.id,result:{}});
  if (m.method === "thread/start") send({id:m.id,result:{thread:{id:"thread-test"}}});
  if (m.method === "turn/start") {
    send({id:m.id,result:{turn:{id:"turn-test"}}});
    if (process.env.TEST_MODE === "crash") process.exit(1);
    if (process.env.TEST_MODE === "approval") {
      for (const id of [91, 91, 92]) send({id,method:"item/commandExecution/requestApproval",params:{availableDecisions:["accept","decline"]}});
    } else finish();
  }
  if (m.id === 92 && m.result) finish();
}
function finish() {
  send({method:"item/completed",params:{item:{type:"agentMessage",phase:"final_answer",text:"完了😀".repeat(900)}}});
  for (let i=0;i<2;i++) send({method:"turn/completed",params:{turn:{status:process.env.TEST_MODE || "completed"}}});
}
`);
  await chmod(join(tmp, "bin/codex"), 0o755);
  process.env.PATH = `${join(tmp, "bin")}:${savedEnv.PATH}`;
  delete process.env.TEST_MODE;
});

afterEach(async () => {
  server.stop(true);
  process.env = savedEnv;
  await rm(tmp, { recursive: true, force: true });
});

async function waitExited(key: string) {
  for (let i = 0; i < 400; i++) {
    const events = await readJobEvents(key) as any[];
    if (events.some(e => e.event?.type === "worker.exited")) return;
    await Bun.sleep(25);
  }
  throw new Error("worker did not exit");
}

async function start(key = "demo") {
  return runJob({ key, repo: root, prompt: "fixture only", timeoutMs: 3000, intervalMs: 10 });
}

async function assertPrivate(key = "demo") {
  for (const file of ["job.json", "events.jsonl", "worker.log", "worker.err.log"]) {
    const text = await Bun.file(join(jobDir(key), file)).text();
    expect(text).not.toContain(process.env.CODEXCTL_GROK_BOT_NOTIFY_URL!);
    expect(text).not.toContain(process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY!);
  }
}

for (const [mode, status] of [["completed", "completed"], ["failed", "failed"], ["interrupted", "cancelled"], ["crash", "failed"]] as const) {
  test(`detached worker sends exactly once: ${mode}`, async () => {
    process.env.TEST_MODE = mode;
    await start();
    await waitExited("demo");
    expect((await readJob("demo")).status).toBe(status);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ auth: "Bearer test-notification-secret", contentType: "application/json", body: {
      source: "codexctl", event: `job.${status}`, key: "demo", status, repo: root, threadId: "thread-test",
    } });
    expect(received[0]!.body).not.toHaveProperty("approvalId");
    expect(Array.from(received[0]!.body.finalResponse).length).toBeLessThanOrEqual(2000);
    expect(Number.isNaN(Date.parse(received[0]!.body.at))).toBe(false);
    await assertPrivate();
  });
}

test("approval IDs notify once each, before completion", async () => {
  process.env.TEST_MODE = "approval";
  await start();
  for (let i = 0; i < 100 && received.length < 2; i++) await Bun.sleep(20);
  expect(received.map(r => r.body.approvalId)).toEqual(["91", "92"]);
  expect(received.every(r => r.body.event === "approval.requested" && r.body.status === "running" && r.auth === "Bearer test-notification-secret")).toBe(true);
  await enqueueApprovalDecision("demo", "91", "approve");
  await enqueueApprovalDecision("demo", "92", "approve");
  await waitExited("demo");
  expect(received.map(r => r.body.event)).toEqual(["approval.requested", "approval.requested", "job.completed"]);
  await assertPrivate();
});

test("unset URL skips automatic notification and manual command returns JSON error", async () => {
  delete process.env.CODEXCTL_GROK_BOT_NOTIFY_URL;
  await start();
  await waitExited("demo");
  expect(received).toHaveLength(0);
  expect(JSON.stringify(await readJobEvents("demo"))).not.toContain("notify.");
  const result = await manual();
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.stderr).error.code).toBe("notify_not_configured");
});

async function manual() {
  const proc = Bun.spawn([process.execPath, cli, "job", "notify", "demo", "--json"], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test("manual status notification does not change the job", async () => {
  await createJob({ key: "demo", repo: root, prompt: "fixture" });
  const before = await readJob("demo");
  const result = await manual();
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  expect(received).toHaveLength(1);
  expect(received[0]!.body.event).toBe("job.status");
  expect(await readJob("demo")).toEqual(before);
  await assertPrivate();
});

test("unreachable endpoint preserves completed state and records only an error type", async () => {
  server.stop(true);
  await start();
  await waitExited("demo");
  expect((await readJob("demo")).status).toBe("completed");
  const failures = (await readJobEvents("demo") as any[]).filter(e => e.event?.type === "notify.failed");
  expect(failures.map(e => e.event)).toEqual([{ type: "notify.failed", errorType: "request_error" }]);
  await assertPrivate();
});

for (const status of [302, 401, 500]) {
  test(`HTTP ${status} does not retry or follow redirects`, async () => {
    let count = 0;
    server.reload({ fetch() { count++; return new Response("private response", { status, headers: { Location: "/redirect" } }); } });
    await start();
    await waitExited("demo");
    expect(count).toBe(1);
    expect((await readJob("demo")).status).toBe("completed");
    expect((await readJobEvents("demo") as any[]).filter(e => e.event?.type === "notify.failed").map(e => e.event)).toEqual([{ type: "notify.failed", httpStatus: status }]);
    await assertPrivate();
  });
}

test("missing key fails without sending; known notification secrets are redacted", async () => {
  const job = await createJob({ key: "demo", repo: root, prompt: "fixture" });
  job.finalResponse = `${process.env.CODEXCTL_GROK_BOT_NOTIFY_URL} ${process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY} ${"😀".repeat(2100)}`;
  expect(await sendJobNotification(jobDir("demo"), job, "job.status")).toEqual({ ok: true });
  expect(received[0]!.body.finalResponse.startsWith("[REDACTED] [REDACTED]")).toBe(true);
  expect(Array.from(received[0]!.body.finalResponse)).toHaveLength(2000);
  delete process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY;
  expect(await sendJobNotification(jobDir("demo"), job, "job.status")).toMatchObject({ ok: false, error: { message: "missing_key" } });
  expect(received).toHaveLength(1);
});

test("request times out after ten seconds without changing the job", async () => {
  server.reload({ fetch: () => new Promise<Response>(() => {}) });
  const job = await createJob({ key: "demo", repo: root, prompt: "fixture" });
  const started = Date.now();
  expect(await sendJobNotification(jobDir("demo"), job, "job.status")).toMatchObject({ ok: false, error: { message: "timeout" } });
  expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
  expect(Date.now() - started).toBeLessThan(12000);
  expect(await readJob("demo")).toEqual(job);
  await assertPrivate();
}, 15000);
