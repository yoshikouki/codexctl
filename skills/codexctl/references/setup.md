# codexctl Setup

Use this reference only when `codexctl` is missing, stale, or being packaged for another agent.

## Local Repository Setup

Recommended development checkout:

```sh
ghq get https://github.com/yoshikouki/codexctl.git
cd "$(ghq root)/github.com/yoshikouki/codexctl"
bun install
bun run typecheck
bun run test
./src/cli.ts doctor --json
```

If `ghq` is unavailable, clone with Git and run the same Bun commands.

## Running the CLI from Source

Use either:

```sh
./src/cli.ts doctor --json
```

or:

```sh
bun run codexctl -- doctor --json
```

When installed as a package, use:

```sh
codexctl doctor --json
```

## Requirements

- Bun, preferably current stable.
- A working `codex` CLI with app-server support.
- The local Codex app-server daemon must be usable by `codexctl doctor --json`.

## Installing the Skill

The skill folder is:

```text
skills/codexctl/
```

Install or update it with the user's skill manager instead of copying individual files by hand.

For local Codex skill installs, use the manager-supported GitHub install or update path when available, for example:

```sh
npx skills add yoshikouki/codexctl --skill codexctl
npx skills update codexctl
```

If the manager requires a local path, point it at:

```text
skills/codexctl
```

Observed behavior with `npx skills add` is copy-based for global installs, including local path installs:

```sh
npx skills add . --skill codexctl --global
```

This installs a copy under the manager's global skill directory rather than a live symlink to the working tree. Re-run the add/update command after editing the repository copy.

Do not edit installed copies directly when the repository copy can be updated and reinstalled. This keeps `npx skills` and marketplace update mechanisms able to replace the skill cleanly.

## Packaging Notes

The skill follows the portable agent-skill shape:

```text
skills/codexctl/
├── SKILL.md
├── agents/openai.yaml
└── references/
```

`SKILL.md` contains trigger metadata and short workflow instructions.

`agents/openai.yaml` contains UI-facing metadata for agent skill lists and marketplace-style surfaces.

Detailed command behavior belongs in `codexctl --help` and `docs/codexctl-agent-contract.md`, not in the skill.

## Updating

When `codexctl` behavior changes:

1. Update `docs/codexctl-agent-contract.md` or `codexctl --help` for command truth.
2. Update this skill only when agent workflow or discovery guidance changes.
3. Validate the skill folder.
4. Commit and push the repository.
5. Use the skill manager's update command to refresh installed copies.
