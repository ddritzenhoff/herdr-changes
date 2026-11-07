import { splitRows, wrapSegments } from "./model.js";

export const layoutFor = status => status === "A" || status === "D" ? "unified" : "split";
export const isCode = row => ["split", "context", "old", "new"].includes(row.kind);
export const numberOn = (row, side) => row.kind === "split" ? row[side]?.number : row[`${side}_number`];
const lines = (text, columns) => String(text || "").split("\n").reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / columns)), 0);

// Cache immutable wrapped code per snapshot response. Comment edits, viewed
// flags and another file loading must not tokenize/wrap the entire repo again.
const wrappedFiles = new WeakMap();
function fileRows(data, meta, entry, width) {
  const layout = layoutFor(meta.status), signature = `${width}:${layout}:${meta.status === "draft"}:${entry.context || 3}`;
  const cached = wrappedFiles.get(data);
  if (cached?.signature === signature) return cached.rows;
  const source = layout === "split" ? splitRows(data, []) : data.diff.rows;
  let hasContextControl = false;
  const rows = source.map((original, index) => {
    const row = { ...original, path: meta.path, snapshot: data.snapshot, layout, readOnly: meta.status === "draft", height: 22 };
    if (isCode(row)) row.key = `code:${data.snapshot}:${numberOn(row, "old") || ""}:${numberOn(row, "new") || ""}`;
    else row.key = `hunk:${data.snapshot}:${index}:${row.text}`;
    if (row.kind === "hunk") {
      row.expand = meta.status !== "A" && meta.status !== "D" && (entry.context || 3) < 12000 && !hasContextControl;
      hasContextControl = true; row.height = 29;
    } else if (row.kind === "split") {
      const count = Math.max(12, Math.floor((width / 2 - 91) / 7.3));
      for (const side of ["old", "new"]) if (row[side]) row[side] = { ...row[side], wrapped: wrapSegments(row[side].text, row[side].spans, count) };
      row.height = Math.max(1, row.old?.wrapped.length || 0, row.new?.wrapped.length || 0) * 22;
    } else {
      row.wrapped = wrapSegments(row.text, row.spans, Math.max(12, Math.floor((width - 91) / 7.3)));
      row.height = Math.max(1, row.wrapped.length) * 22;
    }
    return row;
  });
  wrappedFiles.set(data, { signature, rows });
  return rows;
}

// Pure flattened page data; no native elements, entities or handlers are cached.
export function buildPage(files, entries, comments, selection, { width = 840, collapsed = new Set() } = {}) {
  const rows = [], columns = Math.max(12, Math.floor((width - 32) / 7.3));
  const paths = new Set(files.map(f => f.path));
  const all = [...files, ...[...new Set(comments.map(c => c.path))].filter(p => !paths.has(p)).map(path => ({ path, status: "draft", fingerprint: "" }))];
  // Give action strips their own keys so a single list-owned click callback
  // can hit-test by x only, without guessing a scrolled row's y coordinate.
  const editor = path => [
    { kind: "editor", key: "inline-editor", path, selection, height: 170 },
    { kind: "editor-actions", key: "inline-editor-actions", path, selection, height: 40 },
  ];
  const commentRow = (c, outdated) => [
    { kind: "comment", key: `comment:${c.id}`, path: c.path, comment: c, outdated, height: 32 },
    { kind: "comment-body", key: `comment-body:${c.id}`, path: c.path, comment: c, outdated,
      height: Math.min(268, 21 + lines(c.body, columns) * 18 + (outdated ? Math.min(4, lines(c.quote, columns)) * 17 + 24 : 0)) },
  ];
  for (const meta of all) {
    const path = meta.path, entry = entries.get(path), data = entry?.data;
    rows.push({ kind: "file", key: `file:${path}`, path, meta, entry, height: 43 });
    if (!collapsed.has(path)) {
      const matching = comments.filter(c => c.path === path);
      const placed = new Set();
      if (data) {
        const source = fileRows(data, meta, entry, width);
        for (const row of source) {
          rows.push(row);
          if (!isCode(row)) continue;
          for (const c of matching) {
            if (c.snapshot !== data.snapshot || numberOn(row, c.side) !== c.end || placed.has(c.id)) continue;
            rows.push(...commentRow(c, Boolean(data.stale || entry.changed))); placed.add(c.id);
            if (selection?.commentId === c.id) rows.push(...editor(path));
          }
          if (selection && !selection.commentId && selection.path === path && selection.snapshot === data.snapshot && numberOn(row, selection.side) === selection.end) rows.push(...editor(path));
        }
        if (!source.length) rows.push({ kind: "message", key: `empty:${path}`, path, text: "No text hunks (empty file or metadata-only change).", height: 55 });
        if (data.diff.notice) rows.push({ kind: "notice", key: `notice:${path}`, path, text: data.diff.notice, height: Math.min(100, 16 + lines(data.diff.notice, columns) * 16) });
      } else if (meta.status !== "draft") {
        rows.push({ kind: "message", key: `load:${path}`, path, text: entry?.error || "Loading diff…", load: !entry?.error, retry: Boolean(entry?.error), height: entry?.error ? Math.min(180, 64 + lines(entry.error, columns) * 16) : 60 });
      }
      for (const c of matching.filter(c => !placed.has(c.id))) {
        rows.push(...commentRow(c, Boolean(data || meta.status === "draft")));
        if (selection?.commentId === c.id) rows.push(...editor(path));
      }
      rows.push({ kind: "end", key: `end:${path}`, path, height: 7 });
    }
    rows.push({ kind: "spacer", key: `space:${path}`, path, height: 16 });
  }
  return rows;
}

export function fileTree(files, folded = new Set()) {
  const root = { children: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/"), name = parts.pop();
    let at = root, path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      if (!at.children.has(part)) at.children.set(part, { name: part, path, children: new Map(), files: [] });
      at = at.children.get(part);
    }
    at.files.push({ ...file, name });
  }
  const out = [];
  const visit = (node, depth) => {
    for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ kind: "folder", path: child.path, name: child.name, depth });
      if (!folded.has(child.path)) visit(child, depth + 1);
    }
    for (const file of node.files) out.push({ ...file, kind: "file", depth });
  };
  visit(root, 0);
  return out;
}

// Coordinates belong to the full page hitbox, which has no horizontal padding.
// The list delegates clicks by stable row key, avoiding listeners per code line.
export const controlWidths = { collapse: 28, viewed: 92, expand: 123, edit: 48, delete: 56, cancel: 68, save: 110, retry: 88 };
export function hitControl(row, press) {
  if (!press || !Number.isFinite(press.x) || !Number.isFinite(press.width) || press.width <= 0) return null;
  const x = press.x, end = press.width - (row.kind === "editor-actions" ? 14 : 12);
  const right = (action, offset = 0) => x >= end - offset - controlWidths[action] && x <= end - offset;
  if (row.kind === "file") {
    if (x >= 12 && x <= 12 + controlWidths.collapse) return "collapse";
    if (row.meta.status !== "draft" && right("viewed")) return "viewed";
  }
  if (row.kind === "hunk" && row.expand && right("expand")) return "expand";
  if (row.kind === "comment") {
    if (right("delete")) return "delete";
    if (right("edit", controlWidths.delete + 6)) return "edit";
  }
  if (row.kind === "editor-actions") {
    if (right("save")) return "save";
    if (right("cancel", controlWidths.save + 8)) return "cancel";
  }
  if (row.kind === "message" && row.retry && right("retry")) return "retry";
  return null;
}

export function hitLine(item, press) {
  if (!press || !isCode(item) || !Number.isFinite(press.x) || !Number.isFinite(press.width) || press.width <= 0) return null;
  const split = item.kind === "split", half = press.width / 2;
  const side = split ? press.x < half ? "old" : "new" : item.side;
  const localX = split && side === "new" ? press.x - half : press.x;
  const source = split ? item[side] : item;
  if (!source || !source.number || localX < 0 || localX > 23) return null;
  return { side, number: source.number };
}
