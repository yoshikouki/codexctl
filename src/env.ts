import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

class EnvFileError extends Error {
  readonly code = "env_file_error";

  constructor(path: string, reason: string, line?: number) {
    super(`${path}${line === undefined ? "" : `:${line}`}: ${reason}`);
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new EnvFileError(path, "Cannot read file");
  }
}

export async function loadEnvFile(): Promise<void> {
  const home = process.env.HOME ?? homedir();
  const configPath = join(home, ".config/codexctl/config.toml");
  let envPath = join(dirname(configPath), "env");
  const text = await readOptional(configPath);
  if (text !== null) {
    let config: Record<string, unknown>;
    try {
      config = Bun.TOML.parse(text) as Record<string, unknown>;
    } catch {
      throw new EnvFileError(configPath, "Invalid TOML");
    }
    if (Object.keys(config).some(key => key !== "env_file")) {
      throw new EnvFileError(configPath, "Unknown config key; only env_file is supported");
    }
    if (config.env_file !== undefined) {
      if (typeof config.env_file !== "string" || !config.env_file) {
        throw new EnvFileError(configPath, "env_file must be a non-empty path string");
      }
      const path = config.env_file;
      envPath = path.startsWith("~/")
        ? join(home, path.slice(2)) : resolve(dirname(configPath), path);
    }
  }
  const contents = await readOptional(envPath);
  if (contents === null) return;
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      throw new EnvFileError(envPath, "Expected KEY=VALUE", index + 1);
    }
    const key = match[1]!;
    let value = match[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      if (value.length < 2 || !value.endsWith(quote) || value.slice(1, -1).includes(quote)) {
        throw new EnvFileError(envPath, "Invalid quoted value; multiline values are not supported", index + 1);
      }
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
