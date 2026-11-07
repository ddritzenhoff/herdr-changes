import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPage, fileTree, hitLine, layoutFor } from "../mods/review/page.js";

const meta = { path: "src/a.rs", status: "M", fingerprint: "v1" };
const data = { snapshot: "frozen", path: meta.path, diff: { rows: [
  { kind: "hunk", text: "@@ old 2 new 2 @@" },
  { kind: "old", side: "old", number: 2, old_number: 2, text: "old", spans: [] },
  { kind: "new", side: "new", number: 2, new_number: 2, text: "new", spans: [] },
] } };
const entries = new Map([[meta.path, { data, meta, context: 3 }]]);
const draft = { id: "c1", path: meta.path, snapshot: "frozen", side: "old", start: 2, end: 2, body: "Why delete?", quote: "old" };

test("file tree nests folders, preserves full paths and folds only the requested folder", () => {
  const files = [{ path: "src/a.rs" }, { path: "src/nested/b.rs" }, { path: "README.md" }];
  const tree = fileTree(files);
  assert.deepEqual(tree.map(n => n.path), ["src", "src/nested", "src/nested/b.rs", "src/a.rs", "README.md"]);
  assert.equal(tree.find(n => n.path === "src/nested/b.rs").depth, 2);
  assert.deepEqual(fileTree(files, new Set(["src"])).map(n => n.path), ["src", "README.md"]);
});

test("automatic layouts, stable line keys, inline editor and old-side draft placement", () => {
  assert.equal(layoutFor("A"), "unified"); assert.equal(layoutFor("D"), "unified"); assert.equal(layoutFor("M"), "split");
  const selection = { path: meta.path, snapshot: "frozen", side: "old", start: 2, end: 2 };
  const rows = buildPage([meta], entries, [draft], selection);
  assert.deepEqual(rows.map(r => r.kind), ["file", "hunk", "split", "comment", "editor", "end", "spacer"]);
  assert.equal(rows[2].key, "code:frozen:2:2");
  assert.equal(rows[3].outdated, false);
  const changedHunks = { ...data, diff: { rows: [{ kind: "hunk", text: "expanded context" }, ...data.diff.rows.slice(1)] } };
  assert.equal(buildPage([meta], new Map([[meta.path, { data: changedHunks, meta }]]), [], null)[2].key, rows[2].key);
});

test("outdated comments retain their quote and can be edited inline without moving anchors", () => {
  const stale = { ...draft, snapshot: "previous" };
  const rows = buildPage([meta], entries, [stale], { ...stale, commentId: stale.id });
  const index = rows.findIndex(r => r.kind === "comment");
  assert.equal(rows[index].outdated, true); assert.equal(rows[index].comment.quote, "old");
  assert.equal(rows[index + 1].kind, "editor");
  const orphan = buildPage([], new Map(), [stale], null);
  assert.equal(orphan[0].meta.status, "draft"); assert.equal(orphan.find(r => r.kind === "comment").outdated, true);
});

test("collapse hides code and drafts without deleting them; plus hitbox ignores code text and empty split halves", () => {
  const rows = buildPage([meta], entries, [draft], null, { collapsed: new Set([meta.path]) });
  assert.deepEqual(rows.map(r => r.kind), ["file", "spacer"]);
  const row = buildPage([meta], entries, [], null).find(r => r.kind === "split");
  assert.deepEqual(hitLine(row, { x: 10, width: 800 }), { side: "old", number: 2 });
  assert.deepEqual(hitLine(row, { x: 410, width: 800 }), { side: "new", number: 2 });
  assert.equal(hitLine(row, { x: 600, width: 800 }), null);
  assert.equal(hitLine({ ...row, old: null }, { x: 10, width: 800 }), null);
});

const launcher = (await readFile(new URL("../mods/review-tabs/launcher.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
async function launch({ registry = {}, terminal = "t1", focusTab = "agent", root = "/repo" } = {}) {
  const calls = [], notices = [];
  const state = { "review.tabs": registry };
  const sandbox = {
    focused: () => ({ terminal, tab: focusTab }),
    agents: () => [{ address: "t1", space: "s1", tab: "agent", program: { name: "Pi" } }],
    terminals: () => [{ address: "t1", cwd: "/shell-is-not-the-agent", foreground: { cwd: root } }],
    spaces: () => [{ id: "s1", tabs: [{ id: "review" }, { id: "agent" }, { id: "other" }] }],
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    run: (...args) => calls.push(args), notify: n => notices.push(n), nextCommand() {}, appHome: () => "/herdr/home",
    exec: async (binary, args) => {
      assert.equal(binary, "env"); assert.equal(args[0], "HERDR_APP_HOME=/herdr/home");
      calls.push(["tab.new", JSON.parse(args[4])]);
      return { code: 0, stdout: JSON.stringify({ tab: "created" }) };
    },
  };
  vm.runInNewContext(launcher, sandbox); await sandbox.openReview();
  return { calls, notices, state };
}

test("launcher opens a native tab pinned to the focused agent's process cwd, never a floating mod", async () => {
  const { calls, state } = await launch();
  assert.equal(calls.length, 2);
  assert.equal(state["review.tabs"]["s1:t1"].tab, "created"); assert.equal(calls[0][0], "tab.new");
  assert.equal(calls[0][1].props.root, "/repo"); assert.equal(calls[0][1].props.agent, "t1"); assert.equal(calls[0][1].props.agentTab, "agent");
  assert.ok(!calls.some(c => c[0] === "mod.open"));
});

test("launcher reuses and places an existing review directly after its agent, even when it started to the left", async () => {
  const { calls } = await launch({ registry: { "s1:t1": { tab: "review", launchRoot: "/repo" } } });
  assert.equal(calls[0][0], "tab.move"); assert.equal(calls[0][1].index, 2);
  assert.equal(calls[1][0], "tab.select"); assert.equal(calls[1][1].id, "review");
});

test("launcher does not guess another agent when invoked from a shell or existing review", async () => {
  assert.equal((await launch({ terminal: "shell" })).notices.length, 1);
  const review = await launch({ terminal: null, focusTab: "review", registry: { "s1:t1": { tab: "review", launchRoot: "/repo" } } });
  assert.equal(review.calls.length, 0); assert.equal(review.notices.length, 0);
});
