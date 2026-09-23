import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fail } from "../lib/errors.js";
import { rankFuzzy } from "../lib/fuzzy.js";
import { readOpencode } from "./opencode.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export type SessionDatabase = SqliteDatabase;

export interface RootSession {
  sessionId: string;
  updated: string;
  title: string;
  directory: string;
}

export interface SessionDetails {
  sessionId: string;
  title: string;
  directory: string;
  projectName: string;
  worktree: string;
  parentId: string;
  shareUrl: string;
  created: string;
  updated: string;
  archived: string;
}

export interface SessionCounts {
  messages: number;
  parts: number;
  todos: number;
}

export interface RecentTextPart {
  created: string;
  role: string;
  text: string;
}

export interface SessionActivity {
  sessionId: string;
  activityMs: number;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  worktree: string;
  sessions: number;
  rootSessions: number;
  lastUpdated: string;
}

export type SessionResolution =
  | { kind: "resolved"; sessionId: string }
  | { kind: "ambiguous"; matches: RootSession[] }
  | { kind: "not_found"; suggestions: RootSession[] };

function getDbPath(): string {
  const localPath = getDefaultDbPath();

  if (localPath) {
    return localPath;
  }

  try {
    const paths = readOpencode(["debug", "paths"]);
    const db = paths
      .split(/\r?\n/)
      .map((line) => /^\s*db\s+(.+?)\s*$/.exec(line)?.[1])
      .find((value): value is string => Boolean(value));

    if (db) {
      return db;
    }

    fail("OpenCode did not report its database path.");
  } catch (error) {
    fail(`Failed to resolve OpenCode database path: ${(error as Error).message}`);
  }
}

export function getSessionStorePath(): string {
  return getDbPath();
}

function getDefaultDbPath(): string | undefined {
  const home = homedir();
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  const candidates = [
    xdgDataHome ? path.join(xdgDataHome, "opencode", "opencode.db") : undefined,
    home ? path.join(home, ".local", "share", "opencode", "opencode.db") : undefined,
    home ? path.join(home, "Library", "Application Support", "opencode", "opencode.db") : undefined,
    localAppData ? path.join(localAppData, "opencode", "opencode.db") : undefined,
    appData ? path.join(appData, "opencode", "opencode.db") : undefined,
  ];

  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}

export function openSessionStore(): SessionDatabase {
  try {
    return openSqliteDatabase(getDbPath(), { readonly: true });
  } catch (error) {
    fail(`Failed to open SQLite database: ${(error as Error).message}`);
  }
}

export function openSessionStoreWritable(): SessionDatabase {
  try {
    return openSqliteDatabase(getDbPath(), { readonly: false });
  } catch (error) {
    fail(`Failed to open SQLite database: ${(error as Error).message}`);
  }
}

function listSessionsByWhereClause(
  db: SessionDatabase,
  whereClause: string,
  ...params: string[]
): RootSession[] {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      datetime(s.time_updated / 1000, 'unixepoch', 'localtime') as updated,
      replace(replace(s.title, char(10), ' '), char(13), ' ') as title,
      coalesce(nullif(s.directory, ''), p.worktree, '') as directory
    from session_v2 s
    left join project p on p.id = s.project_id
    where ${whereClause}
    order by s.time_updated desc
  `,
    )
    .all(...params) as RootSession[];
}

export function resolveSession(
  db: SessionDatabase,
  input: string,
  options: { allowTitle?: boolean } = {},
): SessionResolution {
  const { allowTitle = false } = options;
  const exactMatches = listSessionsByWhereClause(db, "s.id = ?", input);

  if (exactMatches.length === 1) {
    return { kind: "resolved", sessionId: exactMatches[0].sessionId };
  }

  if (allowTitle) {
    const titleMatches = listSessionsByWhereClause(db, "s.title = ?", input);

    if (titleMatches.length === 1) {
      return { kind: "resolved", sessionId: titleMatches[0].sessionId };
    }

    if (titleMatches.length > 1) {
      return { kind: "ambiguous", matches: titleMatches };
    }

    const titlePrefixMatches = listSessionsByWhereClause(
      db,
      "substr(s.title, 1, length(?)) = ?",
      input,
      input,
    );

    if (titlePrefixMatches.length === 1) {
      return { kind: "resolved", sessionId: titlePrefixMatches[0].sessionId };
    }

    if (titlePrefixMatches.length > 1) {
      return { kind: "ambiguous", matches: titlePrefixMatches };
    }
  }

  const prefixMatches = listSessionsByWhereClause(
    db,
    "substr(s.id, 1, length(?)) = ?",
    input,
    input,
  );

  if (prefixMatches.length === 0) {
    return { kind: "not_found", suggestions: findSessionMatches(db, input) };
  }

  if (prefixMatches.length > 1) {
    return { kind: "ambiguous", matches: prefixMatches };
  }

  return { kind: "resolved", sessionId: prefixMatches[0].sessionId };
}

export function resolveSessionId(
  db: SessionDatabase,
  input: string,
  options: { allowTitle?: boolean } = {},
): string {
  const resolution = resolveSession(db, input, options);

  if (resolution.kind === "resolved") {
    return resolution.sessionId;
  }

  if (resolution.kind === "ambiguous") {
    fail(
      `! Session is ambiguous: ${input}\n\n` +
        resolution.matches.map((row) => `${row.sessionId}\t${row.title}`).join("\n"),
    );
  }

  if (resolution.suggestions.length > 0) {
    fail(
      `! Session not found: ${input}\n\n` +
        `Closest matches:\n${resolution.suggestions.map((row) => `${row.sessionId}\t${row.title}`).join("\n")}`,
    );
  }

  fail(`! Session not found: ${input}`);
}

function listSearchableSessions(db: SessionDatabase): RootSession[] {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      datetime(s.time_updated / 1000, 'unixepoch', 'localtime') as updated,
      replace(replace(s.title, char(10), ' '), char(13), ' ') as title,
      coalesce(nullif(s.directory, ''), p.worktree, '') as directory
    from session_v2 s
    left join project p on p.id = s.project_id
    where s.parent_id is null
    order by s.time_updated desc
    limit 3000
  `,
    )
    .all() as RootSession[];
}

export function findSessionMatches(db: SessionDatabase, input: string, limit = 10): RootSession[] {
  const ranked = rankFuzzy(
    listSearchableSessions(db),
    input,
    (session) => `${session.sessionId} ${session.title} ${session.directory}`,
    limit,
  );

  return ranked.map((row) => row.item);
}

export function listRootSessions(db: SessionDatabase): RootSession[] {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      datetime(s.time_updated / 1000, 'unixepoch', 'localtime') as updated,
      replace(replace(s.title, char(10), ' '), char(13), ' ') as title,
      coalesce(nullif(s.directory, ''), p.worktree, '') as directory
    from session_v2 s
    left join project p on p.id = s.project_id
    where s.parent_id is null
    order by s.time_updated desc
  `,
    )
    .all() as RootSession[];
}

export function listProjects(db: SessionDatabase): ProjectSummary[] {
  return db
    .prepare(
      `
    select
      p.id as projectId,
      coalesce(nullif(p.name, ''), p.id) as name,
      coalesce(p.worktree, '') as worktree,
      count(s.id) as sessions,
      sum(case when s.id is not null and s.parent_id is null then 1 else 0 end) as rootSessions,
      coalesce(
        datetime(max(coalesce(s.time_updated, s.time_created)) / 1000, 'unixepoch', 'localtime'),
        ''
      ) as lastUpdated
    from project p
    left join session_v2 s on s.project_id = p.id
    group by p.id
    order by max(coalesce(s.time_updated, s.time_created)) desc, p.id asc
  `,
    )
    .all() as ProjectSummary[];
}

export function listRootSessionsForDirectory(
  db: SessionDatabase,
  directory: string,
): RootSession[] {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      datetime(s.time_updated / 1000, 'unixepoch', 'localtime') as updated,
      replace(replace(s.title, char(10), ' '), char(13), ' ') as title,
      coalesce(nullif(s.directory, ''), p.worktree, '') as directory
    from session_v2 s
    left join project p on p.id = s.project_id
    where s.parent_id is null
      and coalesce(nullif(s.directory, ''), p.worktree, '') = ?
    order by s.time_updated desc
  `,
    )
    .all(directory) as RootSession[];
}

export function getLatestSessionForDirectorySince(
  db: SessionDatabase,
  directory: string,
  sinceMs: number,
): SessionActivity | undefined {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      max(coalesce(s.time_updated, 0), coalesce(s.time_created, 0)) as activityMs
    from session_v2 s
    left join project p on p.id = s.project_id
    where coalesce(nullif(s.directory, ''), p.worktree, '') = ?
      and max(coalesce(s.time_updated, 0), coalesce(s.time_created, 0)) >= ?
    order by activityMs desc
    limit 1
  `,
    )
    .get(directory, sinceMs) as SessionActivity | undefined;
}

export function getLatestRootSessionForDirectoryCreatedSince(
  db: SessionDatabase,
  directory: string,
  sinceMs: number,
): SessionActivity | undefined {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      coalesce(s.time_created, 0) as activityMs
    from session_v2 s
    left join project p on p.id = s.project_id
    where s.parent_id is null
      and coalesce(nullif(s.directory, ''), p.worktree, '') = ?
      and coalesce(s.time_created, 0) >= ?
    order by coalesce(s.time_created, 0) desc
    limit 1
  `,
    )
    .get(directory, sinceMs) as SessionActivity | undefined;
}

export function getLatestSessionForDirectory(
  db: SessionDatabase,
  directory: string,
): SessionActivity | undefined {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      max(coalesce(s.time_updated, 0), coalesce(s.time_created, 0)) as activityMs
    from session_v2 s
    left join project p on p.id = s.project_id
    where coalesce(nullif(s.directory, ''), p.worktree, '') = ?
    order by activityMs desc
    limit 1
  `,
    )
    .get(directory) as SessionActivity | undefined;
}

export function getSession(db: SessionDatabase, id: string): SessionDetails | undefined {
  return db
    .prepare(
      `
    select
      s.id as sessionId,
      replace(replace(replace(s.title, char(9), ' '), char(10), ' '), char(13), ' ') as title,
      coalesce(s.directory, '') as directory,
      coalesce(p.name, '') as projectName,
      coalesce(p.worktree, '') as worktree,
      coalesce(s.parent_id, '') as parentId,
      coalesce(s.share_url, '') as shareUrl,
      coalesce(datetime(s.time_created / 1000, 'unixepoch', 'localtime'), '') as created,
      coalesce(datetime(s.time_updated / 1000, 'unixepoch', 'localtime'), '') as updated,
      coalesce(datetime(s.time_archived / 1000, 'unixepoch', 'localtime'), '') as archived
    from session_v2 s
    left join project p on p.id = s.project_id
    where s.id = ?
  `,
    )
    .get(id) as SessionDetails | undefined;
}

export function getSessionDirectory(db: SessionDatabase, id: string): string {
  const row = db
    .prepare(
      `
    select coalesce(nullif(s.directory, ''), p.worktree, '') as directory
    from session_v2 s
    left join project p on p.id = s.project_id
    where s.id = ?
  `,
    )
    .get(id) as { directory: string } | undefined;

  return row ? row.directory : "";
}

export function getSessionProjectId(db: SessionDatabase, id: string): string | undefined {
  const row = db
    .prepare(
      `
    select s.project_id as projectId
    from session_v2 s
    where s.id = ?
  `,
    )
    .get(id) as { projectId: string } | undefined;

  return row?.projectId;
}

export function sessionExists(db: SessionDatabase, id: string): boolean {
  const row = db
    .prepare(
      `
    select 1 as value
    from session_v2 s
    where s.id = ?
    limit 1
  `,
    )
    .get(id) as { value: number } | undefined;

  return row !== undefined;
}

export function deleteProjectIfUnused(db: SessionDatabase, projectId: string): boolean {
  if (!projectId || projectId === "global") {
    return false;
  }

  const row = db
    .prepare(
      `
    select count(*) as count
    from session_v2 s
    where s.project_id = ?
  `,
    )
    .get(projectId) as { count: number };

  if (row.count > 0) {
    return false;
  }

  const result = db
    .prepare(
      `
    delete from project
    where id = ?
  `,
    )
    .run(projectId);

  return result.changes > 0;
}

export function deleteUnusedProjects(db: SessionDatabase): number {
  const result = db
    .prepare(
      `
    delete from project
    where id <> 'global'
      and not exists (
        select 1
        from session_v2 s
        where s.project_id = project.id
      )
  `,
    )
    .run();

  return result.changes;
}

export function getSessionCounts(db: SessionDatabase, id: string): SessionCounts {
  return db
    .prepare(
      `
    select
      count(*) as messages,
      coalesce(sum(
        case
          when json_type(data, '$.content') = 'array' then json_array_length(data, '$.content')
          when json_type(data, '$.text') = 'text' then 1
          else 0
        end
      ), 0) as parts,
      0 as todos
    from session_message
    where session_id = ?
  `,
    )
    .get(id) as SessionCounts;
}

export function getRecentTextParts(db: SessionDatabase, id: string): RecentTextPart[] {
  const rows = db
    .prepare(
      `
    select
      datetime(time_created / 1000, 'unixepoch', 'localtime') as created,
      upper(type) as role,
      data
    from session_message
    where session_id = ?
    order by seq desc
    limit 30
  `,
    )
    .all(id) as Array<{ created: string; role: string; data: string }>;

  const parts: RecentTextPart[] = [];
  for (const row of rows) {
    let data: { text?: unknown; content?: unknown };
    try {
      data = JSON.parse(row.data) as typeof data;
    } catch {
      continue;
    }
    const values = [
      typeof data.text === "string" ? data.text : "",
      ...(Array.isArray(data.content)
        ? data.content
            .filter(
              (part): part is { type: "text"; text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
            )
            .map((part) => part.text)
        : []),
    ];
    for (const value of values) {
      const text = value.replace(/[\r\n]+/g, " ").slice(0, 160);
      if (text) {
        parts.push({ created: row.created, role: row.role, text });
      }
      if (parts.length === 10) {
        return parts;
      }
    }
  }
  return parts;
}
