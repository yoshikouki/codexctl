import { appendFile } from "node:fs/promises";
import type { AppServerEvent } from "./app-server.ts";

export function isApprovalRequest(method: string): boolean {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "execCommandApproval"
    || method === "applyPatchApproval";
}

export async function readRawEvents(path: string): Promise<unknown[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export async function readTailEvents(path: string, limit: number): Promise<unknown[]> {
  if (limit <= 0) return [];
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  let offset = file.size;
  let tail = Buffer.alloc(0);
  while (offset > 0) {
    const start = Math.max(0, offset - 64 * 1024);
    tail = Buffer.concat([Buffer.from(await file.slice(start, offset).arrayBuffer()), tail]);
    offset = start;
    const lines = tail.toString("utf8").split("\n");
    if (offset > 0) lines.shift(); // The first line may start before this chunk.
    const records = lines.filter(line => line.trim().length > 0);
    if (records.length >= limit || offset === 0) {
      return records.slice(-limit).map(line => JSON.parse(line) as unknown);
    }
  }
  return [];
}

export async function appendEvent(dir: string, event: AppServerEvent): Promise<void> {
  await appendFile(`${dir}/events.jsonl`, JSON.stringify(event) + "\n");
}

export async function readNewCompleteLines(path: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], offset };
  const size = file.size;
  if (offset > size) offset = 0;
  if (offset === size) return { lines: [], offset };

  const chunk = await file.slice(offset, size).text();
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) return { lines: [], offset };

  const consumed = chunk.slice(0, lastNewline + 1);
  return {
    lines: consumed
      .split("\n")
      .filter((line) => line.trim().length > 0),
    offset: offset + new TextEncoder().encode(consumed).byteLength,
  };
}
