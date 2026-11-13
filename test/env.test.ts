import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "../src/env.ts";

let home: string;
let configDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  savedEnv = { ...process.env };
  home = await mkdtemp("/tmp/codexctl-env-");
  configDir = join(home, ".config/codexctl");
  await mkdir(configDir, { recursive: true });
  process.env.HOME = home;
  delete process.env.CODEXCTL_ENV_TEST;
});

afterEach(async () => {
  process.env = savedEnv;
  await rm(home, { recursive: true, force: true });
});

test("default path loads without config.toml; quotes, comments and blanks are supported", async () => {
  await Bun.write(
    join(configDir, "env"),
    `# comment\n\nCODEXCTL_ENV_TEST='single quoted'\nCODEXCTL_ENV_DOUBLE="double quoted"\nCODEXCTL_ENV_LITERAL=$HOME#literal\nCODEXCTL_ENV_EMPTY=\n`
  );
  await loadEnvFile();
  expect(process.env.CODEXCTL_ENV_TEST).toBe("single quoted");
  expect(process.env.CODEXCTL_ENV_DOUBLE).toBe("double quoted");
  expect(process.env.CODEXCTL_ENV_LITERAL).toBe("$HOME#literal");
  expect(process.env.CODEXCTL_ENV_EMPTY).toBe("");
});

test.each(["custom.env", "~/custom.env", "absolute"])(
  "env_file overrides the default: %s",
  async (path) => {
    const target =
      path === "custom.env" ? join(configDir, path) : join(home, "custom.env");
    await Bun.write(
      join(configDir, "config.toml"),
      `env_file = ${JSON.stringify(path === "absolute" ? target : path)}\n`
    );
    await Bun.write(join(configDir, "env"), "CODEXCTL_ENV_TEST=default\n");
    await Bun.write(target, "CODEXCTL_ENV_TEST=custom\n");
    await loadEnvFile();
    expect(process.env.CODEXCTL_ENV_TEST).toBe("custom");
  }
);

test("existing environment values, including empty strings, win", async () => {
  await Bun.write(join(configDir, "env"), "CODEXCTL_ENV_TEST=file\n");
  for (const value of ["caller", ""]) {
    process.env.CODEXCTL_ENV_TEST = value;
    // biome-ignore lint/performance/noAwaitInLoops: Each case replaces process.env before loading it; concurrent loads would share the same variable.
    await loadEnvFile();
    expect(process.env.CODEXCTL_ENV_TEST).toBe(value);
  }
});

test("missing env files and missing config are fine", async () => {
  await loadEnvFile();
  await Bun.write(join(configDir, "config.toml"), 'env_file = "missing.env"\n');
  await loadEnvFile();
  expect(process.env.CODEXCTL_ENV_TEST).toBeUndefined();
});

async function cliError(path: string, reason: string, line?: number) {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), "--help"],
    {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toEqual({
    ok: false,
    error: {
      code: "env_file_error",
      message: `${path}${line === undefined ? "" : `:${line}`}: ${reason}`,
    },
  });
  expect(stderr).not.toContain("private-value");
}

test("invalid TOML reports its path without exposing values, even for help", async () => {
  const path = join(configDir, "config.toml");
  await Bun.write(path, "# config\nenv_file = !private-value\n");
  await cliError(path, "Invalid TOML");
  await expect(loadEnvFile()).rejects.toMatchObject({
    cause: expect.any(Error),
  });
});

test.each(['unknown = "private-value"', "env_file = 42", 'env_file = ""'])(
  "rejects unsupported config: %s",
  async (config) => {
    const path = join(configDir, "config.toml");
    await Bun.write(path, config);
    await cliError(
      path,
      config.startsWith("unknown")
        ? "Unknown config key; only env_file is supported"
        : "env_file must be a non-empty path string"
    );
  }
);

test.each([
  "export CODEXCTL_ENV_TEST=private-value",
  "private-value",
  "CODEXCTL_ENV_TEST='private-value",
  'CODEXCTL_ENV_TEST="private-value\ncontinued"',
])("malformed env lines report line numbers without values", async (line) => {
  const path = join(configDir, "env");
  await Bun.write(path, `# comment\n${line}\n`);
  await cliError(
    path,
    line.startsWith("CODEXCTL_ENV_TEST=")
      ? "Invalid quoted value; multiline values are not supported"
      : "Expected KEY=VALUE",
    2
  );
});

test.each(["config.toml", "env"])(
  "unreadable %s returns a safe error",
  async (file) => {
    // A directory reliably fails reads, including when tests run as root.
    const path = join(configDir, file);
    await mkdir(path);
    await cliError(path, "Cannot read file");
    await expect(loadEnvFile()).rejects.toMatchObject({
      cause: { code: "EISDIR" },
    });
  }
);

test("env parsing preserves CRLF, whitespace, empty values and equals in values", async () => {
  await Bun.write(join(configDir, "env"), "  CODEXCTL_ENV_TEST =invalid\r\n");
  await expect(loadEnvFile()).rejects.toThrow("Expected KEY=VALUE");
  await Bun.write(
    join(configDir, "env"),
    "  CODEXCTL_ENV_TEST= a=b 😀  \r\nCODEXCTL_ENV_EMPTY=\r\n# ignored\r\n"
  );
  await loadEnvFile();
  expect(process.env.CODEXCTL_ENV_TEST).toBe("a=b 😀");
  expect(process.env.CODEXCTL_ENV_EMPTY).toBe("");
});
