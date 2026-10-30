import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTailEvents } from "../src/events.ts";

test("event tail skips old records and preserves Unicode across chunk boundaries", async () => {
  const tmp = await mkdtemp("/tmp/codexctl-tail-");
  try {
    const path = join(tmp, "events.jsonl");
    const events = [{ text: "😀".repeat(20_000) }, { type: "second" }, { type: "last" }];
    await Bun.write(path, "unparsed history".repeat(10_000) + "\n" + events.map(e => JSON.stringify(e)).join("\n \n") + "\n");
    expect(await readTailEvents(path, 1)).toEqual(events.slice(-1));
    expect(await readTailEvents(path, 3)).toEqual(events);
    await Bun.write(path, JSON.stringify(events[1]));
    expect(await readTailEvents(path, 5)).toEqual([events[1]]);
    expect(await readTailEvents(tmp, 0)).toEqual([]);
    expect(await readTailEvents(join(tmp, "missing"), 5)).toEqual([]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
