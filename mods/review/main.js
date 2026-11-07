// A review-only page: file tree, stacked diff cards and inline feedback. Rust
// owns Git, immutable snapshots, persistent drafts, viewed flags and messages.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, EditorState, Editor, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { appHome, exec, focused, spaces, agents, terminals, props, shared, settings, nextCommand, window, hc } from "herdr";
import { errorText } from "./model.js";
import { buildPage, fileTree, hitLine, hitCode, hitControl, isCode, controlWidths, gutter, anchorLabel } from "./page.js";
import { desktopColors } from "./desktop.js";
import { submitToIdleAgent } from "./delivery.js";

const icon = (name, size = 16) => svg(`mods/review/icons/${name}.svg`).size(size).flex_none();
const lineBackground = (kind, t) => kind === "old" ? t.diffDel : kind === "new" ? t.diffAdd : kind === "empty" ? t.empty : t.background;
const gutterBackground = (kind, t) => kind === "old" ? t.gutterDel : kind === "new" ? t.gutterAdd : lineBackground(kind, t);
function button(id, text, action, enabled = true, primary = false) {
  const t = desktopColors(settings().dark !== false);
  const el = div().id(id).h(28).px(10).flex_none().flex().items_center().justify_center().rounded(5).text_size(12)
    .bg(primary ? t.accent : t.raised).text_color(primary ? "#ffffff" : t.foreground).border_1().border_color(primary ? t.accent : t.controlBorder)
    .when(!enabled, el => el.opacity(0.45))
    .when(enabled, el => el.cursor_pointer().hover(s => s.bg(primary ? t.primaryHover : t.hover)));
  // Virtual rows are paint only. One list-owned handler routes their controls
  // by stable row key and fixed hit zones; never mount entities inside a list.
  if (action) el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); });
  return el.child(text);
}

export default class Review extends View {
  init(_props, cx) {
    const p = _props || props() || {}, focus = focused();
    const actor = agents().find(a => a.address === (p.agent || focus?.shown || focus?.terminal));
    const terminal = terminals().find(t => t.address === actor?.address);
    this.agent = p.agent || actor?.address || null;
    this.agentName = p.agentName || actor?.program.name || "Agent";
    this.space = p.space || actor?.space || focus?.space;
    this.cwd = p.root || terminal?.foreground?.cwd || terminal?.cwd;
    this.files = []; this.comments = []; this.viewed = {}; this.entries = new Map(); this.rows = [];
    this.collapsed = new Set(); this.folded = new Set(); this.queue = []; this.deferred = new Map();
    this.busy = false; this.pumping = false; this.scanning = false; this.revision = 0; this.rpc = Promise.resolve();
    this.visiblePaths = []; this.viewedPending = new Map();
    // The deferred renderer only records demand. A data scheduler drains it
    // outside layout, at most three files ahead, with no idle redraws.
    cx.timer.every(120, cx => this.loadVisible(cx));
    this.scroll = VirtualListScrollHandle.new();
    this.note = TextareaState.new({ placeholder: "Leave a comment…", rows: 4 });
    this.note.on("change", (_e, cx) => {
      const enabled = Boolean(this.note.value().trim());
      if (enabled !== this.canSaveNote) { this.canSaveNote = enabled; this.notify(cx); }
    });
    this.note.on("submit", (e, cx) => { if (e?.secondary) this.saveComment(cx); });
    this.previewEditor = EditorState.new({ value: "", readonly: true, line_numbers: false, folding: false, soft_wrap: true, font_size: 12 });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "submit") this.prepare(cx);
      }
    });
    cx.timer.every(15000, cx => {
      // No redraw timer: only the cheap manifest is checked, only in the
      // active review tab. Actual diff capture remains lazy and per-file.
      if (this.isActiveReview()) this.scan(cx, true);
    });
    this.ownTab = focus?.tab;
    if (this.agent?.includes("/")) this.error = "Review currently supports local agents only.";
    else if (!this.cwd) this.error = "Open this reviewer from an agent terminal with Cmd+Shift+R.";
    else this.scan(cx);
  }
  call(action, extra = {}) {
    const request = { action, cwd: this.cwd, scope: "worktree", ...extra };
    const task = async () => {
      const r = await exec(`${appHome()}/tools/review-backend/target/release/herdr-review`,
        ["--store", `${appHome()}/data/review`, JSON.stringify(request)]);
      let response;
      try { response = JSON.parse(r.stdout); }
      catch { throw new Error(r.stderr || "Build the review backend with tools/review-backend/build.sh."); }
      if (!response.ok || r.code !== 0) throw new Error(response.error || r.stderr || "Review request failed");
      return response.data;
    };
    const result = this.rpc.then(task);
    this.rpc = result.catch(() => {}); // A failed request must not poison later requests.
    return result;
  }
  notify(cx) { cx.notify(); }
  isActiveReview() {
    if (!window().active || this.agent?.includes("/")) return false;
    const tab = spaces().find(s => s.id === this.space)?.tabs.find(t => t.active);
    const ownTab = shared("review.tabs")?.[`${this.space}:${this.agent}`]?.tab || this.ownTab;
    return !ownTab || !tab || tab.id === ownTab;
  }
  loadVisible(cx) {
    if (this.closed || this.busy || this.selection || this.preview || (!this.visiblePaths.length && !this.queue.length) || !this.isActiveReview()) return;
    const paths = this.visiblePaths; this.visiblePaths = [];
    if (paths.length) this.queue = this.queue.filter(path => paths.includes(path));
    for (const path of paths) {
      if (this.queue.length >= 3) break;
      this.enqueue(path, cx);
    }
    this.pump(cx);
  }
  rebuild(_cx) {
    this.canSaveNote = Boolean(this.note.value().trim());
    this.manifestSignature = JSON.stringify([this.root, this.base, this.files, this.comments, this.viewed]);
    this.rows = buildPage(this.files, this.entries, this.comments, this.selection, { width: this.width || 840, collapsed: this.collapsed });
    this.byKey = new Map(this.rows.map(r => [r.key, r]));
    if (this.jumpPath) {
      const entry = this.entries.get(this.jumpPath);
      this.scrollTo(`file:${this.jumpPath}`, "top");
      if (!entry?.meta || entry.error || (entry.data && !entry.changed)) this.jumpPath = null;
    }
  }
  scrollTo(key, strategy = "center") {
    const index = this.rows.findIndex(r => r.key === key);
    if (index >= 0) this.scroll.scroll_to_item(index, strategy);
  }
  applyManifest(data, revision, cx) {
    const comments = revision === this.revision ? data.comments : this.comments;
    const viewed = { ...(data.viewed || {}) };
    // An older in-flight scan must not undo optimistic checkbox changes.
    for (const [path, pending] of this.viewedPending) {
      if (pending.checked && data.files.some(f => f.path === path && f.fingerprint === pending.fingerprint)) viewed[path] = pending.fingerprint;
      else delete viewed[path];
    }
    const signature = JSON.stringify([data.root, data.base, data.files, comments, viewed]);
    if (signature === this.manifestSignature) return false;
    this.manifestSignature = signature;
    this.root = data.root; this.cwd = data.root; this.base = data.base;
    this.files = data.files; this.comments = comments;
    const previous = this.viewed;
    this.viewed = viewed;
    for (const meta of this.files) {
      const entry = this.entries.get(meta.path) || { context: 3 };
      if (entry.fingerprint && entry.fingerprint !== meta.fingerprint) {
        entry.changed = true; entry.error = null;
        if (previous[meta.path]) this.collapsed.delete(meta.path);
      } else if (!this.entries.has(meta.path) && this.viewed[meta.path]) this.collapsed.add(meta.path);
      entry.meta = meta;
      this.entries.set(meta.path, entry);
    }
    for (const [path, entry] of this.entries) if (!this.files.some(f => f.path === path)) {
      entry.changed = true; entry.meta = null;
      if (!this.comments.some(c => c.path === path)) { this.entries.delete(path); this.collapsed.delete(path); }
    }
    this.rebuild(cx); return true;
  }
  scan(cx, quiet = false) {
    if (!this.cwd || this.scanning || this.busy || this.closed) return;
    this.scanning = true;
    const revision = this.revision;
    cx.spawn(async cx => {
      let redraw = !quiet;
      try {
        const data = await this.call("scan");
        if (this.closed) return;
        if (this.selection || this.preview) {
          this.pendingManifest = { data, revision };
          for (const path of this.viewedPending.keys()) this.syncPendingViewed(path);
          const changed = Boolean(this.selection && data.files.find(f => f.path === this.selection.path)?.fingerprint !== this.entries.get(this.selection.path)?.meta?.fingerprint);
          if (changed !== this.changedWhileEditing) { this.changedWhileEditing = changed; redraw = true; }
        } else if (this.applyManifest(data, revision, cx)) { this.error = null; this.pump(cx); redraw = true; }
      } catch (e) { if (!quiet) this.error = errorText(e); }
      finally { this.scanning = false; if (!this.closed && redraw) this.notify(cx); }
    });
    if (!quiet) this.notify(cx);
  }
  enqueue(path, cx, priority = false) {
    const entry = this.entries.get(path);
    if (!entry?.meta || entry.loading || entry.error || this.collapsed.has(path) || (entry.data && !entry.changed)) return;
    entry.seen = true;
    this.queue = this.queue.filter(p => p !== path);
    if (priority) this.queue = [path, ...this.queue].slice(0, 3);
    else if (this.queue.length < 3) this.queue.push(path);
    this.pump(cx);
  }
  pump(cx) {
    if (this.pumping || this.busy || this.selection || this.preview || this.closed || !this.queue.length || !this.isActiveReview()) return;
    this.pumping = true;
    cx.spawn(async cx => {
      try {
        while (this.queue.length && !this.busy && !this.selection && !this.preview && !this.closed && this.isActiveReview()) {
          const path = this.queue.shift(), entry = this.entries.get(path);
          if (!entry?.meta || this.collapsed.has(path) || (entry.data && !entry.changed)) continue;
          entry.loading = true;
          const fingerprint = entry.meta.fingerprint;
          try {
            const data = await this.call("open", { path, base: this.base, context: entry.context });
            if (this.closed) return;
            if (this.selection || this.preview) this.deferred.set(path, { data, fingerprint });
            else { entry.data = data; entry.fingerprint = fingerprint; entry.changed = entry.meta?.fingerprint !== fingerprint; entry.error = null; }
          } catch (e) { entry.error = errorText(e); }
          finally { entry.loading = false; }
          if (!this.selection && !this.preview) this.rebuild(cx);
          this.notify(cx);
        }
      } finally { this.pumping = false; if (!this.closed) this.notify(cx); }
    });
  }
  applyPending(cx) {
    for (const [path, result] of this.deferred) {
      const entry = this.entries.get(path);
      if (entry) { entry.data = result.data; entry.fingerprint = result.fingerprint; entry.changed = entry.meta?.fingerprint !== result.fingerprint; }
    }
    this.deferred.clear();
    if (this.pendingManifest) { const pending = this.pendingManifest; this.pendingManifest = null; this.applyManifest(pending.data, pending.revision, cx); }
    this.changedWhileEditing = false;
    this.rebuild(cx); this.pump(cx);
  }
  operation(cx, task) {
    if (this.busy || this.closed) return;
    this.busy = true; this.error = null; this.rebuild(cx);
    cx.spawn(async cx => {
      try { await task(cx); }
      catch (e) { this.error = errorText(e); }
      finally { this.busy = false; if (!this.closed) { this.rebuild(cx); this.pump(cx); this.notify(cx); } }
    });
    this.notify(cx);
  }
  pick(path, cx) {
    this.activePath = path; this.jumpPath = path; this.collapsed.delete(path);
    this.rebuild(cx); this.enqueue(path, cx, true); this.notify(cx);
  }
  toggleCollapse(path, cx) {
    if (this.selection?.path === path) { this.error = "Save or cancel the open comment before collapsing its file."; this.notify(cx); return; }
    this.collapsed.has(path) ? this.collapsed.delete(path) : this.collapsed.add(path);
    this.rebuild(cx); this.enqueue(path, cx); this.notify(cx);
  }
  syncPendingViewed(path) {
    const data = this.pendingManifest?.data;
    if (!data) return;
    data.viewed = { ...(data.viewed || {}) };
    const token = this.viewed[path];
    if (token && data.files.some(f => f.path === path && f.fingerprint === token)) data.viewed[path] = token;
    else delete data.viewed[path];
  }
  toggleViewed(path, cx) {
    if (this.selection?.path === path) { this.error = "Save or cancel the open comment first."; this.notify(cx); return; }
    const entry = this.entries.get(path), checked = !this.viewed[path];
    if (!entry?.meta || this.busy || this.viewedPending.has(path)) return;
    const fingerprint = entry.meta.fingerprint, previous = this.viewed[path], wasCollapsed = this.collapsed.has(path);
    this.viewedPending.set(path, { checked, fingerprint });
    if (checked) this.viewed[path] = fingerprint; else delete this.viewed[path];
    checked ? this.collapsed.add(path) : this.collapsed.delete(path);
    this.syncPendingViewed(path);
    this.error = null; this.rebuild(cx); this.notify(cx);
    // Viewed is independent per file, not a global operation that dims every
    // control. Acknowledgement has no visual state change or second redraw.
    cx.spawn(async cx => {
      try { await this.call("viewed", { path, fingerprint, viewed: checked }); }
      catch (e) {
        if (this.closed) return;
        const unchanged = this.entries.get(path)?.meta?.fingerprint === fingerprint;
        if (unchanged && previous) this.viewed[path] = previous; else delete this.viewed[path];
        this.syncPendingViewed(path);
        if (unchanged && this.selection?.path !== path && this.collapsed.has(path) === checked) {
          wasCollapsed ? this.collapsed.add(path) : this.collapsed.delete(path);
        }
        this.error = errorText(e); this.rebuild(cx); this.notify(cx);
      } finally { this.viewedPending.delete(path); }
    });
    this.enqueue(path, cx);
  }
  activate(key, cx) {
    if (this.busy) return;
    const row = this.byKey.get(key);
    if (!row) return; // An event queued before a background replacement.
    if (isCode(row)) {
      !row.readOnly && hitLine(row, this.press) ? this.select(key, cx) : this.highlightLine(row, cx);
      return;
    }
    switch (hitControl(row, this.press)) {
      case "collapse": this.toggleCollapse(row.path, cx); break;
      case "viewed": this.toggleViewed(row.path, cx); break;
      case "expand": if (!this.selection) this.expandContext(row, cx); break;
      case "edit": this.editComment(row.comment.id, cx); break;
      case "delete": this.deleteComment(row.comment.id, cx); break;
      case "cancel": this.cancelComment(cx); break;
      case "save": this.saveComment(cx); break;
      case "retry": this.entries.get(row.path).error = null; this.enqueue(row.path, cx, true); this.rebuild(cx); this.notify(cx); break;
    }
  }
  highlightLine(row, cx) {
    const hit = hitCode(row, this.press);
    if (!hit) return;
    const current = this.highlight;
    const extend = this.press.shift && current?.path === row.path && current.snapshot === row.snapshot && current.side === hit.side;
    if (this.press.shift && current && !extend) { this.error = "A range must stay on the same file, snapshot and side."; this.notify(cx); return; }
    const anchor = extend ? current.anchor : hit.number, start = Math.min(anchor, hit.number), end = Math.max(anchor, hit.number);
    if (end - start >= 50) { this.error = "Select at most 50 lines."; this.notify(cx); return; }
    this.highlight = { path: row.path, snapshot: row.snapshot, side: hit.side, start, end, anchor };
    // This is only a visual line selection. Never relocate an open draft.
    this.jumpPath = null; this.error = null; this.notify(cx);
  }
  select(key, cx) {
    if (this.busy) return;
    const item = this.byKey.get(key), hit = item && hitLine(item, this.press);
    if (!hit || item.readOnly) return;
    const current = this.selection || this.highlight;
    if (this.selection && !this.press.shift && this.note.value().trim()) {
      this.error = "Save or cancel your current comment first. Shift-click + to extend its range."; this.notify(cx); return;
    }
    const extend = this.press.shift && current && !current.commentId && current.path === item.path && current.snapshot === item.snapshot && current.side === hit.side;
    if (this.press.shift && current && !extend) { this.error = "A range must stay on the same file, snapshot and side."; this.notify(cx); return; }
    const h = this.highlight;
    const selectedRange = !extend && h?.path === item.path && h.snapshot === item.snapshot && h.side === hit.side && hit.number >= h.start && hit.number <= h.end;
    const anchor = extend ? current.anchor : selectedRange ? h.anchor : hit.number;
    const start = selectedRange ? h.start : Math.min(anchor, hit.number), end = selectedRange ? h.end : Math.max(anchor, hit.number);
    if (end - start >= 50) { this.error = "A comment can cover at most 50 lines."; this.notify(cx); return; }
    this.selection = { path: item.path, snapshot: item.snapshot, side: hit.side, start, end, anchor };
    this.highlight = { ...this.selection };
    this.jumpPath = null; this.error = null; this.rebuild(cx); this.scrollTo("inline-editor"); this.note.focus(); this.notify(cx);
  }
  cancelComment(cx) {
    this.selection = null; this.note.set_value(""); this.applyPending(cx); this.notify(cx);
  }
  saveComment(cx) {
    if (!this.selection || !this.note.value().trim()) return;
    const s = this.selection;
    const extra = { snapshot: s.snapshot, side: s.side, start: s.start, end: s.end, body: this.note.value() };
    if (s.commentId) extra.id = s.commentId;
    this.operation(cx, async cx => {
      const result = await this.call("comment", extra);
      this.comments = result.comments; this.revision++;
      const saved = s.commentId || this.comments.find(c => c.snapshot === s.snapshot && c.side === s.side && c.start === s.start && c.body === extra.body.trim())?.id;
      this.selection = null; this.note.set_value(""); this.applyPending(cx);
      if (saved) this.scrollTo(`comment:${saved}`);
    });
  }
  editComment(id, cx) {
    if (this.busy) return;
    if (this.selection && this.note.value().trim()) { this.error = "Save or cancel the open comment first."; this.notify(cx); return; }
    const c = this.comments.find(c => c.id === id);
    if (!c) return;
    this.selection = { ...c, commentId: c.id, anchor: c.start };
    this.highlight = { path: c.path, snapshot: c.snapshot, side: c.side, start: c.start, end: c.end, anchor: c.start };
    this.note.set_value(c.body); this.jumpPath = null; this.collapsed.delete(c.path);
    this.rebuild(cx); this.scrollTo("inline-editor"); this.note.focus(); this.notify(cx);
  }
  deleteComment(id, cx) {
    this.operation(cx, async cx => {
      const result = await this.call("delete", { id });
      this.comments = result.comments; this.revision++;
      if (this.selection?.commentId === id) { this.selection = null; this.note.set_value(""); this.applyPending(cx); }
      this.rebuild(cx);
    });
  }
  expandContext(row, cx) {
    if (this.selection) { this.error = "Save or cancel the open comment before expanding context."; this.notify(cx); return; }
    const entry = this.entries.get(row.path);
    if (!entry?.data || !row.gap || !row.expand || row.snapshot !== entry.data.snapshot) return;
    const data = entry.data, count = Math.min(10, row.gap.count);
    const offset = row.expand === "up" ? row.gap.count - count : 0;
    const range = { old_start: row.gap.old_start + offset, new_start: row.gap.new_start + offset, count };
    this.jumpPath = null;
    this.operation(cx, async () => {
      const expanded = await this.call("snapshot", { snapshot: data.snapshot, context: data.context ?? 3, reveal: [...(data.reveal || []), range] });
      // An in-flight fresh capture wins over expansion of an older snapshot.
      if (entry.data === data) entry.data = expanded;
      // Stable code keys let the native list retain its viewport. Never jump
      // to the file header when revealing code halfway down a long file.
    });
  }
  target() { return agents().find(a => a.address === this.agent && a.space === this.space); }
  prepare(cx) {
    if (this.selection) { this.error = "Save or cancel the open comment before sending your review."; this.notify(cx); return; }
    this.operation(cx, async () => {
      this.preview = await this.call("prepare"); this.delivery = null;
      this.previewEditor.set_value(this.preview.text);
    });
  }
  async finishDelivery(cx) {
    const result = await this.call("sent", { review_id: this.preview.review_id });
    this.comments = result.comments; this.revision++; this.preview = null; this.delivery = null;
    this.message = `Feedback submitted to ${this.agentName}. A local archive was kept.`;
    this.applyPending(cx);
  }
  send(cx) {
    if (!this.preview || this.delivery) return;
    const target = this.target();
    if (!target || target.status === "working" || target.status === "blocked") return;
    this.operation(cx, async cx => {
      await submitToIdleAgent(hc, this.agent, this.preview.text);
      this.delivery = true;
      try { await this.finishDelivery(cx); }
      catch (e) { throw new Error(`Sent, but archiving failed. Do not resend. Retry archive: ${errorText(e)}`); }
    });
  }
  fragments(parts, kind, t) {
    const palette = { keyword: t.ansi5, string: t.ansi3, comment: t.dim, type: t.ansi4, delimiter: t.ansi6 };
    return h_flex().h(22).min_w(0).flex_1().overflow_hidden().children(parts.map(s =>
      div().flex_none().text_color(s.changed ? palette[s.highlight] || t.foreground : t.foreground)
        .when(s.changed, el => el.bg(kind === "old" ? t.tokenDel : t.tokenAdd)).child(s.text)));
  }
  codeCell(source, side, row, t) {
    const s = this.highlight;
    const selected = source && s && s.path === row.path && s.snapshot === row.snapshot && s.side === side && source.number >= s.start && source.number <= s.end;
    return v_flex().flex_1().min_w(0).h_full().relative().bg(lineBackground(source?.kind || "empty", t))
      .when(side === "old" && row.kind === "split", el => el.border_r(1).border_color(t.border))
      .children((source?.wrapped || []).map((parts, index) => h_flex().h(22).flex_none().w_full().items_center().gap(4).pr(6)
        .child(div().w(gutter.number).h(22).flex_none().pr(8).text_right().bg(gutterBackground(source.kind, t)).text_color(selected || source.kind === "old" || source.kind === "new" ? t.foreground : t.dim).child(index === 0 ? String(source.number) : ""))
        .child(div().w(9).flex_none().text_color(source.kind === "old" ? t.ansi1 : t.ansi2).child(index ? " " : source.kind === "old" ? "−" : source.kind === "new" ? "+" : " "))
        .child(this.fragments(parts, source.kind, t))))
      // A native hover layer contains only the badge/outline, not the code.
      // Opacity therefore never dims syntax, and hovering another line does
      // not touch the persistent clicked-line selection or run JavaScript.
      .when(Boolean(source) && (!row.readOnly || Boolean(selected)), el => el.child(div().id(`line-hover:${row.key}:${side}`).absolute().inset_0().opacity(selected ? 1 : 0).hover(s => s.opacity(1))
        .when(Boolean(selected), el => el.child(div().absolute().left(gutter.plusLeft + gutter.plusSize - 1).right(0).top(0).bottom(0).border(2).border_color(t.accent)))
        .when(!row.readOnly, el => el.child(div().absolute().left(gutter.plusLeft).top(0).size(gutter.plusSize).rounded(5).bg(t.accent).text_color("#ffffff").flex().items_center().justify_center().cursor_pointer().child(icon("add-comment", 16))))));
  }
  codeRow(row, t) {
    const box = h_flex().h(row.height).w_full().border_x(1).border_color(t.border).font_family(settings().font_family || "JetBrains Mono").text_size(12);
    return row.kind === "split" ? box.child(this.codeCell(row.old, "old", row, t)).child(this.codeCell(row.new, "new", row, t))
      : box.child(this.codeCell(row, row.side, row, t));
  }
  bubbleRow(row, t, content) {
    const surround = row.surround;
    const sides = surround.layout === "split" ? ["old", "new"] : ["new"];
    const box = div().h(row.height).w_full().relative().border_x(1).border_color(t.border)
      .child(h_flex().absolute().inset_0().children(sides.map(side => div().flex_1().h_full().bg(lineBackground(surround[side], t))
        .when(side === "old" && surround.layout === "split", el => el.border_r(1).border_color(t.border))
        .child(div().w(gutter.number).h_full().bg(gutterBackground(surround[side], t))))));
    if (content) box.child(div().absolute().left(row.frame.x).top(0).w(row.frame.width).h(row.height).child(content));
    return box;
  }
  editorRow(row, t) {
    const s = row.selection;
    return this.bubbleRow(row, t, v_flex().id("inline-comment-editor").h(row.height).px(12).py(12).gap(10).rounded_t(7).bg(t.comment).border(1).border_b(0).border_color(t.commentBorder)
      .child(h_flex().gap(8).items_center().flex_none()
        .child(icon("comment", 18).text_color(t.muted))
        .child(div().min_w(0).truncate().text_size(14).font_semibold().child(`${s.commentId ? "Edit comment" : "Add a comment"} on ${anchorLabel(s)}`)))
      .when(this.changedWhileEditing, el => el.child(div().flex_none().text_size(10).text_color(t.blocked).child("File changed · original snapshot retained")))
      .child(div().flex_1().min_h(0).px(10).py(7).bg(t.input).rounded(6).border_1().border_color(t.controlBorder)
        .child(Textarea.new(this.note).size_full().text_size(13))));
  }
  viewedControl(path, t) {
    const checked = Boolean(this.viewed[path]);
    return h_flex().id(`viewed-${path}`).w(controlWidths.viewed).h(28).px(9).gap(7).flex_none().items_center().justify_center().rounded(6)
      .bg(checked ? t.viewedBg : t.background).border(1).border_color(checked ? t.accent : t.controlBorder)
      .text_size(12).text_color(checked ? t.foreground : t.muted).cursor_pointer().hover(s => s.bg(checked ? t.viewedBg : t.hover))
      .role("button").accessibility_label(`${checked ? "Mark not viewed" : "Mark viewed"}: ${path}`).disabled(this.busy)
      .child(div().id(`viewed-check:${path}`).size(14).flex_none().rounded(3).border(1).border_color(checked ? t.accent : t.controlBorder)
        .bg(checked ? t.accent : t.input).text_color("#ffffff").flex().items_center().justify_center()
        .when(checked, el => el.child(icon("check", 11))))
      .child(div().child("Viewed"));
  }
  specialRow(row, t) {
    const control = (id, text, name, enabled = true, primary = false) => button(id, text, null, enabled, primary).w(controlWidths[name]).px(0);
    const shell = () => v_flex().h(row.height).w_full().bg(t.background).border_x(1).border_color(t.border);
    if (row.kind === "bubble-gap") return this.bubbleRow(row, t);
    if (row.kind === "editor") return this.editorRow(row, t);
    if (row.kind === "editor-actions") return this.bubbleRow(row, t, h_flex().h(row.height).px(14).pb(12).gap(8).justify_end().rounded_b(7).bg(t.comment).border(1).border_t(0).border_color(t.commentBorder)
      .child(control("comment-cancel", "Cancel", "cancel", !this.busy))
      .child(control("comment-save", row.selection.commentId ? "Save changes" : "Add comment", "save", !this.busy && Boolean(this.note.value().trim()), true)));
    if (row.kind === "file") {
      const entry = row.entry;
      const add = row.meta.add ?? entry?.data?.add, del = row.meta.del ?? entry?.data?.del;
      return h_flex().id(`card-${row.path}`).h(row.height).px(12).gap(9).items_center().bg(t.raised).rounded_t(6).border(1).border_color(t.border)
        .child(control(`collapse-${row.path}`, this.collapsed.has(row.path) ? "▸" : "▾", "collapse", !this.busy))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(row.path))
        .when(add !== null && add !== undefined, el => el.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
        .when(del !== null && del !== undefined, el => el.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
        .when(Boolean(entry?.changed || entry?.data?.stale || row.meta.status === "draft"), el => el.child(div().text_size(10).text_color(t.blocked).child(row.meta.status === "draft" ? "Outdated draft context" : "Changed since capture")))
        .when(row.meta.status !== "draft", el => el.child(this.viewedControl(row.path, t)));
    }
    if (row.kind === "hunk") return h_flex().h(row.height).items_center().bg(t.hunk).border_x(1).border_color(t.border)
      .when(Boolean(row.expand), el => el.child(div().id(`expand-${row.key}`).w(controlWidths.expand).h_full().flex_none().flex().items_center().justify_center()
        .bg(t.selected).text_color(t.dim).role("button").accessibility_label(`Expand ${Math.min(10, row.gap.count)} lines ${row.expand === "up" ? "above" : "below"}`)
        .disabled(this.busy || Boolean(this.selection))
        .when(!this.busy && !this.selection, el => el.cursor_pointer().hover(s => s.bg(t.accent).text_color("#ffffff")))
        .tooltip(`Expand ${Math.min(10, row.gap.count)} lines ${row.expand === "up" ? "above" : "below"}`)
        .child(icon(`expand-${row.expand}`, 18))))
      .child(div().flex_1().min_w(0).px(12).truncate().font_family(settings().font_family || "JetBrains Mono").text_size(11).text_color(t.dim).child(row.text));
    if (row.kind === "comment") return this.bubbleRow(row, t, h_flex().h(row.height).px(12).gap(6).items_center().rounded_t(7).border(1).border_color(t.commentBorder).bg(t.commentHeader)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(row.outdated ? t.blocked : t.muted).child(`${row.outdated ? "Outdated · " : ""}Comment on ${anchorLabel(row.comment)}`))
      .child(control(`edit-${row.comment.id}`, "Edit", "edit", !this.busy).h(22).text_size(10))
      .child(control(`delete-${row.comment.id}`, "Delete", "delete", !this.busy).h(22).text_size(10)));
    if (row.kind === "comment-body") return this.bubbleRow(row, t, v_flex().h(row.height).p(12).rounded_b(7).border_x(1).border_b(1).border_color(t.commentBorder).bg(t.comment)
      .child(v_flex().id(`comment-body-${row.comment.id}`).flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .child(h_flex().h(22).flex_none().gap(7).items_center()
          .child(div().size(22).rounded_full().bg(t.raised).text_color(t.muted).text_size(10).flex().items_center().justify_center().child("Y"))
          .child(div().font_semibold().child("You"))
          .child(div().text_size(10).text_color(t.muted).child("Draft")))
        .when(row.outdated, el => el.child(div().p(7).bg(t.hunk).font_family(settings().font_family || "JetBrains Mono").text_size(11).whitespace_normal().child(row.comment.quote)))
        .child(div().text_size(13).whitespace_normal().child(row.comment.body))));
    if (row.kind === "end") return shell().border_b(1).rounded_b(6);
    if (row.kind === "spacer") return div().h(row.height);
    return h_flex().h(row.height).px(12).py(9).gap(7).items_center().bg(t.background).border_x(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).whitespace_normal().child(row.text))
      .when(row.retry, el => el.child(control(`retry-${row.path}`, "Try again", "retry", !this.busy).h(23)));
  }
  sidebar(t) {
    return v_flex().w(240).h_full().flex_none().min_h(0).border_r(1).border_color(t.border).bg(t.sidebar)
      .child(h_flex().h(43).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files changed"))
        .child(div().rounded(8).px(5).bg(t.raised).text_size(10).child(String(this.files.length))))
      .child(v_flex().id("review-file-tree").flex_1().min_h(0).overflow_y_scrollbar().py(8).children(fileTree(this.files, this.folded).map(node => {
        const folder = node.kind === "folder", count = this.comments.filter(c => c.path === node.path).length;
        return h_flex().id(`tree-${node.path}`).h(29).flex_none().px(10).pl(10 + node.depth * 13).gap(6).items_center().rounded(4)
          .bg(this.activePath === node.path ? t.selected : t.sidebar).hover(s => s.bg(t.hover)).cursor_pointer().tooltip(node.path)
          .on_click((_e, cx) => {
            if (folder) { this.folded.has(node.path) ? this.folded.delete(node.path) : this.folded.add(node.path); this.notify(cx); }
            else this.pick(node.path, cx);
          })
          .child(div().w(12).flex_none().text_color(t.muted).child(folder ? this.folded.has(node.path) ? "▸" : "▾" : ""))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(node.name))
          .when(!folder && Boolean(count), el => el.child(div().text_size(10).text_color(t.ansi4).child(String(count))))
          .when(!folder, el => el.child(div().text_size(10).text_color(node.status === "A" ? t.ansi2 : node.status === "D" ? t.ansi1 : t.blocked).child(node.status)));
      })))
      .when(!this.files.length, el => el.child(div().p(12).text_size(11).text_color(t.muted).child(this.scanning ? "Loading changes…" : "No uncommitted changes")));
  }
  page(t) {
    const rows = this.rows;
    // Keep a coherent list version for the whole native layout pass. Nothing
    // here owns a JS row entity, event handler, or cached native element.
    return v_flex().id("review-page").flex_1().h_full().min_w(0).min_h(0).px(16).pt(12).bg(t.canvas)
      .on_size_change((size, cx) => {
        const width = Math.max(200, size.width - 32);
        if (Math.abs((this.width || 0) - width) > 1) { this.width = width; this.rebuild(cx); this.notify(cx); }
      })
      .child(div().id("review-hitbox").flex_1().w_full().min_h(0).relative()
        .on_mouse_down("left", e => { if (e.local_position && e.bounds) this.press = { x: e.local_position.x, width: e.bounds.width, shift: Boolean(e.modifiers?.shift) }; })
        .when(Boolean(this.jumpPath), el => el.on_scroll_wheel(() => { this.jumpPath = null; }))
        .child(v_virtual_list("review-page-list", rows.length, rows.map(row => row.height), i => rows[i].key,
          range => {
            const visible = rows.slice(range.start, range.end);
            if (rows === this.rows) this.visiblePaths = [...new Set(visible.map(row => row.path))];
            return visible.map(row => isCode(row) ? this.codeRow(row, t) : this.specialRow(row, t));
          })
          .size_full().track_scroll(this.scroll).on_item_click((key, cx) => this.activate(key, cx)))
        .child(Scrollbar.vertical("review-page-list").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, el => el.child(v_flex().absolute().inset_0().items_center().justify_center().gap(8).text_color(t.muted)
          .child(div().text_size(17).child(this.scanning ? "Loading changes…" : "Nothing to review"))
          .child(div().text_size(12).child(this.error ? "" : "All current uncommitted changes will appear here.")))));
  }
  previewView(t) {
    const target = this.target(), enabled = Boolean(target && !["working", "blocked"].includes(target.status) && !this.busy && !this.delivery);
    return v_flex().flex_1().min_h(0).p(16).gap(10)
      .child(h_flex().items_center().gap(8).child(div().font_semibold().child(`Send ${this.preview.count} comment${this.preview.count === 1 ? "" : "s"} to ${this.agentName}`))
        .child(div().flex_1()).child(button("preview-back", "Back to changes", cx => { this.preview = null; this.applyPending(cx); this.notify(cx); }, !this.busy && !this.delivery)))
      .when(this.preview.stale_count > 0, el => el.child(div().text_color(t.blocked).child(`${this.preview.stale_count} outdated comments include their original quoted code.`)))
      .when(this.preview.text.length > 8000, el => el.child(div().text_size(11).text_color(t.blocked).child("Large review: check the agent transcript to confirm receipt.")))
      .child(div().flex_1().min_h(0).border_1().border_color(t.border).rounded(6).child(Editor.new(this.previewEditor).size_full()))
      .child(div().text_size(11).text_color(t.muted).child(!target ? "The originating agent is no longer available. Drafts remain saved." : `Recipient: ${this.agentName} · ${this.agent} · ${target.status}. Feedback is sent only when idle.`))
      .child(h_flex().justify_end()
        .when(Boolean(this.delivery), el => el.child(button("retry-archive", "Sent · retry archive", cx => this.operation(cx, cx => this.finishDelivery(cx)), !this.busy)))
        .when(!this.delivery, el => el.child(button("review-send", "Send feedback", cx => this.send(cx), enabled, true))));
  }
  render() {
    const t = desktopColors(settings().dark !== false);
    return v_flex().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .when(Boolean(this.error), el => el.child(div().flex_none().px(14).py(7).bg(t.diffDel).text_color(t.ansi1).whitespace_normal().child(this.error)))
      .when(Boolean(this.message) && !this.preview, el => el.child(div().flex_none().px(14).py(6).bg(t.diffAdd).text_color(t.ansi2).child(this.message)))
      .when(Boolean(this.preview), el => el.child(this.previewView(t)))
      .when(!this.preview, el => el
        .child(h_flex().flex_1().min_h(0).child(this.sidebar(t)).child(this.page(t)))
        .child(h_flex().h(46).flex_none().px(14).gap(10).items_center().border_t(1).border_color(t.border)
          .child(div().text_size(11).text_color(t.muted).child(`${Object.keys(this.viewed).length}/${this.files.length} files viewed · ${this.comments.length} draft comment${this.comments.length === 1 ? "" : "s"}`))
          .child(div().flex_1())
          .child(button("review-preview", `Review & send${this.comments.length ? ` (${this.comments.length})` : ""}`, cx => this.prepare(cx), !this.busy && !this.selection && this.comments.length > 0, true))));
  }
  close() { this.closed = true; }
}
