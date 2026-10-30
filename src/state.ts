import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertJobKey } from "./app-server.ts";

export function codexctlHome(): string {
  return resolve(process.env.CODEXCTL_HOME ?? join(homedir(), ".codexctl"));
}

export function jobsRoot(): string {
  return join(codexctlHome(), "jobs");
}

export function jobDir(key: string): string {
  assertJobKey(key);
  return join(jobsRoot(), key);
}
