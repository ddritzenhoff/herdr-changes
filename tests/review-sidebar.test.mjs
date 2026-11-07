import test from "node:test";
import assert from "node:assert/strict";
import { filePaneDefaults, filePanePreferences, filePaneBounds } from "../mods/review/sidebar.js";

test("file-pane preferences default safely and accept only valid persisted appearance values", () => {
  for (const value of [undefined, null, false, [], "bad JSON", {}, { width: "320", collapsed: "true" }, { width: NaN }, { width: Infinity }]) {
    assert.deepEqual(filePanePreferences(value), filePaneDefaults);
  }
  assert.deepEqual(filePanePreferences({ width: 321.6, collapsed: true, privateData: "not retained" }), { width: 322, collapsed: true });
  assert.deepEqual(filePanePreferences({ width: -100, collapsed: false }), { width: 180, collapsed: false });
  assert.deepEqual(filePanePreferences({ width: 90000 }), { width: 600, collapsed: false });
  const value = { width: 320, collapsed: true };
  assert.deepEqual(filePanePreferences(JSON.parse(JSON.stringify(value))), value, "appearance survives a persisted round trip");
  assert.deepEqual(filePaneDefaults, { width: 240, collapsed: false });
});

test("file-pane bounds leave room for code without changing the preferred width on small windows", () => {
  assert.deepEqual(filePaneBounds(), { min: 180, max: 600, contentMin: 260 });
  for (const total of [0, 50, 200, 300, 400, 600, 900, 2000]) {
    const bounds = filePaneBounds(total);
    assert.ok(bounds.min >= 0 && bounds.min <= bounds.max && bounds.max <= 600);
    assert.ok(bounds.max + bounds.contentMin <= total);
    assert.ok(bounds.contentMin >= Math.min(260, total / 2));
  }
  assert.deepEqual(filePaneBounds(NaN), filePaneBounds());
  assert.deepEqual(filePaneBounds(-20), { min: 0, max: 0, contentMin: 0 });
  const preferred = { width: 550, collapsed: false };
  const small = filePaneBounds(400);
  assert.ok(small.max < preferred.width);
  assert.equal(filePanePreferences(preferred).width, 550, "a temporary viewport limit is not saved as a new preference");
});
