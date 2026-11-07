import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPage, fileTree, hitLine, hitControl, isCode, controlWidths } from "../mods/review/page.js";
import { desktopColors } from "../mods/review/desktop.js";
import { errorText } from "../mods/review/model.js";
import { submitToIdleAgent } from "../mods/review/delivery.js";

const source = (await readFile(new URL("../mods/review/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")
  .replace("export default class Review", "globalThis.RootReview = class Review");
function harness({ root = "/repo", register = false } = {}) {
  const calls = [], sends = [], texts = [], handlers = new Map(), ids = [], notifications = [], moves = [], registry = {}, lists = [], scrolls = [];
  const backend = { comments: [], viewed: {}, failSend: false, failArchive: false, status: "idle", dark: true, active: true, version: 1, extraFiles: [] };
  let deferred = false;
  function builder() {
    let id;
    const proxy = new Proxy({}, { get: (_, name) => (...args) => {
      if (deferred && String(name).startsWith("on_")) assert.fail("Handlers must not be registered in deferred code rows");
      if (name === "id") { id = args[0]; ids.push(id); }
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
    diff: { engine: "Difftastic 0.72.0", notice: null, rows: path === "new.rs" ? [
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
      else if (req.action === "snapshot") data = { ...file("src/main.rs", req.snapshot), context: req.context };
      else if (req.action === "comment") {
        const id = req.id || `c${backend.comments.length + 1}`;
        backend.comments = [...backend.comments.filter(c => c.id !== id), { ...req, id, path: req.snapshot.endsWith("new.rs") ? "new.rs" : "src/main.rs", quote: "let n = 2;" }];
        data = { comments: backend.comments };
      } else if (req.action === "delete") { backend.comments = backend.comments.filter(c => c.id !== req.id); data = { comments: backend.comments }; }
      else if (req.action === "viewed") { if (req.viewed) backend.viewed[req.path] = req.fingerprint; else delete backend.viewed[req.path]; data = { viewed: backend.viewed }; }
      else if (req.action === "prepare") data = { review_id: "batch", count: backend.comments.length, text: "Exact review message", stale_count: 1 };
      else if (req.action === "sent") {
        if (backend.failArchive) return { code: 1, stdout: JSON.stringify({ ok: false, error: "disk full" }) };
        backend.comments = []; data = { comments: [] };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, data }) };
    },
    hc: async args => { sends.push(args); return backend.failSend ? { code: 1, stderr: "agent became busy" } : { code: 0 }; },
    buildPage, fileTree, hitLine, hitControl, isCode, controlWidths, desktopColors, errorText, submitToIdleAgent,
  };
  vm.runInNewContext(source, sandbox);
  const cx = {
    notify(target) { notifications.push(target); }, stop_propagation() {}, timer: { every() {} },
    spawn(fn) { fn(cx).catch(e => assert.fail(e)); },
    new() { assert.fail("Virtual rows must not mount retained JS entities; scrolling unmounts/releases them"); },
  };
  const wrapper = new sandbox.RootReview(); wrapper.init(p, cx);
  const view = wrapper;
  async function flush() {
    for (let n = 0; n < 500; n++) {
      await Promise.resolve();
      if (!view.busy && !view.scanning && !view.pumping) {
        await Promise.resolve(); if (!view.busy && !view.pumping) return;
      }
    }
    assert.fail("UI requests did not settle");
  }
  function render() { view.render(); }
  async function load(path = "src/main.rs") { await flush(); view.enqueue(path, cx); await flush(); }
  function plus({ path = "src/main.rs", side = "new", number = 2, shift = false } = {}) {
    const row = view.rows.find(r => r.path === path && (r.kind === "split" ? r[side]?.number : r.number) === number);
    assert.ok(row, "code line exists");
    view.press = { width: 800, x: row.kind === "split" && side === "new" ? 410 : 10, shift };
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
      view.press = { width: 800, x: 800 - (row.kind === "editor-actions" ? 14 : 12) - offset - controlWidths[action] / 2 };
      assert.equal(hitControl(row, view.press), action);
      lists.at(-1).click(row.key, cx);
    }
    await flush();
  }
  return { view, cx, wrapper, flush, render, load, plus, type, comment, click, backend, calls, sends, texts, handlers, ids, notifications, moves, registry, lists, scrolls };
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

test("context expands the frozen snapshot rather than recapturing a changing file", async () => {
  const h = harness(); await h.load();
  const row = h.view.rows.find(r => r.kind === "hunk"), snapshot = h.view.entries.get(row.path).data.snapshot;
  h.view.expandContext(row, h.cx); await h.flush();
  const request = h.calls.at(-1); assert.equal(request.action, "snapshot"); assert.equal(request.snapshot, snapshot); assert.equal(request.context, 13);
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
