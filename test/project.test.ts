import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertWorktreeRepoName, gitProjectRoot, projectIdForRepo } from "../src/project.ts";
import type { AppServerClient } from "../src/app-server.ts";

const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

// Tests create their own repositories so they do not depend on the test process running inside a Git checkout.
async function withRepo(run: (temp: string, repo: string) => Promise<void>): Promise<void> {
  const temp = await realpath(await mkdtemp("/tmp/codexctl-project-"));
  const repo = join(temp, "repo");
  try {
    git("init", "-q", repo);
    git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "Initial");
    await run(temp, repo);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("linked worktrees use the main checkout's Codex project", () => withRepo(async (temp, repo) => {
  const worktree = join(temp, "worktree");
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
}));

test("reuses a project whose root is the main checkout", () => withRepo(async (_temp, repo) => {
  const requests: string[] = [];
  const client = { async request(method: string) {
    requests.push(method);
    return { data: [{ id: "existing", name: "Custom name", roots: [{ path: repo }] }], nextCursor: null };
  } } as AppServerClient;
  expect(await projectIdForRepo(client, repo)).toBe("existing");
  expect(requests).toEqual(["project/list"]);
}));

test("a linked worktree must end in the repository name before a job starts", () => withRepo(async (temp, repo) => {
  const wrong = join(temp, "task-id");
  git("-C", repo, "worktree", "add", "-q", wrong);
  expect(() => assertWorktreeRepoName(repo)).not.toThrow();
  expect(() => assertWorktreeRepoName(wrong)).toThrow("create it with 'repo' as its final directory");

  const correct = join(temp, "another-task", "repo");
  git("-C", repo, "worktree", "add", "-q", correct);
  expect(() => assertWorktreeRepoName(correct)).not.toThrow();
}));

test("job run rejects a mismatched worktree without creating job state", () => withRepo(async (temp, repo) => {
  const wrong = join(temp, "task-id");
  git("-C", repo, "worktree", "add", "-q", wrong);
  const home = join(temp, "codexctl-home");
  const result = Bun.spawnSync([
    process.execPath, join(import.meta.dir, "../src/cli.ts"), "job", "run",
    "--repo", wrong, "--key", "example", "--prompt", "Do nothing",
  ], { env: { ...process.env, CODEXCTL_HOME: home }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.stderr.toString()).error.code).toBe("worktree_name_mismatch");
  expect(await Bun.file(join(home, "jobs", "example", "job.json")).exists()).toBe(false);
}));
