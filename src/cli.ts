#!/usr/bin/env bun
import {
  cancelJob,
  cancelJobAndWait,
  enqueueApprovalDecisionAndWait,
  enqueueApprovalDecision,
  enqueueSteer,
  enqueueSteerAndWait,
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
  "cancel",
  "events",
  "for-session",
  "format",
  "force",
  "dry-run",
  "help",
  "interval-ms",
  "json",
  "key",
  "prompt",
  "repo",
  "timeout-ms",
  "wait",
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

  if (resource === "job" && action === "run") {
    allowFlags(args, ["json", "key", "repo", "prompt", "force", "events", "interval-ms", "timeout-ms"]);
    await printJson(await runJob({
      key: requiredString(args, "key"),
      repo: stringFlag(args, "repo") ?? ".",
      prompt: requiredString(args, "prompt"),
      force: booleanFlag(args, "force"),
      eventLimit: eventLimitFlag(args),
      intervalMs: intervalMsFlag(args),
      timeoutMs: numberFlag(args, "timeout-ms"),
    }));
    return;
  }

  if (resource === "job" && action === "notify" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, ["json"]);
    await printJson(await notifyJob(key));
    return;
  }

  if (resource === "job" && action === "list") {
    allowFlags(args, ["json"]);
    await printJson(await listJobs());
    return;
  }

  if (resource === "job" && action === "summary" && key) {
    allowFlags(args, ["json", "events"]);
    await printJson(await readJobSummary(key, eventLimitFlag(args)));
    return;
  }

  if (resource === "job" && action === "wait" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, ["json", "events", "interval-ms", "timeout-ms"]);
    await printJson(await waitForJob(key, {
      eventLimit: eventLimitFlag(args),
      intervalMs: intervalMsFlag(args),
      timeoutMs: numberFlag(args, "timeout-ms"),
    }));
    return;
  }

  if (resource === "job" && action === "events" && key) {
    allowFlags(args, ["json", "format"]);
    eventFormatFlag(args);
    for (const event of await readJobEvents(key)) {
      console.log(JSON.stringify(event));
    }
    return;
  }

  if (resource === "job" && action === "steer" && key) {
    allowFlags(args, ["json", "prompt", "wait", "events", "interval-ms", "timeout-ms"]);
    const prompt = requiredString(args, "prompt");
    if (booleanFlag(args, "wait")) {
      await printJson(await enqueueSteerAndWait(key, prompt, waitOptionsFromFlags(args)));
    } else {
      await printJson(await enqueueSteer(key, prompt));
    }
    return;
  }

  if (resource === "job" && action === "cancel" && key) {
    allowFlags(args, ["json", "wait", "events", "interval-ms", "timeout-ms"]);
    if (booleanFlag(args, "wait")) {
      await printJson(await cancelJobAndWait(key, waitOptionsFromFlags(args)));
    } else {
      await printJson(await cancelJob(key));
    }
    return;
  }

  if (resource === "job" && action === "rm" && key) {
    requirePositionalCount(args, 3);
    allowFlags(args, ["json", "force", "dry-run"]);
    await printJson(await removeJob(key, { force: booleanFlag(args, "force"), dryRun: booleanFlag(args, "dry-run") }));
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
    allowFlags(args, ["json", "for-session", "wait", "events", "interval-ms", "timeout-ms"]);
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
    allowFlags(args, ["json", "cancel", "wait", "events", "interval-ms", "timeout-ms"]);
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
  return nonNegativeIntegerFlag(args, "events", 10);
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
  codexctl job run --repo . --key <key> --prompt <prompt> [--force] [--events <n>] [--timeout-ms <ms>] --json
  codexctl job notify <key> --json
  codexctl job list --json
  codexctl job summary <key> [--events <n>] --json
  codexctl job wait <key> [--events <n>] [--interval-ms <ms>] [--timeout-ms <ms>] --json
  codexctl job events <key> [--format raw] --json
  codexctl job steer <key> --prompt <prompt> [--wait] --json
  codexctl job cancel <key> [--wait] --json
  codexctl job rm <key> [--force] [--dry-run] --json
  codexctl approval list <job-key> [--all] --json
  codexctl approval show <job-key> <approval-id> --json
  codexctl approval approve <job-key> <approval-id> [--for-session] [--wait] --json
  codexctl approval reject <job-key> <approval-id> [--cancel] [--wait] --json`;
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
