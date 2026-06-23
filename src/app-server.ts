import { join } from "node:path";
import type { ReadableStreamDefaultReader as NodeReadableStreamDefaultReader } from "node:stream/web";

export type JsonObject = Record<string, unknown>;

export type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcServerRequest = {
  id: number;
  method: string;
  params?: unknown;
};

export type AppServerEvent =
  | { direction: "client"; message: JsonRpcRequest | JsonRpcNotification; at: string }
  | { direction: "server"; message: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest; at: string }
  | { direction: "worker"; event: JsonObject; at: string }
  | { direction: "control"; command: JsonObject; at: string };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class AppServerClient {
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #stderr: Promise<string>;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #buffer = "";
  #events: AppServerEvent[] = [];
  #onEvent?: (event: AppServerEvent) => Promise<void> | void;
  #readLoopDone: Promise<void>;

  constructor(onEvent?: (event: AppServerEvent) => Promise<void> | void) {
    this.#proc = Bun.spawn(["codex", "app-server", "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = this.#proc.stdout.getReader();
    this.#stderr = new Response(this.#proc.stderr).text();
    this.#onEvent = onEvent;
    this.#readLoopDone = this.#readLoop(reader);
    this.#proc.exited.then((exitCode) => {
      if (exitCode !== 0 && this.#pending.size > 0) {
        this.#rejectAll(new Error(`codex app-server exited with ${exitCode}`));
      }
    });
  }

  get events(): readonly AppServerEvent[] {
    return this.#events;
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "codexctl",
        title: "codexctl",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.notify("initialized");
    return result;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const message: JsonRpcRequest = params === undefined ? { id, method } : { id, method, params };
    await this.#emit({ direction: "client", message, at: new Date().toISOString() });
    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      this.#proc.stdin.write(JSON.stringify(message) + "\n");
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return await response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = params === undefined ? { method } : { method, params };
    await this.#emit({ direction: "client", message, at: new Date().toISOString() });
    this.#proc.stdin.write(JSON.stringify(message) + "\n");
  }

  async close(): Promise<void> {
    this.#proc.kill();
    await this.#proc.exited.catch(() => undefined);
    await this.#readLoopDone.catch(() => undefined);
  }

  async stderr(): Promise<string> {
    return await this.#stderr;
  }

  async #readLoop(reader: NodeReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.#buffer += decoder.decode(chunk.value, { stream: true });
        await this.#drainLines();
      }
      this.#rejectAll(new Error("codex app-server stdout closed"));
    } catch (error) {
      this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async #drainLines(): Promise<void> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
      try {
        message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
      } catch (error) {
        throw new Error(`Failed to parse app-server JSON-RPC line: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.#emit({ direction: "server", message, at: new Date().toISOString() });
      if ("id" in message && !("method" in message)) {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  async #emit(event: AppServerEvent): Promise<void> {
    this.#events.push(event);
    await this.#onEvent?.(event);
  }

  async closed(): Promise<void> {
    await this.#readLoopDone;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export async function readDaemonVersion(): Promise<JsonObject> {
  const proc = Bun.spawn(["codex", "app-server", "daemon", "version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || `codex app-server daemon version exited with ${exitCode}`);
  }
  return JSON.parse(stdout) as JsonObject;
}

export function jobDir(root: string, key: string): string {
  assertJobKey(key);
  return join(root, ".codexctl", "jobs", key);
}

export function assertJobKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) || key.includes("..")) {
    throw new Error("Job key must be 1-128 chars of letters, numbers, dot, underscore, or dash; it cannot contain '..'");
  }
}
