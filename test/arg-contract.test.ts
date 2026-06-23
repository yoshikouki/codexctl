import { describe, expect, test } from "bun:test";
import { assertJobKey } from "../src/app-server.ts";
import { readJobEvents } from "../src/job.ts";

describe("event store", () => {
  test("missing job events read as an empty list", async () => {
    expect(await readJobEvents("missing-test-job")).toEqual([]);
  });
});

describe("job key contract", () => {
  test("accepts agent-safe keys", () => {
    expect(() => assertJobKey("dogfood-review_1.2")).not.toThrow();
  });

  test("rejects traversal and empty keys", () => {
    expect(() => assertJobKey("../oops")).toThrow();
    expect(() => assertJobKey("")).toThrow();
  });
});
