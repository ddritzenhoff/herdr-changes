import test from "node:test";
import assert from "node:assert/strict";
import { byteIndex, segments, selectLine, displayedRows, splitRows, wrapSegments } from "../mods/review/model.js";
import { desktopColors } from "../mods/review/desktop.js";
import { submitToIdleAgent } from "../mods/review/delivery.js";

test("Difftastic byte offsets map correctly across accented and astral characters", () => {
  const text = "café🦀 = 2";
  assert.equal(byteIndex(text, 5), 4);
  assert.equal(byteIndex(text, 9), 6);
  const parts = segments(text, [{ start: 3, end: 9, highlight: "string" }]);
  assert.deepEqual(parts.map(p => p.text), ["caf", "é🦀", " = 2"]);
  assert.equal(parts[1].changed, true);
});

test("non-overlapping changed spans preserve all source text", () => {
  const text = "let value = 42;";
  const parts = segments(text, [{ start: 12, end: 14, highlight: "keyword" }]);
  assert.equal(parts.map(p => p.text).join(""), text);
  assert.equal(parts.find(p => p.changed).text, "42");
  assert.equal(segments("")[0].text, " ");
});

test("selecting a removed line anchors to old, then context can extend old range", () => {
  const old = { kind: "old", side: "old", number: 8, old_number: 8, new_number: null };
  const context = { kind: "context", side: "new", number: 10, old_number: 11, new_number: 10 };
  const selected = selectLine(old, null);
  assert.deepEqual(selected, { side: "old", start: 8, end: 8, anchor: 8 });
  assert.deepEqual(selectLine(context, selected), { side: "old", start: 8, end: 11, anchor: 8 });
});

test("switching to new side resets anchor, reversed ranges work, hunks cannot be selected", () => {
  const row = { kind: "new", side: "new", number: 5, old_number: null, new_number: 5 };
  assert.deepEqual(selectLine(row, { side: "old", anchor: 20 }), { side: "new", start: 5, end: 5, anchor: 5 });
  assert.deepEqual(selectLine(row, { side: "new", anchor: 10 }), { side: "new", start: 5, end: 10, anchor: 10 });
  assert.equal(selectLine({ kind: "hunk" }, null), null);
  assert.throws(() => selectLine(row, { side: "new", anchor: 55 }), /50 lines/);
});

test("inline comments only appear under the exact frozen snapshot and side", () => {
  const file = { snapshot: "v1", diff: { rows: [
    { kind: "old", side: "old", old_number: 2 },
    { kind: "new", side: "new", new_number: 2 },
  ] } };
  const comments = [
    { id: "a", snapshot: "v1", side: "old", end: 2, body: "Old" },
    { id: "b", snapshot: "v2", side: "new", end: 2, body: "Different snapshot" },
  ];
  const rows = displayedRows(file, comments);
  assert.deepEqual(rows.map(r => r.key), ["v1:0", "comment:a", "v1:1"]);
  assert.deepEqual(displayedRows(null, comments), []);
});

test("split view pairs deletion/addition runs and keeps comments on their original side", () => {
  const file = { snapshot: "v1", diff: { rows: [
    { kind: "hunk", text: "@@" },
    { kind: "old", old_number: 4, text: "old a", spans: [] },
    { kind: "old", old_number: 5, text: "old b", spans: [] },
    { kind: "new", new_number: 4, text: "new a", spans: [] },
    { kind: "context", old_number: 6, new_number: 5, text: "same", spans: [] },
  ] } };
  const rows = splitRows(file, [{ id: "c", snapshot: "v1", side: "old", end: 5 }]);
  assert.equal(rows[1].old.number, 4); assert.equal(rows[1].new.number, 4);
  assert.equal(rows[2].old.number, 5); assert.equal(rows[2].new, null);
  assert.equal(rows[3].key, "comment:c");
  assert.equal(rows[4].old.side, "old"); assert.equal(rows[4].new.side, "new");
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length);
});

test("split wrapping preserves code and token highlighting without changing line anchors", () => {
  const text = "let café = 🦀;";
  const wrapped = wrapSegments(text, [{ start: 12, end: 16, highlight: "keyword" }], 8);
  assert.ok(wrapped.length > 1);
  assert.equal(wrapped.flat().map(s => s.text).join(""), text);
  assert.ok(wrapped.flat().some(s => s.changed && s.text.includes("🦀")));
  assert.equal(wrapSegments("\tvalue", [], 20).flat().map(s => s.text).join(""), "    value");
});

test("review palette follows light/dark appearance and keeps distinct change backgrounds", () => {
  assert.equal(desktopColors(false).background, "#ffffff");
  assert.equal(desktopColors(true).background, "#0d1117");
  assert.notEqual(desktopColors(false).diffAdd, desktopColors(false).diffDel);
});

test("agent send is one literal guarded message with no shell or forced send", async () => {
  const calls = [], text = "Review `$(touch /tmp/no)`\n\n### café.rs\nUse a constant.";
  await submitToIdleAgent(async args => { calls.push(args); return { code: 0 }; }, "t123", text);
  assert.deepEqual(calls, [["send", "--if", "idle", "--json", "t123", text]]);
});

test("busy/failed sends reject without retrying or clearing anything", async () => {
  let calls = 0;
  await assert.rejects(submitToIdleAgent(async () => { calls++; return { code: 1, stderr: "Agent is working" }; }, "t1", "Review"), /working/);
  assert.equal(calls, 1);
  await assert.rejects(submitToIdleAgent(async () => { throw new Error("core offline"); }, "t1", "Review"), /offline/);
  await assert.rejects(submitToIdleAgent(async () => assert.fail("must not send"), "", "Review"), /Choose an agent/);
});
