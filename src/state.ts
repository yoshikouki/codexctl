import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertJobKey } from "./app-server.ts";

export const CODEXCTL_HOME_ENV = "CODEXCTL_HOME";
export const CODEXCTL_STATE_DIR_ENV = "CODEXCTL_STATE_DIR";
export const CODEXCTL_STATE_REPO_ENV = "CODEXCTL_STATE_REPO";

export function codexctlHome(): string {
  const configured = process.env[CODEXCTL_HOME_ENV];
  return configured ? resolve(configured) : join(homedir(), ".codexctl");
}

export function currentStateRepo(): string {
  return resolve(process.env[CODEXCTL_STATE_REPO_ENV] ?? process.cwd());
}

export function stateRoot(repo = currentStateRepo()): string {
  const configured = process.env[CODEXCTL_STATE_DIR_ENV];
  if (configured) return resolve(configured);
  return join(codexctlHome(), "repos", repoStateId(repo));
}

export function jobsRoot(repo = currentStateRepo()): string {
  return join(stateRoot(repo), "jobs");
}

export function jobDir(key: string, repo = currentStateRepo()): string {
  assertJobKey(key);
  return join(jobsRoot(repo), key);
}

export function supervisorDir(repo = currentStateRepo()): string {
  return join(stateRoot(repo), "supervisor");
}

export function supervisorCursorDir(repo = currentStateRepo()): string {
  return join(supervisorDir(repo), "cursors");
}

export function supervisorCursorPath(name: string, repo = currentStateRepo()): string {
  return join(supervisorCursorDir(repo), `${name}.json`);
}

export function stateEnvForChild(): Record<string, string> {
  return {
    [CODEXCTL_STATE_REPO_ENV]: currentStateRepo(),
  };
}

function repoStateId(repo: string): string {
  const normalized = resolve(repo);
  const label = sanitizeRepoLabel(basename(normalized) || "repo");
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${label}-${hash}`;
}

function sanitizeRepoLabel(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "repo";
}
