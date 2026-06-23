#!/usr/bin/env bun
import { readDaemonVersion } from "./app-server.ts";
import {
  enqueueApprovalDecision,
  enqueueSteer,
  listJobs,
  readApproval,
  readApprovals,
  readJob,
  readJobEvents,
  readNewEventLines,
  recoverJob,
  runJobWorker,
  startJob,
  sweepJobs,
} from "./job.ts";

type Args = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [resource, action, key, extra] = args.positionals;

  if (resource === "doctor") {
    await printJson({
      ok: true,
      daemon: await readDaemonVersion(),
      appServerTransport: "stdio-jsonl",
    });
    return;
  }

  if (resource === "job" && action === "start") {
    const jobKey = requiredString(args, "key");
    const repo = stringFlag(args, "repo") ?? ".";
    const prompt = requiredString(args, "prompt");
    const model = stringFlag(args, "model") ?? undefined;
    const approvalPolicy = approvalPolicyFlag(args);
    const sandbox = sandboxFlag(args);
    const force = booleanFlag(args, "force");
    const detach = booleanFlag(args, "detach");
    await printJson(await startJob({ key: jobKey, repo, prompt, model, approvalPolicy, sandbox, force, detach }));
    return;
  }

  if (resource === "job" && action === "list") {
    await printJson(await listJobs());
    return;
  }

  if (resource === "job" && action === "status" && key) {
    const job = await readJob(key);
    await printJson({
      key: job.key,
      status: job.status,
      threadId: job.threadId,
      turnId: job.turnId,
      updatedAt: job.updatedAt,
      error: job.error,
    });
    return;
  }

  if (resource === "job" && action === "result" && key) {
    await printJson(await readJob(key));
    return;
  }

  if (resource === "job" && action === "events" && key) {
    for (const event of await readJobEvents(key)) {
      console.log(JSON.stringify(event));
    }
    return;
  }

  if (resource === "job" && action === "watch" && key) {
    await watchJob(key);
    return;
  }

  if (resource === "job" && action === "steer" && key) {
    await printJson(await enqueueSteer(key, requiredString(args, "prompt")));
    return;
  }

  if (resource === "job" && action === "recover" && key) {
    await printJson(await recoverJob(key));
    return;
  }

  if (resource === "job" && action === "sweep") {
    await printJson(await sweepJobs());
    return;
  }

  if (resource === "approval" && action === "list" && key) {
    await printJson(await readApprovals(key, booleanFlag(args, "all")));
    return;
  }

  if (resource === "approval" && action === "show" && key && extra) {
    await printJson(await readApproval(key, extra));
    return;
  }

  if (resource === "approval" && action === "approve" && key && extra) {
    await printJson(await enqueueApprovalDecision(key, extra, booleanFlag(args, "for-session") ? "approveForSession" : "approve"));
    return;
  }

  if (resource === "approval" && action === "reject" && key && extra) {
    await printJson(await enqueueApprovalDecision(key, extra, booleanFlag(args, "cancel") ? "cancel" : "reject"));
    return;
  }

  if (resource === "internal" && action === "worker" && key) {
    await runJobWorker(key);
    return;
  }

  usage();
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(name, true);
      continue;
    }
    flags.set(name, next);
    index++;
  }
  return { positionals, flags };
}

function stringFlag(args: Args, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

function booleanFlag(args: Args, name: string): boolean {
  return args.flags.get(name) === true;
}

function requiredString(args: Args, name: string): string {
  const value = stringFlag(args, name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function approvalPolicyFlag(args: Args): "untrusted" | "on-failure" | "on-request" | "never" | undefined {
  const value = stringFlag(args, "approval-policy");
  if (value === null) return undefined;
  if (value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never") return value;
  throw new Error("--approval-policy must be one of: untrusted, on-failure, on-request, never");
}

function sandboxFlag(args: Args): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  const value = stringFlag(args, "sandbox");
  if (value === null) return undefined;
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  throw new Error("--sandbox must be one of: read-only, workspace-write, danger-full-access");
}

async function printJson(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
}

function usage(): void {
  console.error(`Usage:
  codexctl doctor --json
  codexctl job start --repo . --key <key> --prompt <prompt> [--detach] [--force] [--approval-policy <policy>] [--sandbox <mode>] --json
  codexctl job list --json
  codexctl job status <key> --json
  codexctl job events <key> --json
  codexctl job watch <key> --json
  codexctl job steer <key> --prompt <prompt> --json
  codexctl job recover <key> --json
  codexctl job sweep --json
  codexctl approval list <job-key> [--all] --json
  codexctl approval show <job-key> <approval-id> --json
  codexctl approval approve <job-key> <approval-id> [--for-session] --json
  codexctl approval reject <job-key> <approval-id> [--cancel] --json
  codexctl job result <key> --json`);
}

async function watchJob(key: string): Promise<void> {
  let offset = 0;
  while (true) {
    const next = await readNewEventLines(key, offset);
    offset = next.offset;
    for (const line of next.lines) {
      console.log(line);
    }
    const job = await readJob(key);
    if (job.status === "completed" || job.status === "failed") {
      return;
    }
    await Bun.sleep(500);
  }
}

main(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
