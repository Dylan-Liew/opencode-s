# opencode-s

`opencode-s` installs the `oc` CLI, a small tool for listing, inspecting, resuming, and deleting OpenCode sessions from the local session database.

> [!IMPORTANT]
> Version 1.x supports OpenCode v2 only. OpenCode v1 is no longer supported; use the final 0.x release if you must remain on v1.

## Requirements

- Node.js `>=24` or Bun `>=1.1.0`
- OpenCode v2 available in your shell

`opencode-s` can be installed with npm or Bun. It uses runtime-native SQLite:
Node runs use `node:sqlite`, and Bun runs use `bun:sqlite`. The package does
not depend on `better-sqlite3` or any other third-party native SQLite addon.

## Install

From npm after publishing:

```bash
npm install -g opencode-s
```

From Bun:

```bash
bun add -g opencode-s
```

The default `oc` binary runs on Node.js. A Bun-specific binary is also exposed
as `oc-bun` for users who want to run the same CLI under Bun.

For local development from this repository:

```bash
bun install
bun link
```

You can also run the built CLI directly:

```bash
bun run build
node ./dist/cli/index.js list
bun ./dist/cli/index.js list
```

## Usage

```text
oc <command>

Commands:
  new                  Start a new OpenCode session
  resume, r [session]  Launch opencode in the session directory
  list, ls             List root sessions across all projects
  view, v <session>    Show session metadata and recent text parts
  rename, mv <session> <title...>
                       Rename a session title
  delete, d, rm [session..]
                       Delete sessions via opencode after confirmation
  projects, p          List OpenCode projects and session counts
  cleanup              Clean stale OpenCode DB/cache artifacts
  help                 Show CLI help
  completion           Print a fish completion script
```

## Session lookup

`<session>` is required for `view` and `rename`. `[session]` is optional for `resume` and `delete`.

When a session value is provided, the CLI resolves it in this order:

1. Exact session ID match
2. Exact session title match
3. Unique session title prefix match
4. Unique session ID prefix match

When `oc delete` is run without arguments, it opens an interactive multi-select picker. In TTY mode, type to filter, use `Space` to toggle sessions, and press `Enter` to continue. In non-TTY mode, enter numbers and ranges like `1,3,5-8`.

Deletion asks for `y/N` confirmation before any sessions are removed.
Rename and delete operations use OpenCode v2's service API; reads use its
`session_v2` and `session_message` projections.

`oc cleanup` only removes stale legacy session-diff cache files. Add
`--vacuum` to ask SQLite to reclaim unused database pages; v2 projects are
left under OpenCode's ownership.

## Quick workflows

```bash
oc help
oc new
oc resume
oc list
oc projects
oc rename ses_abc123 "better title"
oc delete
oc delete ses_abc123 ses_def456
oc cleanup
oc cleanup --vacuum
```

## Optional Fish completions

If you use Fish, install a completion file into Fish's user completion directory:

```bash
mkdir -p ~/.config/fish/completions
oc completion fish > ~/.config/fish/completions/oc.fish
```

Open a new Fish shell after installing the file, or run:

```fish
source ~/.config/fish/completions/oc.fish
```
