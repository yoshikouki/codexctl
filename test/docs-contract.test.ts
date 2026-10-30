import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";

test("documented commands and flags exist in the CLI, including per-command flags", async () => {
  const root = join(import.meta.dir, "..");
  const source = await Bun.file(join(root, "src/cli.ts")).text();
  const commands = new Map<string, Set<string>>();
  for (const match of source.matchAll(/if \(resource === "(job|approval)" && action === "([^"]+)"[^\n]*\n([\s\S]*?)(?=^  if |^  throw)/gm)) {
    const allowed = match[3]!.match(/allowFlags\(args, \[([^\]]*)\]/)![1]!;
    commands.set(`${match[1]} ${match[2]}`, new Set([...allowed.matchAll(/"([^"]+)"/g)].map(m => m[1]!)));
  }
  const publicFlags = new Set([...commands.values()].flatMap(flags => [...flags]).concat("help"));
  const files = ["README.md", "docs/codexctl-agent-contract.md"];
  for await (const path of new Bun.Glob("skills/codexctl/**/*.md").scan(root)) files.push(path);
  for (const file of files) {
    const text = await Bun.file(join(root, file)).text();
    for (const match of text.matchAll(/\b(job|approval) ([a-z]+)\b/g)) {
      expect(commands.has(match[0]), `${file}: ${match[0]}`).toBe(true);
    }
    for (const match of text.matchAll(/--([a-z][a-z-]*)/g)) {
      expect(publicFlags.has(match[1]!), `${file}: ${match[0]}`).toBe(true);
    }
    for (const line of text.split("\n")) {
      // Contract table rows and executable examples must use their command's flags.
      const command = line.match(/^(?:\| `codexctl |codexctl |bun run src\/cli.ts )(job|approval) ([a-z]+)\b/);
      if (!command) continue;
      const name = `${command[1]} ${command[2]}`;
      const input = line.startsWith("|") ? line.split("|")[2]! : line;
      const flags = line.startsWith("|")
        ? [...input.matchAll(/--([a-z][a-z-]*)/g)].map(m => m[1]!)
        : [...parseArgs(input.match(/"[^"]*"|'[^']*'|\S+/g)!).flags.keys()];
      for (const flag of flags) expect(commands.get(name)!.has(flag), `${file}: ${name} --${flag}`).toBe(true);
    }
  }
});
