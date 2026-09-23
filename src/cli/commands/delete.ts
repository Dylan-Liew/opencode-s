import fs from "node:fs";
import process from "node:process";
import type { CommandModule } from "yargs";
import { fail } from "../../lib/errors.js";
import { resolveSessionIdInteractively, selectSessionIds } from "../session-picker.js";
import { sanitizeInline } from "../../output/format.js";
import { confirmDelete } from "../../output/prompt.js";
import { formatTable } from "../../output/table.js";
import { runOpencodeWithStatus } from "../../services/opencode.js";
import {
  getSession,
  listRootSessions,
  openSessionStore,
  type SessionDetails,
} from "../../services/sessions.js";

interface DeleteTarget {
  session: SessionDetails;
  workingDirectory: string;
}

function getDeleteWorkingDirectory(id: string, directory: string): string {
  if (!directory) {
    process.stderr.write(
      `No directory found for session ${id}; deleting from ${process.cwd()} instead.\n`,
    );
    return process.cwd();
  }

  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    process.stderr.write(
      `Session directory does not exist: ${directory}; deleting from ${process.cwd()} instead.\n`,
    );
    return process.cwd();
  }

  return directory;
}

async function resolveDeleteSessionId(
  db: ReturnType<typeof openSessionStore>,
  input: string,
): Promise<string> {
  return resolveSessionIdInteractively(db, input, { allowTitle: true });
}

async function resolveDeleteSessionIds(
  db: ReturnType<typeof openSessionStore>,
  inputs: string[],
): Promise<string[]> {
  if (inputs.length > 0) {
    const ids = await Promise.all(inputs.map((input) => resolveDeleteSessionId(db, input)));
    return [...new Set(ids)];
  }

  return selectSessionIds(listRootSessions(db));
}

function renderDeletePlan(targets: DeleteTarget[]): string {
  return formatTable(
    ["id", "updated", "title", "directory"],
    targets.map((target) => [
      target.session.sessionId.slice(0, 20),
      target.session.updated,
      sanitizeInline(target.session.title),
      target.session.directory || target.session.worktree || target.workingDirectory,
    ]),
  );
}

export async function runDeleteCommand(inputs: string[]): Promise<void> {
  const db = openSessionStore();
  const targets: DeleteTarget[] = [];

  try {
    const ids = await resolveDeleteSessionIds(db, inputs);

    for (const id of ids) {
      const session = getSession(db, id);

      if (!session) {
        fail(`Session not found: ${id}`);
      }

      const directory = session.directory || session.worktree;
      targets.push({
        session,
        workingDirectory: getDeleteWorkingDirectory(id, directory),
      });
    }
  } finally {
    db.close();
  }

  process.stdout.write(`\nDelete ${targets.length} OpenCode session(s):\n\n`);
  process.stdout.write(renderDeletePlan(targets));

  if (!(await confirmDelete("\nDelete selected sessions? [y/N] "))) {
    fail("Cancelled.");
  }

  let exitCode = 0;
  for (const target of targets) {
    const status = runOpencodeWithStatus(
      ["session", "delete", target.session.sessionId],
      target.workingDirectory,
    );

    if (status !== 0) {
      exitCode = status;
    }
  }

  process.exit(exitCode);
}

export const deleteCommand: CommandModule = {
  command: "delete [session..]",
  aliases: ["d", "rm"],
  describe: "Delete the session via opencode after confirmation",
  builder: (yargs) =>
    yargs.positional("session", {
      describe: "Session ID, unique prefix, or title",
      type: "string",
      array: true,
    }),
  handler: async (argv) => {
    const session = (argv as { session?: unknown }).session;
    await runDeleteCommand(Array.isArray(session) ? session.map(String) : []);
  },
};
