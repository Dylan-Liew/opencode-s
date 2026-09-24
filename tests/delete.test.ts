import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-delete-test-"));
  roots.push(root);
  const data = path.join(root, "data");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
  fs.mkdirSync(bin);
  const db = new Database(path.join(data, "opencode", "opencode.db"), { create: true });
  db.exec(`
    create table project (id text primary key, name text, worktree text);
    create table session_v2 (
      id text primary key, project_id text, parent_id text, title text,
      directory text, share_url text, agent text, model text,
      time_created integer, time_updated integer, time_archived integer
    );
  `);
  db.prepare("insert into project values ('p', 'Test', ?)").run(root);
  db.prepare(
    "insert into session_v2 values ('ses-test', 'p', null, 'Test session', ?, null, '', '', 1, 2, null)",
  ).run(root);
  db.close();
  const record = path.join(root, "calls.jsonl");
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.OC_TEST_RECORD, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}) + '\\n');
process.exit(Number(process.env.OC_TEST_STATUS || 0));
`,
    { mode: 0o700 },
  );
  return {
    root,
    record,
    run(answer: string, status = 0) {
      return spawnSync(process.execPath, [cli, "delete", "ses-test"], {
        input: answer + "\n",
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          XDG_DATA_HOME: data,
          PATH: bin + path.delimiter + process.env.PATH,
          OC_TEST_RECORD: record,
          OC_TEST_STATUS: String(status),
        },
      });
    },
  };
}

describe("session deletion delegation", () => {
  test("invokes native OpenCode deletion with the selected ID and directory", () => {
    const f = fixture();
    const result = f.run("y");
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.record, "utf8").trim())).toEqual({
      args: ["session", "delete", "ses-test"],
      cwd: f.root,
    });
  });
  test("propagates a native deletion failure", () => {
    const f = fixture();
    expect(f.run("y", 7).status).toBe(7);
  });
  test("does not invoke deletion when confirmation is declined", () => {
    const f = fixture();
    expect(f.run("n").status).not.toBe(0);
    expect(fs.existsSync(f.record)).toBe(false);
  });
});
