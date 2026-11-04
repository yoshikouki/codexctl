import { dirname, basename, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { AppServerClient } from "./app-server.ts";

type Project = { id: string; name: string; roots: Array<{ path: string }> };

export function gitProjectRoot(repo: string): string | null {
  const result = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const gitDir = result.stdout.toString().trim();
  return gitDir ? realpathSync(dirname(gitDir)) : null;
}

export async function projectIdForRepo(client: AppServerClient, repo: string): Promise<string | null> {
  const root = gitProjectRoot(repo);
  if (!root) return null;

  const matches: Project[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) }) as {
      data: Project[];
      nextCursor: string | null;
    };
    matches.push(...page.data.filter(project => project.roots.some(item => resolve(item.path) === root)));
    cursor = page.nextCursor;
  } while (cursor);

  if (matches.length === 1) return matches[0]!.id;
  const name = basename(root);
  const named = matches.find(project => project.name === name);
  if (named) return named.id;

  const created = await client.request("project/create", {
    name,
    roots: [{ path: root }],
    idempotencyKey: `codexctl:${createHash("sha256").update(root).digest("hex")}`,
  }) as { project: Project };
  return created.project.id;
}
