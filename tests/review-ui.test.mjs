import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPage, fileTree, hitLine, hitCode, hitControl, isCode, controlWidths, gutter, anchorLabel } from "../mods/review/page.js";
import { desktopColors } from "../mods/review/desktop.js";
import { errorText } from "../mods/review/model.js";
import { submitToIdleAgent } from "../mods/review/delivery.js";

const source = (await readFile(new URL("../mods/review/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")
  .replace("export default class Review", "globalThis.RootReview = class Review");
function harness({ root = "/repo", register = false } = {}) {
  const calls = [], sends = [], texts = [], handlers = new Map(), ids = [], notifications = [], moves = [], registry = {}, lists = [], scrolls = [], styles = new Map();
  const backend = { comments: [], viewed: {}, failSend: false, failArchive: false, status: "idle", dark: true, active: true, version: 1, extraFiles: [], failViewed: false, pauseViewed: false, viewedWaiters: [] };
  let deferred = false;
  function builder() {
    let id;
    const proxy = new Proxy({}, { get: (_, name) => (...args) => {
      if (deferred && String(name).startsWith("on_")) assert.fail("Handlers must not be registered in deferred code rows");
      if (name === "id") { id = args[0]; ids.push(id); styles.set(id, {}); }
      if (id && ["opacity", "bg", "border_color", "disabled"].includes(name)) styles.get(id)[name] = args[0];
      if (id && name === "on_click") handlers.set(`${id}:click`, args[0]);
      if (id && name === "on_mouse_down") handlers.set(`${id}:down`, args[1]);
      if (id && name === "on_size_change") handlers.set(`${id}:size`, args[0]);
      if (id && name === "on_scroll_wheel") handlers.set(`${id}:scroll`, args[0]);
      if (name === "when" && args[0]) args[1](proxy);
      if (name === "child" && typeof args[0] === "string") texts.push(args[0]);
      if (name === "on_item_click") lists.at(-1).click = args[0];
      if (name === "child") assert.notEqual(args[0]?.entity, true, "deferred rows cannot mount retained entities");
      return proxy;
    } });
    return proxy;
  }
  function state() {
    let value = "";
    const events = {};
    return { events, value: () => value, set_value: v => { value = v; }, focus() {}, on(event, fn) { events[event] = fn; } };
  }
  const file = (path, snapshot = `snapshot-${backend.version}-${path}`) => ({
    snapshot, path, context: 3, stale: false, add: 1, del: path === "new.rs" ? 0 : 1,
    diff: { engine: "Difftastic 0.72.0", notice: null, rows: backend.diffRows && path !== "new.rs" ? backend.diffRows : path === "new.rs" ? [
      { kind: "hunk", text: "@@ -0 +1 @@" },
      { kind: "new", side: "new", number: 1, new_number: 1, old_number: null, text: "new file", spans: [] },
    ] : [
      { kind: "hunk", text: "@@ old 1 · new 1 @@" },
      { kind: "context", side: "new", number: 1, old_number: 1, new_number: 1, text: "fn main() {", spans: [] },
      { kind: "old", side: "old", number: 2, old_number: 2, new_number: null, text: "let n = 1;", spans: [] },
      { kind: "new", side: "new", number: 2, old_number: null, new_number: 2, text: "let n = 2;", spans: [] },
      { kind: "context", side: "new", number: 3, old_number: 3, new_number: 3, text: "}", spans: [] },
    ] },
  });
  const files = () => [{ path: "src/main.rs", status: "M", fingerprint: `v${backend.version}`, add: 1, del: 1 }, { path: "new.rs", status: "A", fingerprint: "new-v1", add: null, del: null }, ...backend.extraFiles];
  const p = { root, agent: "t1", agentName: "Pi", space: "s1", ...(register ? { agentTab: "agent-tab", launchRoot: root } : {}) };
  const sandbox = {
    View: class {}, div: builder, svg: builder, v_flex: builder, h_flex: builder,
    TextareaState: { new: state }, EditorState: { new: state }, Textarea: { new: builder }, Editor: { new: builder },
    Scrollbar: { vertical: builder }, VirtualListScrollHandle: { new: () => ({ scroll_to_item: (...args) => scrolls.push(args) }) },
    v_virtual_list(_id, count, sizes, key, render) {
      assert.equal(sizes.length, count);
      const list = { count, key, draw(range = { start: 0, end: count }) {
        deferred = true;
        try { for (let i = 0; i < count; i++) key(i); return render(range); }
        finally { deferred = false; }
      } };
      lists.push(list); list.draw();
      return builder();
    },
    appHome: () => "/home/herdr", props: () => p,
    focused: () => ({ tab: "review-tab", space: "s1", terminal: "t1" }),
    spaces: () => [{ id: "s1", tabs: [{ id: "agent-tab" }, { id: "other-tab" }, { id: "review-tab", active: true }] }],
    agents: () => [{ address: "t1", space: "s1", status: backend.status, program: { name: "Pi" } }],
    terminals: () => [{ address: "t1", cwd: "/wrong-shell-directory", foreground: { cwd: "/repo" } }],
    shared: key => registry[key], setShared: (key, value) => { registry[key] = value; },
    run: (...args) => moves.push(args), window: () => ({ active: backend.active }),
    settings: () => ({ dark: backend.dark }), nextCommand: () => new Promise(() => {}),
    async exec(_binary, args) {
      const req = JSON.parse(args[2]); calls.push(req);
      let data;
      if (req.action === "scan") {
        backend.viewed = Object.fromEntries(Object.entries(backend.viewed).filter(([path, token]) => files().some(f => f.path === path && f.fingerprint === token)));
        data = { root: "/repo", base: "HEAD-SHA", files: files(), comments: backend.comments, viewed: backend.viewed };
      } else if (req.action === "open") data = file(req.path);
      else if (req.action === "snapshot") {
        if (backend.failSnapshot) return { code: 1, stdout: JSON.stringify({ ok: false, error: "Expansion failed" }) };
        data = { ...file("src/main.rs", req.snapshot), context: req.context, reveal: req.reveal };
      }
      else if (req.action === "comment") {
        const id = req.id || `c${backend.comments.length + 1}`;
        backend.comments = [...backend.comments.filter(c => c.id !== id), { ...req, id, path: req.snapshot.endsWith("new.rs") ? "new.rs" : "src/main.rs", quote: "let n = 2;" }];
        data = { comments: backend.comments };
      } else if (req.action === "delete") { backend.comments = backend.comments.filter(c => c.id !== req.id); data = { comments: backend.comments }; }
      else if (req.action === "viewed") {
        if (backend.pauseViewed) await new Promise(resolve => backend.viewedWaiters.push(resolve));
        if (backend.failViewed) return { code: 1, stdout: JSON.stringify({ ok: false, error: "Viewed could not be saved" }) };
        if (req.viewed) backend.viewed[req.path] = req.fingerprint; else delete backend.viewed[req.path];
        data = { viewed: backend.viewed };
      }
      else if (req.action === "prepare") data = { review_id: "batch", count: backend.comments.length, text: "Exact review message", stale_count: 1 };
      else if (req.action === "sent") {
        if (backend.failArchive) return { code: 1, stdout: JSON.stringify({ ok: false, error: "disk full" }) };
        backend.comments = []; data = { comments: [] };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
    },
    hc: async args => { sends.push(args); return backend.failSend ? { code: 1, stderr: "agent became busy" } : { code: 0 }; },
    buildPage, fileTree, hitLine, hitCode, hitControl, isCode, controlWidths, gutter, anchorLabel, desktopColors, errorText, submitToIdleAgent,
  };
  vm.runInNewContext(source, sandbox);
  const cx = {
    notify(target) { notifications.push(target); }, stop_propagation() {}, timer: { every() {} },
    spawn(fn) { fn(cx).catch(e => assert.fail(e)); },
    new() { assert.fail("Virtual rows must not mount retained JS entities; scrolling unmounts/releases them"); },
  };
  const wrapper = new sandbox.RootReview(); wrapper.init(p, cx);
  const view = wrapper; view.width = 800;
  async function flush() {
    for (let n = 0; n < 500; n++) {
      await Promise.resolve();
      if (!view.busy && !view.scanning && !view.pumping && !view.viewedPending.size) {
        await Promise.resolve(); if (!view.busy && !view.pumping && !view.viewedPending.size) return;
      }
    }
    assert.fail("UI requests did not settle");
  }
  function render() { view.render(); }
  async function load(path = "src/main.rs") { await flush(); view.enqueue(path, cx); await flush(); }
  function plus({ path = "src/main.rs", side = "new", number = 2, shift = false } = {}) {
    const row = view.rows.find(r => r.path === path && (r.kind === "split" ? r[side]?.number : r.number) === number);
    assert.ok(row, "code line exists");
    view.press = { width: 800, x: (row.kind === "split" && side === "new" ? 400 : 0) + gutter.plusLeft + gutter.plusSize / 2, shift };
    view.select(row.key, cx);
  }
  function type(text) { view.note.set_value(text); view.note.events.change({}, cx); }
  async function comment() { await load(); plus(); type("Use a named constant."); view.saveComment(cx); await flush(); }
  async function click(id) {
    render(); assert.ok(ids.includes(id), `button ${id} is painted`);
    if (handlers.has(`${id}:click`)) handlers.get(`${id}:click`)({}, cx);
    else {
      let row, action;
      if (id.startsWith("comment-")) { row = view.rows.find(r => r.kind === "editor-actions"); action = id === "comment-save" ? "save" : "cancel"; }
      else { action = id.startsWith("edit-") ? "edit" : "delete"; row = view.rows.find(r => r.kind === "comment" && `${action}-${r.comment.id}` === id); }
      assert.ok(row);
      const offset = action === "edit" ? controlWidths.delete + 6 : action === "cancel" ? controlWidths.save + 8 : 0;
      view.press = { width: 800, x: row.frame.x + row.frame.width - (row.kind === "editor-actions" ? 14 : 12) - offset - controlWidths[action] / 2 };
      assert.equal(hitControl(row, view.press), action);
      lists.at(-1).click(row.key, cx);
    }
    await flush();
  }
  return { view, cx, wrapper, flush, render, load, plus, type, comment, click, backend, calls, sends, texts, handlers, ids, notifications, moves, registry, lists, scrolls, styles };
}

test("stacked review cards load lazily and do not contain the old toolbar or sidebar composer", async () => {
  const h = harness(); await h.flush(); h.render();
  assert.equal(h.calls.filter(c => c.action === "open").length, 0);
  h.view.loadVisible(h.cx); await h.flush(); h.render();
  assert.ok(h.texts.includes("let n = 2;"));
  assert.equal(h.view.rows.filter(r => r.kind === "file").length, 2);
  assert.ok(!h.ids.some(id => ["review-repo", "review-scope", "review-refresh", "review-mode", "review-tab-comments", "comment-save"].includes(id)));
  assert.ok(h.notifications.includes(undefined), "async updates invalidate the actual root review view");
});

test("blue + opens the inline native textarea; code clicks do not; Shift+click selects a range", async () => {
  const h = harness(); await h.load();
  const line = h.view.rows.find(r => r.kind === "split" && r.new?.number === 2);
  h.view.press = { width: 800, x: 600 }; h.view.select(line.key, h.cx); assert.equal(h.view.selection, undefined);
  h.plus({ side: "old" }); assert.equal(h.view.selection.side, "old");
  h.plus({ side: "old", number: 3, shift: true }); assert.equal(h.view.selection.end, 3);
  h.render(); assert.ok(h.ids.includes("inline-comment-editor"));
  h.type("Why remove this?"); await h.click("comment-save");
  assert.equal(h.view.comments[0].side, "old"); assert.equal(h.view.comments[0].end, 3);
  assert.equal(h.view.selection, null); assert.equal(h.sends.length, 0);
});

test("new files are unified and tree navigation does not discard an open comment", async () => {
  const h = harness(); await h.load(); await h.load("new.rs"); h.plus(); h.type("Unsent text");
  h.view.pick("new.rs", h.cx); await h.flush();
  assert.equal(h.view.note.value(), "Unsent text"); assert.equal(h.view.selection.path, "src/main.rs");
  assert.ok(h.view.rows.some(r => r.path === "new.rs" && r.kind === "new" && r.layout === "unified"));
  assert.ok(!h.view.rows.some(r => r.path === "new.rs" && r.kind === "split"));
  h.plus({ path: "new.rs", number: 1, shift: true }); assert.match(h.view.error, /same file/);
});

test("inline draft Edit/Delete use the list-owned handler and preserve saved anchors", async () => {
  const h = harness(); await h.comment();
  await h.click("edit-c1"); assert.equal(h.view.note.value(), "Use a named constant.");
  h.type("Use MAX_COUNT."); await h.click("comment-save");
  assert.equal(h.view.comments[0].body, "Use MAX_COUNT."); assert.equal(h.view.comments[0].id, "c1");
  await h.click("delete-c1"); assert.equal(h.view.comments.length, 0);
});

test("background changes never move an open editor or overwrite a just-saved comment", async () => {
  const h = harness(); await h.load(); h.plus(); h.type("Keep this draft");
  const snapshot = h.view.selection.snapshot;
  h.backend.version = 2; h.view.scan(h.cx, true); await h.flush();
  assert.equal(h.view.selection.snapshot, snapshot); assert.equal(h.view.note.value(), "Keep this draft");
  assert.equal(h.view.changedWhileEditing, true);
  h.view.saveComment(h.cx); await h.flush();
  assert.equal(h.view.comments.length, 1); assert.equal(h.view.comments[0].snapshot, snapshot);
  assert.ok(h.view.rows.find(r => r.kind === "comment").outdated);
});

test("Viewed collapses a card and is invalidated when its changes change", async () => {
  const h = harness(); await h.load(); h.view.toggleViewed("src/main.rs", h.cx); await h.flush();
  assert.equal(h.view.viewed["src/main.rs"], "v1"); assert.ok(h.view.collapsed.has("src/main.rs"));
  h.backend.version = 2; h.view.scan(h.cx, true); await h.flush();
  assert.equal(h.view.viewed["src/main.rs"], undefined); assert.ok(!h.view.collapsed.has("src/main.rs"));
});

function contextFixture(h) {
  const gap = (old_start, new_start, count, before, after) => ({ kind: "hunk", text: `${count} hidden lines`, gap: { old_start, new_start, count, before, after } });
  const code = (old_number, new_number) => ({ kind: "context", side: "new", number: new_number, old_number, new_number, text: "unchanged", spans: [] });
  h.backend.diffRows = [gap(1, 1, 16, false, true), code(17, 17), gap(24, 25, 40, true, true), code(64, 65), gap(80, 81, 21, true, false)];
}

test("gutter arrows expand just their end of the frozen gap and never jump to the file header", async () => {
  const h = harness(); contextFixture(h); await h.load(); h.render();
  const snapshot = h.view.entries.get("src/main.rs").data.snapshot;
  const controls = h.view.rows.filter(r => r.expand), scrolls = h.scrolls.length;
  for (let i = 0; i < controls.length; i++) {
    const row = h.view.rows.find(r => r.key === controls[i].key);
    h.view.press = { x: 35, width: 800 };
    h.view.activate(row.key, h.cx); await h.flush(); h.render();
    const request = h.calls.at(-1);
    assert.equal(request.action, "snapshot"); assert.equal(request.snapshot, snapshot); assert.equal(request.context, 3);
    assert.deepEqual(request.reveal.at(-1), [
      { old_start: 7, new_start: 7, count: 10 },
      { old_start: 24, new_start: 25, count: 10 },
      { old_start: 54, new_start: 55, count: 10 },
      { old_start: 80, new_start: 81, count: 10 },
    ][i]);
    assert.equal(request.reveal.length, i + 1, "earlier expansions are preserved");
  }
  assert.equal(h.scrolls.length, scrolls);
  assert.equal(h.view.jumpPath, null);
  assert.ok(h.texts.includes("16 hidden lines"));
  assert.ok(!h.handlers.has(`expand-${controls[0].key}:click`), "arrows use the list-owned handler");
});

test("context expansion stops at the file boundary and preserves the page on failure", async () => {
  const h = harness(); contextFixture(h); h.backend.diffRows[0].gap.count = 4; await h.load();
  let row = h.view.rows.find(r => r.expand), entry = h.view.entries.get(row.path);
  h.backend.failSnapshot = true;
  const data = entry.data;
  h.view.expandContext(row, h.cx); await h.flush();
  assert.equal(entry.data, data); assert.match(h.view.error, /Expansion failed/);
  assert.deepEqual(h.calls.at(-1).reveal, [{ old_start: 1, new_start: 1, count: 4 }]);
  h.backend.failSnapshot = false;
  h.view.expandContext(row, h.cx); await h.flush();
  const calls = h.calls.length;
  h.view.expandContext({ ...row, snapshot: "obsolete" }, h.cx); await h.flush();
  assert.equal(h.calls.length, calls, "a queued event from an obsolete snapshot cannot expand a new capture");
});

test("context arrows cannot move an open comment editor or drop its unsaved text", async () => {
  const h = harness(); contextFixture(h); await h.load(); h.plus({ number: 17 }); h.type("Unsent comment");
  const row = h.view.rows.find(r => r.expand), calls = h.calls.length, selection = h.view.selection;
  h.view.expandContext(row, h.cx); await h.flush();
  assert.equal(h.calls.length, calls); assert.equal(h.view.selection, selection); assert.equal(h.view.note.value(), "Unsent comment");
});

test("review page is pinned to the originating agent and does not register a tab using transient init focus", async () => {
  const h = harness({ register: true }); await h.flush();
  assert.equal(h.view.agent, "t1"); assert.equal(h.view.space, "s1");
  assert.equal(h.calls[0].cwd, "/repo"); assert.equal(h.moves.length, 0);
});

test("review preview is bound to the originating agent; a busy or failed send retains drafts", async () => {
  const h = harness(); await h.comment(); h.view.prepare(h.cx); await h.flush(); h.render();
  assert.equal(h.view.previewEditor.value(), "Exact review message");
  assert.ok(!h.ids.some(id => id.startsWith("review-agent-")));
  h.backend.status = "working"; h.view.send(h.cx); await h.flush(); assert.equal(h.sends.length, 0);
  h.backend.status = "idle"; h.backend.failSend = true; h.view.send(h.cx); await h.flush();
  assert.equal(h.view.comments.length, 1); assert.match(h.view.error, /busy/);
  h.backend.failSend = false; h.view.send(h.cx); await h.flush();
  assert.equal(h.sends.at(-1)[4], "t1"); assert.equal(h.sends.at(-1)[5], "Exact review message"); assert.equal(h.view.comments.length, 0);
});

test("archive failure cannot result in an accidental duplicate send", async () => {
  const h = harness(); await h.comment(); h.view.prepare(h.cx); await h.flush();
  h.backend.failArchive = true; h.view.send(h.cx); await h.flush();
  assert.equal(h.view.delivery, true); assert.match(h.view.error, /Do not resend/);
  h.view.send(h.cx); await h.flush(); assert.equal(h.sends.length, 1);
  h.backend.failArchive = false; h.view.operation(h.cx, cx => h.view.finishDelivery(cx)); await h.flush();
  assert.equal(h.view.comments.length, 0); assert.equal(h.sends.length, 1);
});

test("offscreen/remounted rows and an obsolete layout callback never reference released entities", async () => {
  const h = harness(); await h.load(); h.render();
  const before = h.lists.at(-1), count = before.count;
  h.view.toggleCollapse("src/main.rs", h.cx); await h.flush(); h.render();
  assert.ok(h.lists.at(-1).count < count);
  assert.doesNotThrow(() => before.draw(), "old list count, keys and renderer use one coherent rows snapshot");
  for (let i = 0; i < 50; i++) {
    h.view.toggleCollapse("src/main.rs", h.cx); await h.flush(); h.render();
    const list = h.lists.at(-1);
    for (let start = 0; start < list.count; start += 3) list.draw({ start, end: Math.min(list.count, start + 3) });
  }
  assert.equal(h.view.error, null);
});

test("unchanged background scans and native scrolling do not rebuild the page or request more diffs", async () => {
  const h = harness(); await h.load(); await h.load("new.rs"); h.render();
  const rows = h.view.rows, notifications = h.notifications.length;
  h.view.scan(h.cx, true); await h.flush();
  assert.equal(h.view.rows, rows); assert.equal(h.notifications.length, notifications);
  const requests = h.calls.length;
  for (let i = 0; i < 50; i++) { h.lists.at(-1).draw(); h.view.loadVisible(h.cx); }
  await h.flush();
  assert.equal(h.calls.length, requests); assert.equal(h.notifications.length, notifications);
});

test("visible-file demand is serialized and bounds the prefetch queue", async () => {
  const h = harness();
  h.backend.extraFiles = Array.from({ length: 30 }, (_, i) => ({ path: `many/${i}.rs`, status: "M", fingerprint: "v1" }));
  await h.flush(); h.render(); h.view.loadVisible(h.cx);
  assert.ok(h.view.queue.length <= 3);
  await h.flush();
  assert.ok(h.calls.filter(c => c.action === "open").length <= 4, "one in-flight diff plus at most three queued");
});

test("typing only redraws the page when comment-button availability changes", async () => {
  const h = harness(); await h.load(); h.plus();
  h.type("x"); const notifications = h.notifications.length;
  h.type("xy"); h.type("xyz");
  assert.equal(h.notifications.length, notifications, "native textarea owns ordinary keystroke redraws");
  h.type(""); assert.equal(h.notifications.length, notifications + 1);
});

test("hidden reviews pause queued diff work and resume when shown", async () => {
  const h = harness(); await h.flush(); h.backend.active = false;
  h.view.enqueue("src/main.rs", h.cx); h.render(); h.view.loadVisible(h.cx); await h.flush();
  assert.equal(h.calls.filter(c => c.action === "open").length, 0);
  h.backend.active = true; h.view.loadVisible(h.cx); await h.flush();
  assert.ok(h.calls.some(c => c.action === "open" && c.path === "src/main.rs"));
});

test("a backend change back to the initial manifest still replaces locally changed draft/viewed state", async () => {
  const h = harness(); await h.comment();
  h.backend.comments = []; h.view.scan(h.cx, true); await h.flush();
  assert.equal(h.view.comments.length, 0);
  h.view.toggleViewed("src/main.rs", h.cx); await h.flush();
  h.backend.viewed = {}; h.view.scan(h.cx, true); await h.flush();
  assert.equal(h.view.viewed["src/main.rs"], undefined);
});

test("list control clicks use the root hitbox, never per-row event registrations", async () => {
  const h = harness(); await h.load(); h.render();
  h.handlers.get("review-hitbox:down")({ local_position: { x: 20 }, bounds: { width: 800 } }, h.cx);
  h.lists.at(-1).click("file:src/main.rs", h.cx); await h.flush();
  assert.ok(h.view.collapsed.has("src/main.rs"));
  assert.ok(!h.handlers.has("collapse-src/main.rs:click"));
  assert.ok(!h.handlers.has("card-src/main.rs:size"));
});

test("tree navigation tracks a pending file load but stops pinning after user scroll or completion", async () => {
  const h = harness(); await h.load();
  h.view.pick("new.rs", h.cx); assert.equal(h.view.jumpPath, "new.rs"); h.render();
  const before = h.scrolls.length;
  h.handlers.get("review-hitbox:scroll")({}, h.cx); await h.flush();
  assert.equal(h.view.jumpPath, null); assert.equal(h.scrolls.length, before);
  h.view.pick("new.rs", h.cx); assert.equal(h.view.jumpPath, null, "already-loaded cards jump only once");
});

test("Viewed updates optimistically without dimming other boxes or repainting on acknowledgement", async () => {
  const h = harness(); await h.load(); h.render();
  const opacity = h.styles.get("viewed-new.rs").opacity ?? 1;
  h.backend.pauseViewed = true;
  h.view.toggleViewed("src/main.rs", h.cx); h.render();
  assert.equal(h.view.busy, false);
  assert.equal(h.view.viewed["src/main.rs"], "v1");
  assert.ok(h.view.collapsed.has("src/main.rs"));
  assert.equal(h.styles.get("viewed-new.rs").opacity ?? 1, opacity);
  for (let i = 0; i < 20 && !h.backend.viewedWaiters.length; i++) await Promise.resolve();
  assert.equal(h.backend.viewedWaiters.length, 1);
  const notifications = h.notifications.length;
  h.backend.viewedWaiters.shift()(); await h.flush();
  assert.equal(h.notifications.length, notifications, "acknowledgement has no second visual transition");
});

test("independent Viewed acknowledgements and stale scans preserve other optimistic checkboxes", async () => {
  const h = harness(); await h.load(); await h.load("new.rs");
  h.backend.pauseViewed = true;
  h.view.toggleViewed("src/main.rs", h.cx); h.view.toggleViewed("new.rs", h.cx);
  const oldManifest = { root: h.view.root, base: h.view.base, files: h.view.files, comments: [], viewed: {} };
  h.view.applyManifest(oldManifest, h.view.revision, h.cx);
  assert.equal(h.view.viewed["src/main.rs"], "v1"); assert.equal(h.view.viewed["new.rs"], "new-v1");
  for (let i = 0; i < 20 && !h.backend.viewedWaiters.length; i++) await Promise.resolve();
  h.backend.viewedWaiters.shift()();
  for (let i = 0; i < 40 && !h.backend.viewedWaiters.length; i++) await Promise.resolve();
  assert.equal(h.view.viewed["new.rs"], "new-v1", "first ack cannot clear the second checkbox");
  assert.equal(h.backend.viewedWaiters.length, 1);
  h.backend.viewedWaiters.shift()(); await h.flush();
  assert.equal(Object.keys(h.view.viewed).length, 2);
});

test("a failed Viewed update restores just that file's previous flag and collapsed state", async () => {
  const h = harness(); await h.load(); await h.load("new.rs");
  h.view.toggleViewed("new.rs", h.cx); await h.flush();
  h.backend.failViewed = true;
  h.view.toggleViewed("src/main.rs", h.cx);
  assert.equal(h.view.viewed["src/main.rs"], "v1"); await h.flush();
  assert.equal(h.view.viewed["src/main.rs"], undefined); assert.ok(!h.view.collapsed.has("src/main.rs"));
  assert.equal(h.view.viewed["new.rs"], "new-v1"); assert.ok(h.view.collapsed.has("new.rs"));
  assert.match(h.view.error, /could not be saved/);
});

test("clicking a line outlines it without opening a comment; hover is a separate native layer", async () => {
  const h = harness(); await h.load(); h.render();
  const line = h.view.rows.find(r => r.kind === "split" && r.new?.number === 2);
  h.view.press = { x: 600, width: 800 }; h.view.activate(line.key, h.cx); h.render();
  assert.equal(h.view.highlight.start, 2); assert.equal(h.view.highlight.side, "new");
  assert.equal(h.view.selection, undefined);
  assert.ok(!h.view.rows.some(r => r.kind === "editor"));
  assert.equal(h.styles.get(`line-hover:${line.key}:new`).opacity, 1, "selected line keeps its + visible");
  const other = h.view.rows.find(r => r.kind === "split" && r.new?.number === 3);
  assert.equal(h.styles.get(`line-hover:${other.key}:new`).opacity, 0, "other badges are independently revealed by native hover");
  assert.ok(!h.handlers.has(`line-hover:${other.key}:new:click`));
});

test("line highlighting never moves an open comment's anchor or loses typed text", async () => {
  const h = harness(); await h.load(); h.plus(); h.type("Still about line two");
  const anchor = h.view.selection;
  const other = h.view.rows.find(r => r.kind === "split" && r.new?.number === 3);
  h.view.press = { x: 600, width: 800 }; h.view.activate(other.key, h.cx); h.render();
  assert.equal(h.view.highlight.start, 3);
  assert.equal(h.view.selection, anchor); assert.equal(h.view.selection.start, 2);
  assert.equal(h.view.note.value(), "Still about line two");
  assert.ok(h.texts.includes("Add a comment on line R2"));
  await h.click("comment-save");
  assert.equal(h.view.comments[0].start, 2);
});

test("Shift-clicked line ranges can become comments via + without reselecting anchors", async () => {
  const h = harness(); await h.load();
  for (const number of [1, 3]) {
    const row = h.view.rows.find(r => r.kind === "split" && r.new?.number === number);
    h.view.press = { x: 600, width: 800, shift: number === 3 }; h.view.activate(row.key, h.cx);
  }
  assert.equal(h.view.highlight.start, 1); assert.equal(h.view.highlight.end, 3);
  assert.equal(h.view.selection, undefined);
  h.plus({ number: 2 });
  assert.equal(h.view.selection.start, 1); assert.equal(h.view.selection.end, 3);
  h.render(); assert.ok(h.texts.includes("Add a comment on lines R1–R3"));
});

test("Viewed uses a real painted checkmark and does not fade during global operations", async () => {
  const h = harness(); await h.load(); h.render();
  const t = desktopColors(true);
  assert.equal(h.styles.get("viewed-check:src/main.rs").bg, t.input);
  h.view.toggleViewed("src/main.rs", h.cx); await h.flush(); h.render();
  assert.equal(h.styles.get("viewed-check:src/main.rs").bg, t.accent);
  assert.equal(h.styles.get("viewed-src/main.rs").bg, t.viewedBg);
  h.view.busy = true; h.render();
  assert.equal(h.styles.get("viewed-new.rs").opacity ?? 1, 1);
  assert.equal(h.styles.get("viewed-new.rs").disabled, true, "disabled is semantic, not a page-wide opacity pulse");
  assert.ok(!h.texts.some(text => text.includes("☑") || text.includes("☐")));
  h.view.busy = false;
});

test("deferred manifests cannot undo an acknowledged Viewed change made while editing another file", async () => {
  const h = harness(); await h.load(); await h.load("new.rs"); h.plus(); h.type("Still editing");
  h.view.scan(h.cx, true); await h.flush();
  assert.ok(h.view.pendingManifest);
  h.view.toggleViewed("new.rs", h.cx); await h.flush();
  assert.equal(h.view.pendingManifest.data.viewed["new.rs"], "new-v1");
  h.view.cancelComment(h.cx); await h.flush();
  assert.equal(h.view.viewed["new.rs"], "new-v1");
  assert.ok(h.view.collapsed.has("new.rs"));
});
