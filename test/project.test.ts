import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { gitProjectRoot, projectIdForRepo } from "../src/project.ts";
import type { AppServerClient } from "../src/app-server.ts";

test("linked worktrees use the main checkout's Codex project", async () => {
  const temp = await realpath(await mkdtemp("/tmp/codexctl-project-"));
  const repo = join(temp, "repo");
  const worktree = join(temp, "worktree");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    git("init", "-q", repo);
    git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "Initial");
    git("-C", repo, "worktree", "add", "-q", worktree);
    expect(gitProjectRoot(repo)).toBe(repo);
    expect(gitProjectRoot(worktree)).toBe(repo);

    const requests: Array<{ method: string; params: any }> = [];
    const client = { async request(method: string, params: any) {
      requests.push({ method, params });
      if (method === "project/list") return { data: [], nextCursor: null };
      return { project: { id: "project-1" } };
    } } as AppServerClient;
    expect(await projectIdForRepo(client, worktree)).toBe("project-1");
    expect(requests[1]).toMatchObject({ method: "project/create", params: { name: "repo", roots: [{ path: repo }] } });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("reuses a project whose root is the main checkout", async () => {
  const repo = process.cwd();
  const requests: string[] = [];
  const client = { async request(method: string) {
    requests.push(method);
    return { data: [{ id: "existing", name: "Custom name", roots: [{ path: repo }] }], nextCursor: null };
  } } as AppServerClient;
  expect(await projectIdForRepo(client, repo)).toBe("existing");
  expect(requests).toEqual(["project/list"]);
});
