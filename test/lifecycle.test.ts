import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createJob,
  enqueueSteer,
  readJob,
  readJobEvents,
  readJobSummary,
  runJobWorker,
} from "../src/job.ts";
import { jobDir } from "../src/state.ts";

interface RecordedEvent {
  direction: string;
  at: string;
  event?: Record<string, unknown>;
  message?: {
    method?: string;
    params?: Record<string, unknown> & {
      item?: { id?: string };
      input?: Array<{ text: string }>;
    };
    result?: { batch?: string };
  };
}

const cliPath = join(import.meta.dir, "../src/cli.ts");
let tmp: string;
let env: NodeJS.ProcessEnv;
let server: ReturnType<typeof Bun.serve>;
let notifications: Array<{ event: string }>;
beforeEach(async () => {
  env = { ...process.env };
  tmp = await realpath(await mkdtemp("/tmp/codexctl-lifecycle-"));
  await Promise.all(["a", "b", "bin"].map((name) => mkdir(join(tmp, name))));
  process.env.HOME = tmp;
  process.env.CODEXCTL_HOME = join(tmp, "state");
  delete process.env.CODEXCTL_RESUME_COMMAND_ID;
  notifications = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      notifications.push((await req.json()) as { event: string });
      // Keep the terminal worker alive while a resume is submitted.
      await Bun.sleep(150);
      return new Response("ok");
    },
  });
  process.env.CODEXCTL_GROK_BOT_NOTIFY_URL = `http://127.0.0.1:${server.port}`;
  process.env.CODEXCTL_GROK_BOT_NOTIFY_KEY = "fixture";
  process.env.TEST_RELEASE = join(tmp, "release");
  await Bun.write(
    join(tmp, "bin/codex"),
    `#!${process.execPath}
const send = m => console.log(JSON.stringify(m));
let turnId;
let finished = false;
function finish(status = "completed") {
  if (finished) return;
  finished = true;
  send({method:"item/completed",params:{item:{id:"finish-command",type:"commandExecution",status:"completed",exitCode:0}}});
  send({method:"item/completed",params:{item:{type:"agentMessage",phase:"final_answer",text:"OK"}}});
  send({method:"turn/completed",params:{turn:{id:turnId,status}}});
}
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({id:m.id,result:{}});
  if (m.method === "test/malformed-json") console.log("{");
  if (m.method === "thread/start" || m.method === "thread/resume") send({id:m.id,result:{thread:{id:m.params.threadId ?? "same-thread"}}});
  if (m.method === "turn/start") {
    turnId = crypto.randomUUID();
    send({id:m.id,result:{turn:{id:turnId}}});
    send({method:"item/started",params:{item:{id:"commentary",type:"agentMessage",phase:"commentary"}}});
    send({method:"item/agentMessage/delta",params:{delta:"😀".repeat(2100)}});
    const timer = setInterval(async () => {
      if (await Bun.file(process.env.TEST_RELEASE).exists()) { clearInterval(timer); finish(process.env.TEST_STATUS); }
    }, 20);
  }
  if (m.method === "turn/steer") {
    const text = m.params!.input![0]!.text;
    if (text.startsWith("test-events:")) {
      const batch = JSON.parse(text.slice("test-events:".length));
      for (const event of batch.events) send(event);
      send({id:m.id,result:{batch:batch.id}});
    } else send({id:m.id,result:{}});
  }
  if (m.method === "turn/interrupt") { send({id:m.id,result:{}}); finish("interrupted"); }
}
`
  );
  await chmod(join(tmp, "bin/codex"), 0o755);
  process.env.PATH = `${join(tmp, "bin")}:${env.PATH}`;
  delete process.env.TEST_STATUS;
});
afterEach(async () => {
  await Bun.write(process.env.TEST_RELEASE!, "");
  try {
    const job = await readJob("demo");
    if (job.workerPid && job.workerPid !== process.pid) {
      await until(() => {
        try {
          process.kill(job.workerPid!, 0);
          return false;
        } catch {
          return true;
        }
      });
    }
  } finally {
    server.stop(true);
  }
  process.env = env;
  await rm(tmp, { recursive: true, force: true });
});
async function cli(args: string[], cwd = "b") {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: join(tmp, cwd),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, value: JSON.parse(out || err) };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 250; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Poll until the worker reaches the expected state before continuing the test.
    if (await check()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("fixture timed out");
}
async function exited(count = 1) {
  await until(
    async () =>
      ((await readJobEvents("demo")) as RecordedEvent[]).filter(
        (e) => e.event?.type === "worker.exited"
      ).length === count
  );
}
async function start() {
  const result = await cli(
    ["job", "run", "--key", "demo", "--repo", ".", "--prompt", "fixture"],
    "a"
  );
  expect(result.code).toBe(0);
  expect(result.value.status).toBe("queued");
  await until(
    async () => (await readJob("demo")).latestAgentMessage.length > 0
  );
}

test("run detaches; global state, JSON summary, notify and live steer work across cwd", async () => {
  const started = Date.now();
  await start();
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await Bun.file(join(tmp, "state/jobs/demo/job.json")).exists()).toBe(
    true
  );
  const summary = await cli(["job", "summary", "demo"]);
  expect(summary.value.repo).toBe(join(tmp, "a"));
  expect(summary.value.status).toBe("running");
  expect(Array.from(summary.value.latestAgentMessage)).toHaveLength(2000);
  expect(summary.value.finalResponse).toBe("");
  expect(summary.value.recentEvents).toHaveLength(5);
  expect(Object.keys(summary.value).sort()).toEqual(
    [
      "key",
      "status",
      "repo",
      "threadId",
      "turnId",
      "createdAt",
      "startedAt",
      "completedAt",
      "pendingApprovals",
      "latestAgentMessage",
      "finalResponse",
      "error",
      "progress",
      "lastNotification",
      "recentEvents",
    ].sort()
  );
  expect((await cli(["job", "notify", "demo"])).code).toBe(0);
  expect((await cli(["job", "steer", "demo", "--prompt", "adjust"])).code).toBe(
    0
  );
  await until(async () =>
    ((await readJobEvents("demo")) as RecordedEvent[]).some(
      (e) => e.message?.method === "turn/steer"
    )
  );
  const duplicate = await cli([
    "job",
    "run",
    "--key",
    "demo",
    "--prompt",
    "duplicate",
  ]);
  expect(duplicate.code).not.toBe(0);
  await Bun.write(process.env.TEST_RELEASE!, "");
  await exited();
  expect(
    (await cli(["job", "summary", "demo", "--json=false"])).value.finalResponse
  ).toBe("OK");
});

test.each([
  ["completed", "completed"],
  ["failed", "failed"],
  ["interrupted", "cancelled"],
])(
  "steer resumes %s on same thread, waits for new turn and notifies again",
  async (serverStatus, status) => {
    process.env.TEST_STATUS = serverStatus;
    await start();
    await cli(["job", "steer", "demo", "--prompt", "old English 😀"]);
    await until(async () =>
      ((await readJobEvents("demo")) as RecordedEvent[]).some(
        (e) => e.message?.method === "turn/steer"
      )
    );
    await Bun.write(process.env.TEST_RELEASE!, "");
    await until(async () => (await readJob("demo")).status === status);
    const previous = await readJob("demo");
    delete process.env.TEST_STATUS;
    expect(
      (await cli(["job", "steer", "demo", "--prompt", "new English 😀"])).code
    ).toBe(0);
    const resumed = await cli([
      "job",
      "wait",
      "demo",
      "--interval-ms",
      "10",
      "--timeout-ms",
      "4000",
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.value.reason).toBe("terminal");
    expect(resumed.value.status).toBe("completed");
    expect(resumed.value.summary.turnId).not.toBe(previous.turnId);
    expect(resumed.value.summary.threadId).toBe(previous.threadId);
    await exited(2);
    expect((await readJobSummary("demo", 0)).progress.commands).toEqual({
      run: 2,
      failed: 0,
    });
    const requests = ((await readJobEvents("demo")) as RecordedEvent[])
      .filter((e) => e.direction === "client" && e.message?.method)
      .flatMap((e) => (e.message ? [e.message] : []));
    expect(requests.filter((m) => m.method === "thread/start")).toHaveLength(1);
    expect(
      requests.filter((m) => m.method === "thread/resume").map((m) => m.params)
    ).toEqual([{ threadId: "same-thread", cwd: join(tmp, "a") }]);
    expect(
      requests
        .filter((m) => m.method === "turn/start")
        .map((m) => m.params!.input![0]!.text)
    ).toEqual(["fixture", "new English 😀"]);
    expect(requests.filter((m) => m.method === "turn/steer")).toHaveLength(1);
    expect(notifications.map((n) => n.event)).toEqual([
      `job.${status}`,
      "job.completed",
    ]);
  }
);

test("CLI control commands leave job.json byte-for-byte unchanged", async () => {
  const record = await createJob({
    key: "demo",
    repo: join(tmp, "a"),
    prompt: "fixture",
  });
  record.status = "running";
  record.approvals = [
    {
      id: "1",
      serverRequestId: 1,
      method: "item/commandExecution/requestApproval",
      params: {},
      status: "pending",
      createdAt: record.createdAt,
      resolvedAt: null,
      decision: null,
      error: null,
    },
  ];
  await Bun.write(join(jobDir("demo"), "job.json"), JSON.stringify(record));
  const before = await Bun.file(join(jobDir("demo"), "job.json")).text();
  for (const args of [
    ["job", "steer", "demo", "--prompt", "adjust"],
    ["job", "cancel", "demo"],
    ["approval", "approve", "demo", "1"],
    ["job", "notify", "demo"],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each command changes the same job queue; assert the saved job stays unchanged after each command.
    expect((await cli(args)).code).toBe(0);
    expect(await Bun.file(join(jobDir("demo"), "job.json")).text()).toBe(
      before
    );
  }
  expect(
    (await Bun.file(join(jobDir("demo"), "control.jsonl")).text())
      .trim()
      .split("\n")
  ).toHaveLength(3);
});

test("running summary persists item progress, completed commentary, command counts and latest tokens", async () => {
  await start();
  const events = (await readJobEvents("demo")) as RecordedEvent[];
  const started = events.find((e) => e.message?.method === "item/started");
  expect((await readJobSummary("demo", 0)).progress).toEqual({
    current: { type: "agentMessage", startedAt: started!.at },
    lastCommentary: null,
    commands: { run: 0, failed: 0 },
    totalTokens: null,
  });
  const emit = async (batchEvents: unknown[]) => {
    const id = crypto.randomUUID();
    await enqueueSteer(
      "demo",
      `test-events:${JSON.stringify({ id, events: batchEvents })}`
    );
    // The response follows all events in the batch, so their records are persisted.
    await until(async () =>
      ((await readJobEvents("demo")) as RecordedEvent[]).some(
        (e) => e.direction === "server" && e.message?.result?.batch === id
      )
    );
    return (await readJobSummary("demo", 0)).progress;
  };
  const item = (method: string, value: object) => ({
    method,
    params: { item: value },
  });
  const command = `echo ${"😀".repeat(201)}`;
  let progress = await emit([
    item("item/started", { id: "current", type: "commandExecution", command }),
    item("item/completed", {
      id: "other",
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
    }),
    item("item/completed", {
      id: "commentary",
      type: "agentMessage",
      phase: "commentary",
      text: "Checking the commands.",
    }),
    item("item/completed", {
      id: "answer",
      type: "agentMessage",
      phase: "final_answer",
      text: "Final answer.",
    }),
  ]);
  const commandStarted = (
    (await readJobEvents("demo")) as RecordedEvent[]
  ).find(
    (e) =>
      e.message?.method === "item/started" &&
      e.message.params?.item?.id === "current"
  );
  expect(progress.current).toEqual({
    type: "commandExecution",
    startedAt: commandStarted!.at,
    command: Array.from(command).slice(0, 200).join(""),
  });
  expect(progress.commands).toEqual({ run: 1, failed: 0 });
  expect(progress.lastCommentary).toBe("Checking the commands.");

  progress = await emit([
    item("item/completed", {
      id: "current",
      type: "commandExecution",
      status: "completed",
      exitCode: 7,
    }),
    item("item/completed", {
      id: "denied",
      type: "commandExecution",
      status: "declined",
      exitCode: 0,
    }),
    item("item/completed", {
      id: "no-exit",
      type: "commandExecution",
      status: "completed",
      exitCode: null,
    }),
    item("item/completed", {
      id: "note",
      type: "agentMessage",
      phase: "commentary",
      text: "😀".repeat(501),
    }),
    item("item/completed", {
      id: "answer-2",
      type: "agentMessage",
      phase: "final_answer",
      text: "Another answer.",
    }),
    {
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { total: { totalTokens: 123 } } },
    },
    {
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: { total: { totalTokens: 456 }, last: { totalTokens: 10 } },
      },
    },
  ]);
  expect(progress).toEqual({
    current: null,
    commands: { run: 4, failed: 2 },
    lastCommentary: "😀".repeat(500),
    totalTokens: 456,
  });
  const reasoning = await emit([
    item("item/started", { id: "thinking", type: "reasoning" }),
  ]);
  expect(reasoning.current).toEqual({
    type: "reasoning",
    startedAt: expect.any(String),
  });
  expect(
    (
      await emit([
        item("item/completed", { id: "thinking", type: "reasoning" }),
      ])
    ).current
  ).toBeNull();
  expect(
    (
      await emit([
        item("item/started", { id: "unfinished", type: "fileChange" }),
      ])
    ).current?.type
  ).toBe("fileChange");
  await Bun.write(process.env.TEST_RELEASE!, "");
  await exited();
  expect((await readJobSummary("demo", 0)).progress).toEqual({
    ...progress,
    commands: { run: 5, failed: 2 },
    current: null,
  });
}, 10_000);

test("missing progress defaults to nulls and zero counts without rewriting job.json", async () => {
  await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  const path = join(jobDir("demo"), "job.json");
  const { progress: _progress, ...record } = await Bun.file(path).json();
  expect("progress" in record).toBe(false);
  expect(Object.keys(record)).not.toContain("progress");
  expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty("progress");
  const before = JSON.stringify(record);
  await Bun.write(path, before);
  expect((await readJobSummary("demo", 0)).progress).toEqual({
    current: null,
    lastCommentary: null,
    commands: { run: 0, failed: 0 },
    totalTokens: null,
  });
  expect(await Bun.file(path).text()).toBe(before);
});

test("queued cancel is written only by worker and starts no app-server", async () => {
  await createJob({
    key: "demo",
    repo: join(tmp, "a"),
    prompt: "fixture",
  });
  await cli(["job", "cancel", "demo"]);
  expect((await readJob("demo")).status).toBe("queued");
  expect((await runJobWorker("demo")).status).toBe("cancelled");
  expect(
    ((await readJobEvents("demo")) as RecordedEvent[]).some(
      (e) => e.direction === "client"
    )
  ).toBe(false);
  expect(notifications.map((n) => n.event)).toEqual(["job.cancelled"]);
});

test("cancelled turn resumes without replaying its interrupt", async () => {
  await start();
  expect((await cli(["job", "cancel", "demo"])).code).toBe(0);
  const cancelled = await cli([
    "job",
    "wait",
    "demo",
    "--interval-ms",
    "10",
    "--timeout-ms",
    "4000",
  ]);
  expect(cancelled.value.status).toBe("cancelled");
  const before = await readJob("demo");
  await Bun.write(process.env.TEST_RELEASE!, "");
  expect(
    (await cli(["job", "steer", "demo", "--prompt", "continue"])).code
  ).toBe(0);
  const resumed = await cli([
    "job",
    "wait",
    "demo",
    "--interval-ms",
    "10",
    "--timeout-ms",
    "4000",
  ]);
  expect(resumed.value.status).toBe("completed");
  expect(resumed.value.summary.turnId).not.toBe(before.turnId);
  await exited(2);
  const job = await readJob("demo");
  expect(job.cancelRequestedAt).toBeNull();
  expect(job.cancelCommandId).toBeNull();
  const interrupts = ((await readJobEvents("demo")) as RecordedEvent[]).filter(
    (e) => e.direction === "client" && e.message?.method === "turn/interrupt"
  );
  expect(interrupts).toHaveLength(1);
  expect(notifications.map((n) => n.event)).toEqual([
    "job.cancelled",
    "job.completed",
  ]);
});

test("terminal job without a thread returns a JSON error without modifying state", async () => {
  const record = await createJob({
    key: "demo",
    repo: join(tmp, "a"),
    prompt: "fixture",
  });
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
  await Bun.write(
    join(oldDir, "job.json"),
    JSON.stringify({ key: "old", status: "completed" })
  );
  process.env.CODEXCTL_STATE_DIR = join(tmp, "other-state");
  process.env.CODEXCTL_STATE_REPO = join(tmp, "a");
  expect((await cli(["job", "list"])).value).toEqual([]);
  expect((await cli(["job", "summary", "old"])).code).not.toBe(0);
  await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  expect((await cli(["job", "summary", "demo"])).code).toBe(0);
  expect(await Bun.file(join(oldDir, "job.json")).json()).toEqual({
    key: "old",
    status: "completed",
  });
});

test("malformed JSON-RPC preserves the parse error as its cause", async () => {
  await createJob({ key: "demo", repo: join(tmp, "a"), prompt: "fixture" });
  // A fresh process resolves codex using the fixture PATH, just like the worker.
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { AppServerClient } from ${JSON.stringify(join(import.meta.dir, "../src/app-server.ts"))};
    const client = new AppServerClient();
    try {
      await client.initialize();
      const closed = client.closed().catch(error => error);
      await client.notify("test/malformed-json");
      const error = await closed;
      console.log(JSON.stringify({message: error.message, syntaxErrorCause: error.cause instanceof SyntaxError}));
    } finally {
      await client.close();
    }
  `,
    ],
    { env: process.env, stdout: "pipe", stderr: "pipe" }
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    message: expect.stringContaining(
      "Failed to parse app-server JSON-RPC line:"
    ),
    syntaxErrorCause: true,
  });
});
