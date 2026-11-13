import { dirname, basename, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AppServerClient } from "./app-server.ts";

interface Project {
  id: string;
  name: string;
  roots: Array<{ path: string }>;
}

export function gitProjectRoot(repo: string): string | null {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  if (result.exitCode !== 0) {
    return null;
  }
  const gitDir = result.stdout.toString().trim();
  return gitDir ? realpathSync(dirname(gitDir)) : null;
}

export function assertWorktreeRepoName(repo: string): void {
  const root = gitProjectRoot(repo);
  if (!root) {
    return;
  }
  const result = Bun.spawnSync(
    ["git", "-C", repo, "rev-parse", "--show-toplevel"],
    {
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  if (result.exitCode !== 0) {
    return;
  }
  const worktree = realpathSync(result.stdout.toString().trim());
  const name = basename(root);
  if (worktree === root || basename(worktree) === name) {
    return;
  }

  throw Object.assign(
    new Error(
      `Git worktree '${worktree}' ends in '${basename(worktree)}'; create it with '${name}' as its final directory before starting a Codex job`
    ),
    { code: "worktree_name_mismatch", exitCode: 2 }
  );
}

export async function projectIdForRepo(
  client: AppServerClient,
  repo: string
): Promise<string | null> {
  const root = gitProjectRoot(repo);
  if (!root) {
    return null;
  }

  const matches: Project[] = [];
  let cursor: string | null = null;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: Each page requires the previous response cursor.
    const page = (await client.request("project/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    })) as {
      data: Project[];
      nextCursor: string | null;
    };
    matches.push(
      ...page.data.filter((project) =>
        project.roots.some((item) => resolve(item.path) === root)
      )
    );
    cursor = page.nextCursor;
  } while (cursor);

  const [onlyMatch] = matches;
  if (matches.length === 1 && onlyMatch) {
    return onlyMatch.id;
  }
  const name = basename(root);
  const named = matches.find((project) => project.name === name);
  if (named) {
    return named.id;
  }

  const created = (await client.request("project/create", {
    name,
    roots: [{ path: root }],
    idempotencyKey: `codexctl:${createHash("sha256").update(root).digest("hex")}`,
  })) as { project: Project };
  return created.project.id;
}
