#!/usr/bin/env bun
import {
  cancelJob,
  enqueueApprovalDecisionAndWait,
  enqueueApprovalDecision,
  enqueueSteer,
  listJobs,
  notifyJob,
  readApproval,
  readApprovals,
  readJobEvents,
  readJobSummary,
  removeJob,
  runJob,
  runJobWorker,
  waitForJob,
} from "./job.ts";
import { loadEnvFile } from "./env.ts";

type Args = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

class CliError extends Error {
  constructor(
    readonly code: "usage_error" | "invalid_flag",
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

const knownPublicFlags = [
  "all",
  "cancel",
  "events",
  "for-session",
  "format",
  "force",
  "dry-run",
  "help",
  "interval-ms",
  "key",
  "prompt",
  "repo",
  "timeout-ms",
  "wait",
];

async function main(argv: string[]): Promise<void> {
  await loadEnvFile();
  const args = parseArgs(argv);
  const [resource, action, key, extra] = args.positionals;

  if (booleanFlag(args, "help") || resource === "help") {
    await printJson({ usage: usageText() });
    return;
  }

  allowFlags(args, knownPublicFlags);

  if (resource === "job" && action === "run") {
    allowFlags(args, ["key", "repo", "prompt", "force"]);
    await printJson(await runJob({
      key: requiredString(args, "key"),
      repo: stringFlag(args, "repo") ?? ".",
      prompt: requiredString(args, "prompt"),
      force: booleanFlag(args, "force"),
    }));
    return;
  }

  if (resource === "job" && action === "notify" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, []);
    await printJson(await notifyJob(key));
    return;
  }

  if (resource === "job" && action === "list") {
    allowFlags(args, []);
    await printJson(await listJobs());
    return;
  }

  if (resource === "job" && action === "summary" && key) {
    allowFlags(args, ["events"]);
    await printJson(await readJobSummary(key, eventLimitFlag(args)));
    return;
  }

  if (resource === "job" && action === "wait" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, ["events", "interval-ms", "timeout-ms"]);
    await printJson(await waitForJob(key, {
      eventLimit: eventLimitFlag(args),
      intervalMs: intervalMsFlag(args),
      timeoutMs: numberFlag(args, "timeout-ms"),
    }));
    return;
  }

  if (resource === "job" && action === "events" && key) {
    allowFlags(args, ["format"]);
    eventFormatFlag(args);
    for (const event of await readJobEvents(key)) {
      console.log(JSON.stringify(event));
    }
    return;
  }

  if (resource === "job" && action === "steer" && key) {
    allowFlags(args, ["prompt"]);
    await printJson(await enqueueSteer(key, requiredString(args, "prompt")));
    return;
  }

  if (resource === "job" && action === "cancel" && key) {
    allowFlags(args, []);
    await printJson(await cancelJob(key));
    return;
  }

  if (resource === "job" && action === "rm" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, ["force", "dry-run"]);
    await printJson(await removeJob(key, { force: booleanFlag(args, "force"), dryRun: booleanFlag(args, "dry-run") }));
    return;
  }

  if (resource === "approval" && action === "list" && key) {
    allowFlags(args, ["all"]);
    await printJson(await readApprovals(key, booleanFlag(args, "all")));
    return;
  }

  if (resource === "approval" && action === "show" && key && extra) {
    allowFlags(args, []);
    await printJson(await readApproval(key, extra));
    return;
  }

  if (resource === "approval" && action === "approve" && key && extra) {
    allowFlags(args, ["for-session", "wait", "events", "interval-ms", "timeout-ms"]);
    const decision = booleanFlag(args, "for-session") ? "approveForSession" : "approve";
    if (booleanFlag(args, "wait")) {
      const waitOptions = waitOptionsFromFlags(args);
      await printJson(await enqueueApprovalDecisionAndWait(key, extra, decision, waitOptions));
    } else {
      await printJson(await enqueueApprovalDecision(key, extra, decision));
    }
    return;
  }

  if (resource === "approval" && action === "reject" && key && extra) {
    allowFlags(args, ["cancel", "wait", "events", "interval-ms", "timeout-ms"]);
    const decision = booleanFlag(args, "cancel") ? "cancel" : "reject";
    if (booleanFlag(args, "wait")) {
      const waitOptions = waitOptionsFromFlags(args);
      await printJson(await enqueueApprovalDecisionAndWait(key, extra, decision, waitOptions));
    } else {
      await printJson(await enqueueApprovalDecision(key, extra, decision));
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
    if (name === "json") continue;
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

function eventFormatFlag(args: Args): "raw" {
  const value = stringFlag(args, "format");
  if (value === null) return "raw";
  if (value === "raw") return value;
  throw new CliError("invalid_flag", "--format must be raw");
}

function intervalMsFlag(args: Args): number {
  return numberFlag(args, "interval-ms") ?? 1000;
}

function eventLimitFlag(args: Args): number {
  return nonNegativeIntegerFlag(args, "events", 5);
}

function waitOptionsFromFlags(args: Args): { eventLimit: number; intervalMs: number; timeoutMs: number | null } {
  return {
    eventLimit: eventLimitFlag(args),
    intervalMs: intervalMsFlag(args),
    timeoutMs: numberFlag(args, "timeout-ms"),
  };
}

function nonNegativeIntegerFlag(args: Args, name: string, fallback: number): number {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new CliError("invalid_flag", `--${name} must be a non-negative integer`);
  }
  if (value.trim().length === 0) {
    throw new CliError("invalid_flag", `--${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError("invalid_flag", `--${name} must be a non-negative integer`);
  }
  return parsed;
}

function numberFlag(args: Args, name: string): number | null {
  const value = args.flags.get(name);
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new CliError("invalid_flag", `--${name} must be a positive integer`);
  }
  if (value.trim().length === 0) {
    throw new CliError("invalid_flag", `--${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError("invalid_flag", `--${name} must be a positive integer`);
  }
  return parsed;
}

async function printJson(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
}

function usageText(): string {
  return `Usage:
  codexctl job run --repo . --key <key> --prompt <prompt> [--force]
  codexctl job notify <key>
  codexctl job list
  codexctl job summary <key> [--events <n>]
  codexctl job wait <key> [--events <n>] [--interval-ms <ms>] [--timeout-ms <ms>]
  codexctl job events <key> [--format raw]
  codexctl job steer <key> --prompt <prompt>
  codexctl job cancel <key>
  codexctl job rm <key> [--force] [--dry-run]
  codexctl approval list <job-key> [--all]
  codexctl approval show <job-key> <approval-id>
  codexctl approval approve <job-key> <approval-id> [--for-session] [--wait]
  codexctl approval reject <job-key> <approval-id> [--cancel] [--wait]

Summary progress: current item (type, startedAt; command execution includes command, up to 200 characters),
lastCommentary (latest completed commentary, up to 500 characters), commands (run/failed across turns), and totalTokens.
Unavailable values are null; counts start at zero. current clears on matching item completion or turn completion.
Summary reads saved progress and lastNotification from job.json, plus only the requested event tail.

Environment: every CLI invocation and worker loads ~/.config/codexctl/env by default (using HOME).
Set env_file in ~/.config/codexctl/config.toml to override the path; ~ expands to HOME and relative paths use the config directory.
Existing environment variables win. Missing files are ignored. Protect the env file with chmod 600.

Notifications: codexctl reads CODEXCTL_GROK_BOT_NOTIFY_URL and CODEXCTL_GROK_BOT_NOTIFY_KEY from the loaded environment and never stores them.
Automatic notifications use the environment of the process that starts the worker: job run, or job steer on a finished job (which restarts the worker).
job notify uses the caller's environment.
When the URL is missing, the worker records notify.skipped, shown in job summary as lastNotification.`;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch(async (error) => {
    const exitCode = errorExitCode(error);
    const message = error instanceof Error ? error.message : String(error);
    await Bun.write(Bun.stderr, JSON.stringify({
      ok: false,
      error: { code: errorCode(error), message },
    }, null, 2) + "\n");
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
