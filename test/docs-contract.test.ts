import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";

const COMMAND_BLOCK =
  /if \(resource === "(?<resource>job|approval)" && action === "(?<action>[^"]+)"[^\n]*\n(?<body>[\s\S]*?)(?=^ {2}if |^ {2}throw|^ {2}return false;)/gmu;
const ALLOWED_FLAGS = /allowFlags\(args, \[(?<flags>[^\]]*)\]/u;
const QUOTED_FLAG = /"(?<flag>[^"]+)"/gu;
const DOCUMENTED_COMMAND = /\b(?:job|approval) [a-z]+\b/gu;
const FLAG = /--(?<flag>[a-z][a-z-]*)/gu;
const COMMAND_LINE =
  /^(?:\| `codexctl |codexctl |bun run src\/cli.ts )(?<resource>job|approval) (?<action>[a-z]+)\b/u;
const ARGUMENT = /"[^"]*"|'[^']*'|\S+/gu;

test("documented commands and flags exist in the CLI, including per-command flags", async () => {
  const root = join(import.meta.dir, "..");
  const source = await Bun.file(join(root, "src/cli.ts")).text();
  const commands = new Map<string, Set<string>>();
  for (const match of source.matchAll(COMMAND_BLOCK)) {
    const { resource, action, body } = match.groups!;
    const allowed = body!.match(ALLOWED_FLAGS)!.groups!.flags!;
    commands.set(
      `${resource} ${action}`,
      new Set([...allowed.matchAll(QUOTED_FLAG)].map((m) => m.groups!.flag!))
    );
  }
  expect(commands.size).toBe(13);
  const publicFlags = new Set(
    [...commands.values()].flatMap((flags) => [...flags]).concat("help", "json")
  ); // --json is parsed and ignored by parseArgs; output is always JSON.
  const files = ["README.md", "docs/codexctl-agent-contract.md"];
  for await (const path of new Bun.Glob("skills/codexctl/**/*.md").scan(root)) {
    files.push(path);
  }
  for (const file of files) {
    // biome-ignore lint/performance/noAwaitInLoops: Report documentation assertions in file order so the first failing example is reproducible.
    const text = await Bun.file(join(root, file)).text();
    for (const match of text.matchAll(DOCUMENTED_COMMAND)) {
      expect(commands.has(match[0]), `${file}: ${match[0]}`).toBe(true);
    }
    for (const match of text.matchAll(FLAG)) {
      expect(publicFlags.has(match.groups!.flag!), `${file}: ${match[0]}`).toBe(
        true
      );
    }
    for (const line of text.split("\n")) {
      const command = line.match(COMMAND_LINE);
      if (!command) {
        continue;
      }
      const name = `${command.groups!.resource} ${command.groups!.action}`;
      const input = line.startsWith("|") ? line.split("|")[2]! : line;
      const flags = line.startsWith("|")
        ? [...input.matchAll(FLAG)].map((m) => m.groups!.flag!)
        : [...parseArgs(input.match(ARGUMENT)!).flags.keys()];
      for (const flag of flags) {
        expect(
          commands.get(name)!.has(flag),
          `${file}: ${name} --${flag}`
        ).toBe(true);
      }
    }
  }
});
