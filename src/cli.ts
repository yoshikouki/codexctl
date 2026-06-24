#!/usr/bin/env bun
import { readDaemonVersion } from "./app-server.ts";
import { compactJobEvent } from "./events.ts";
import {
  cancelJob,
  enqueueApprovalDecision,
  enqueueSteer,
  listJobs,
  readApproval,
  readApprovals,
  readJob,
  readJobEvents,
  readJobSummary,
  readNewEventLines,
  removeJob,
  pruneJobs,
  recoverJob,
  runJobWorker,
  startJob,
  sweepJobs,
} from "./job.ts";
import { readSupervisorEvents, readSupervisorState, runSupervisor } from "./supervisor.ts";

type Args = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

class CliError extends Error {
  constructor(
    readonly code: "usage_error" | "invalid_flag" | "missing_json_flag",
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

const knownPublicFlags = [
  "all",
  "approval-policy",
  "cancel",
  "detach",
  "events",
  "for-session",
  "format",
  "force",
  "dry-run",
  "help",
  "interval-ms",
  "json",
  "keep",
  "key",
  "max-ticks",
  "model",
  "prompt",
  "repo",
  "sandbox",
  "status",
];

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [resource, action, key, extra] = args.positionals;

  if (booleanFlag(args, "help") || resource === "help") {
    if (jsonFlag(args)) {
      await printJson({ usage: usageText() });
    } else {
      await printText(usageText());
    }
    return;
  }

  allowFlags(args, knownPublicFlags);
  requireJsonForPublicCommand(args);

  if (resource === "doctor") {
    allowFlags(args, ["json"]);
    await printJson({
      ok: true,
      daemon: await readDaemonVersion(),
      appServerTransport: "stdio-jsonl",
    });
    return;
  }

  if (resource === "job" && action === "start") {
    allowFlags(args, ["json", "key", "repo", "prompt", "model", "approval-policy", "sandbox", "force", "detach"]);
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
    allowFlags(args, ["json"]);
    await printJson(await listJobs());
    return;
  }

  if (resource === "job" && action === "status" && key) {
    allowFlags(args, ["json"]);
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
    allowFlags(args, ["json"]);
    await printJson(await readJob(key));
    return;
  }

  if (resource === "job" && action === "summary" && key) {
    allowFlags(args, ["json", "events"]);
    await printJson(await readJobSummary(key, eventLimitFlag(args)));
    return;
  }

  if (resource === "job" && action === "events" && key) {
    allowFlags(args, ["json", "format"]);
    const format = eventFormatFlag(args);
    for (const event of await readJobEvents(key)) {
      if (format === "raw") {
        console.log(JSON.stringify(event));
      } else {
        for (const compact of compactJobEvent(event)) {
          console.log(JSON.stringify(compact));
        }
      }
    }
    return;
  }

  if (resource === "job" && action === "watch" && key) {
    allowFlags(args, ["json", "format"]);
    await watchJob(key, eventFormatFlag(args));
    return;
  }

  if (resource === "job" && action === "steer" && key) {
    allowFlags(args, ["json", "prompt"]);
    await printJson(await enqueueSteer(key, requiredString(args, "prompt")));
    return;
  }

  if (resource === "job" && action === "cancel" && key) {
    allowFlags(args, ["json"]);
    await printJson(await cancelJob(key));
    return;
  }

  if (resource === "job" && action === "rm" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, ["json", "force", "dry-run"]);
    await printJson(await removeJob(key, { force: booleanFlag(args, "force"), dryRun: booleanFlag(args, "dry-run") }));
    return;
  }

  if (resource === "job" && action === "prune") {
    requirePositionalCount(args, 2);
    allowFlags(args, ["json", "keep", "dry-run", "status"]);
    await printJson(await pruneJobs({
      keep: nonNegativeIntegerFlag(args, "keep", 10),
      dryRun: booleanFlag(args, "dry-run"),
      status: pruneStatusFlag(args),
    }));
    return;
  }

  if (resource === "job" && action === "recover" && key) {
    allowFlags(args, ["json"]);
    await printJson(await recoverJob(key));
    return;
  }

  if (resource === "job" && action === "sweep") {
    allowFlags(args, ["json"]);
    await printJson(await sweepJobs());
    return;
  }

  if (resource === "approval" && action === "list" && key) {
    allowFlags(args, ["json", "all"]);
    await printJson(await readApprovals(key, booleanFlag(args, "all")));
    return;
  }

  if (resource === "approval" && action === "show" && key && extra) {
    allowFlags(args, ["json"]);
    await printJson(await readApproval(key, extra));
    return;
  }

  if (resource === "approval" && action === "approve" && key && extra) {
    allowFlags(args, ["json", "for-session"]);
    await printJson(await enqueueApprovalDecision(key, extra, booleanFlag(args, "for-session") ? "approveForSession" : "approve"));
    return;
  }

  if (resource === "approval" && action === "reject" && key && extra) {
    allowFlags(args, ["json", "cancel"]);
    await printJson(await enqueueApprovalDecision(key, extra, booleanFlag(args, "cancel") ? "cancel" : "reject"));
    return;
  }

  if (resource === "supervisor" && action === "once") {
    allowFlags(args, ["json", "interval-ms"]);
    await printJson(await runSupervisor({ intervalMs: intervalMsFlag(args), once: true }));
    return;
  }

  if (resource === "supervisor" && action === "run") {
    allowFlags(args, ["json", "interval-ms", "max-ticks"]);
    await printJson(await runSupervisor({ intervalMs: intervalMsFlag(args), maxTicks: numberFlag(args, "max-ticks") ?? undefined }));
    return;
  }

  if (resource === "supervisor" && action === "status") {
    allowFlags(args, ["json"]);
    await printJson(await readSupervisorState());
    return;
  }

  if (resource === "supervisor" && action === "events") {
    allowFlags(args, ["json"]);
    for (const event of await readSupervisorEvents()) {
      console.log(JSON.stringify(event));
    }
    return;
  }

  if (resource === "internal" && action === "worker" && key) {
    allowFlags(args, []);
    await runJobWorker(key);
    return;
  }

  throw new CliError("usage_error", usageText());
}

export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const flag = arg.slice(2);
    const equalsIndex = flag.indexOf("=");
    const name = equalsIndex >= 0 ? flag.slice(0, equalsIndex) : flag;
    if (!name) throw new CliError("invalid_flag", "Flag name cannot be empty");
    if (equalsIndex >= 0) {
      flags.set(name, flag.slice(equalsIndex + 1));
      continue;
    }
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

function jsonFlag(args: Args): boolean {
  const value = args.flags.get("json");
  return value === true || value === "true";
}

function allowFlags(args: Args, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of args.flags.keys()) {
    if (!allowedSet.has(name)) {
      throw new CliError("invalid_flag", `Unknown flag --${name}`);
    }
  }
}

function requiredString(args: Args, name: string): string {
  const value = stringFlag(args, name);
  if (!value) {
    throw new CliError("usage_error", `Missing required --${name}`);
  }
  return value;
}

function requirePositionalCount(args: Args, count: number): void {
  if (args.positionals.length !== count) {
    throw new CliError("usage_error", usageText());
  }
}

function approvalPolicyFlag(args: Args): "untrusted" | "on-failure" | "on-request" | "never" | undefined {
  const value = stringFlag(args, "approval-policy");
  if (value === null) return undefined;
  if (value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never") return value;
  throw new CliError("invalid_flag", "--approval-policy must be one of: untrusted, on-failure, on-request, never");
}

function sandboxFlag(args: Args): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  const value = stringFlag(args, "sandbox");
  if (value === null) return undefined;
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  throw new CliError("invalid_flag", "--sandbox must be one of: read-only, workspace-write, danger-full-access");
}

function eventFormatFlag(args: Args): "raw" | "compact" {
  const value = stringFlag(args, "format");
  if (value === null) return "raw";
  if (value === "raw" || value === "compact") return value;
  throw new CliError("invalid_flag", "--format must be one of: raw, compact");
}

function pruneStatusFlag(args: Args): "completed" | "failed" | "cancelled" | "terminal" | undefined {
  const value = stringFlag(args, "status");
  if (value === null) return undefined;
  if (value === "completed" || value === "failed" || value === "cancelled" || value === "terminal") return value;
  throw new CliError("invalid_flag", "--status must be one of: completed, failed, cancelled, terminal");
}

function intervalMsFlag(args: Args): number {
  return numberFlag(args, "interval-ms") ?? 1000;
}

function eventLimitFlag(args: Args): number {
  return nonNegativeIntegerFlag(args, "events", 10);
}

function nonNegativeIntegerFlag(args: Args, name: string, fallback: number): number {
  const value = stringFlag(args, name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError("invalid_flag", `--${name} must be a non-negative integer`);
  }
  return parsed;
}

function numberFlag(args: Args, name: string): number | null {
  const value = stringFlag(args, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError("invalid_flag", `--${name} must be a positive integer`);
  }
  return parsed;
}

async function printJson(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
}

async function printText(value: string): Promise<void> {
  await Bun.write(Bun.stdout, value.endsWith("\n") ? value : value + "\n");
}

function requireJsonForPublicCommand(args: Args): void {
  if (jsonFlag(args)) return;
  if (args.positionals[0] === "internal") return;
  throw new CliError("missing_json_flag", "Public commands require --json for machine-readable output");
}

function usageText(): string {
  return `Usage:
  codexctl doctor --json
  codexctl job start --repo . --key <key> --prompt <prompt> [--detach] [--force] [--approval-policy <policy>] [--sandbox <mode>] --json
  codexctl job list --json
  codexctl job status <key> --json
  codexctl job summary <key> [--events <n>] --json
  codexctl job events <key> [--format raw|compact] --json
  codexctl job watch <key> [--format raw|compact] --json
  codexctl job steer <key> --prompt <prompt> --json
  codexctl job cancel <key> --json
  codexctl job rm <key> [--force] [--dry-run] --json
  codexctl job prune [--keep <n>] [--status completed|failed|cancelled|terminal] [--dry-run] --json
  codexctl job recover <key> --json
  codexctl job sweep --json
  codexctl approval list <job-key> [--all] --json
  codexctl approval show <job-key> <approval-id> --json
  codexctl approval approve <job-key> <approval-id> [--for-session] --json
  codexctl approval reject <job-key> <approval-id> [--cancel] --json
  codexctl supervisor once [--interval-ms <ms>] --json
  codexctl supervisor run [--interval-ms <ms>] [--max-ticks <n>] --json
  codexctl supervisor status --json
  codexctl supervisor events --json
  codexctl job result <key> --json`;
}

async function watchJob(key: string, format: "raw" | "compact"): Promise<void> {
  let offset = 0;
  while (true) {
    const next = await readNewEventLines(key, offset);
    offset = next.offset;
    for (const line of next.lines) {
      if (format === "raw") {
        console.log(line);
      } else {
        for (const event of compactJobEvent(JSON.parse(line) as unknown)) {
          console.log(JSON.stringify(event));
        }
      }
    }
    const job = await readJob(key);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    await Bun.sleep(500);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch(async (error) => {
    const exitCode = errorExitCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (argvWantsJson(Bun.argv.slice(2))) {
      await Bun.write(Bun.stderr, JSON.stringify({
        ok: false,
        error: {
          code: errorCode(error),
          message,
        },
      }, null, 2) + "\n");
    } else {
      await Bun.write(Bun.stderr, message.endsWith("\n") ? message : message + "\n");
    }
    process.exit(exitCode);
  });
}

function errorCode(error: unknown): string {
  if (error instanceof CliError) return error.code;
  if (isCodedError(error)) return error.code;
  return "internal_error";
}

function errorExitCode(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (isCodedError(error)) return error.exitCode ?? 2;
  return 1;
}

function isCodedError(error: unknown): error is { code: string; exitCode?: number } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string";
}

function argvWantsJson(argv: string[]): boolean {
  return argv.some((arg) => arg === "--json" || arg === "--json=true");
}
