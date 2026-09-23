import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getRecentTextParts,
  getSession,
  getSessionCounts,
  listProjects,
  listRootSessions,
} from "../src/services/sessions.js";
import { openSqliteDatabase } from "../src/services/sqlite.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("OpenCode v2 session store", () => {
  test("lists and inspects native v2 projections", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-s-v2-"));
    roots.push(root);
    const filename = path.join(root, "opencode.db");
    const setup = new Database(filename, { create: true });
    setup.exec(`
      create table project (id text primary key, name text, worktree text);
      create table session_v2 (
        id text primary key, project_id text, parent_id text, title text,
        directory text, share_url text, agent text, model text,
        time_created integer, time_updated integer, time_archived integer
      );
      create table session_message (
        id text primary key, session_id text, type text, seq integer,
        time_created integer, data text
      );
      insert into project values ('project-1', 'Project One', '/tmp/project');
      insert into session_v2 values (
        'ses-v2', 'project-1', null, 'V2 title', '/tmp/project', null, 'build',
        '{"providerID":"openai","id":"gpt-test"}', 1700000000000, 1700000001000, null
      );
      insert into session_message values (
        'msg-user', 'ses-v2', 'user', 1, 1700000000000, '{"text":"Hello v2"}'
      );
      insert into session_message values (
        'msg-assistant', 'ses-v2', 'assistant', 2, 1700000001000,
        '{"content":[{"type":"text","text":"Ready"},{"type":"tool","name":"bash"}]}'
      );
    `);
    setup.close();

    const db = openSqliteDatabase(filename, { readonly: true });
    try {
      expect(listRootSessions(db)).toHaveLength(1);
      expect(listProjects(db)[0]).toMatchObject({ sessions: 1, rootSessions: 1 });
      expect(getSession(db, "ses-v2")).toMatchObject({ title: "V2 title", projectName: "Project One" });
      expect(getSessionCounts(db, "ses-v2")).toEqual({ messages: 2, parts: 3, todos: 0 });
      expect(getRecentTextParts(db, "ses-v2").map((part) => part.text)).toEqual([
        "Ready",
        "Hello v2",
      ]);
    } finally {
      db.close();
    }
  });
});
