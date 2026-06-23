#!/usr/bin/env bun
import { readDaemonVersion } from "./app-server.ts";
import { readJob, readJobEvents, startJob } from "./job.ts";

type Args = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [resource, action, key] = args.positionals;

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
    const force = booleanFlag(args, "force");
    await printJson(await startJob({ key: jobKey, repo, prompt, model, force }));
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

async function printJson(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
}

function usage(): void {
  console.error(`Usage:
  codexctl doctor --json
  codexctl job start --repo . --key <key> --prompt <prompt> [--force] --json
  codexctl job status <key> --json
  codexctl job events <key> --json
  codexctl job result <key> --json`);
}

main(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
