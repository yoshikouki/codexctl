import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const NEWLINE = /\r?\n/u;
const ENV_ASSIGNMENT = /^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u;

class EnvFileError extends Error {
  readonly code = "env_file_error";
}

function envErrorMessage(path: string, reason: string, line?: number): string {
  return `${path}${line === undefined ? "" : `:${line}`}: ${reason}`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new EnvFileError(envErrorMessage(path, "Cannot read file"), {
      cause: error,
    });
  }
}

async function resolveEnvPath(home: string): Promise<string> {
  const configPath = join(home, ".config/codexctl/config.toml");
  const text = await readOptional(configPath);
  if (text === null) {
    return join(dirname(configPath), "env");
  }
  let config: Record<string, unknown>;
  try {
    config = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new EnvFileError(envErrorMessage(configPath, "Invalid TOML"), {
      cause: error,
    });
  }
  if (Object.keys(config).some((key) => key !== "env_file")) {
    throw new EnvFileError(
      envErrorMessage(
        configPath,
        "Unknown config key; only env_file is supported"
      )
    );
  }
  if (config.env_file === undefined) {
    return join(dirname(configPath), "env");
  }
  if (typeof config.env_file !== "string" || !config.env_file) {
    throw new EnvFileError(
      envErrorMessage(configPath, "env_file must be a non-empty path string")
    );
  }
  const path = config.env_file;
  return path.startsWith("~/")
    ? join(home, path.slice(2))
    : resolve(dirname(configPath), path);
}

function parseEnvValue(raw: string, path: string, line: number): string {
  const value = raw.trim();
  if (!(value.startsWith('"') || value.startsWith("'"))) {
    return value;
  }
  const quote = value.slice(0, 1);
  if (
    value.length < 2 ||
    !value.endsWith(quote) ||
    value.slice(1, -1).includes(quote)
  ) {
    throw new EnvFileError(
      envErrorMessage(
        path,
        "Invalid quoted value; multiline values are not supported",
        line
      )
    );
  }
  return value.slice(1, -1);
}

export async function loadEnvFile(): Promise<void> {
  const envPath = await resolveEnvPath(process.env.HOME ?? homedir());
  const contents = await readOptional(envPath);
  if (contents === null) {
    return;
  }
  for (const [index, raw] of contents.split(NEWLINE).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const { key, value: rawValue } = line.match(ENV_ASSIGNMENT)?.groups ?? {};
    if (key === undefined || rawValue === undefined) {
      throw new EnvFileError(
        envErrorMessage(envPath, "Expected KEY=VALUE", index + 1)
      );
    }
    const value = parseEnvValue(rawValue, envPath, index + 1);
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
