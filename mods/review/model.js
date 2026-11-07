// Pure helpers: the renderer uses UTF-16, while Difftastic reports UTF-8 byte offsets.
export function byteIndex(text, byteOffset) {
  let bytes = 0, index = 0;
  for (const ch of text) {
    if (bytes >= byteOffset) break;
    const cp = ch.codePointAt(0);
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    index += ch.length;
  }
  return index;
}
export function segments(text, spans = []) {
  const out = [];
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const start = byteIndex(text, span.start), end = byteIndex(text, span.end);
    if (start < at || end < start || end > text.length) continue;
    if (start > at) out.push({ text: text.slice(at, start), changed: false });
    out.push({ text: text.slice(start, end), changed: true, highlight: span.highlight });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), changed: false });
  return out.length ? out : [{ text: text || " ", changed: false }];
}
export function selectLine(row, selection) {
  if (!row.side || !row.number) return null;
  const side = selection?.side === "old" && row.kind === "context" && row.old_number ? "old" : row.side;
  const number = side === "old" ? row.old_number : row.new_number;
  const anchor = selection?.side === side ? selection.anchor : number;
  const start = Math.min(anchor, number), end = Math.max(anchor, number);
  if (end - start >= 50) throw new Error("Select at most 50 lines. Use New selection to start again.");
  return { side, start, end, anchor };
}
export function displayedRows(file, comments) {
  if (!file) return [];
  const matching = comments.filter(c => c.snapshot === file.snapshot);
  return file.diff.rows.flatMap((r, i) => [
    { ...r, key: `${file.snapshot}:${i}` },
    ...matching.filter(c => r.side && (c.side === "old" ? r.old_number : r.new_number) === c.end)
      .map(c => ({ kind: "comment", key: `comment:${c.id}`, comment: c })),
  ]);
}
// Pair each deletion/addition run; unchanged rows occupy both sides. One virtual
// list owns both columns, so vertical scrolling and inline comments stay aligned.
export function splitRows(file, comments) {
  if (!file) return [];
  const source = file.diff.rows, out = [];
  const add = (old, next, index) => {
    const left = old?.old_number ? { ...old, side: "old", number: old.old_number } : null;
    const right = next?.new_number ? { ...next, side: "new", number: next.new_number } : null;
    out.push({ kind: "split", key: `split:${file.snapshot}:${index}`, old: left, new: right });
    out.push(...comments.filter(c => c.snapshot === file.snapshot &&
      (c.side === "old" ? left?.number : right?.number) === c.end)
      .map(c => ({ kind: "comment", key: `comment:${c.id}`, comment: c })));
  };
  for (let i = 0; i < source.length;) {
    const row = source[i];
    if (row.kind === "hunk") { out.push({ ...row, key: `split:${file.snapshot}:${i++}` }); continue; }
    if (row.kind === "context") { add(row, row, i++); continue; }
    const start = i, old = [], next = [];
    while (i < source.length && source[i].kind === "old") old.push(source[i++]);
    while (i < source.length && source[i].kind === "new") next.push(source[i++]);
    if (i === start) { i++; continue; }
    for (let j = 0; j < Math.max(old.length, next.length); j++) add(old[j], next[j], `${start}:${j}`);
  }
  return out;
}

export function wrapSegments(text, spans, columns) {
  const lines = [[]];
  let used = 0;
  for (const segment of segments(text.slice(0, 4000), spans)) {
    for (const ch of segment.text.replace(/\t/g, "    ")) {
      const width = ch.codePointAt(0) > 0xffff ? 2 : 1;
      if (used + width > columns && used) { lines.push([]); used = 0; }
      const line = lines.at(-1), last = line.at(-1);
      if (last && last.changed === segment.changed && last.highlight === segment.highlight) last.text += ch;
      else line.push({ ...segment, text: ch });
      used += width;
    }
  }
  return lines;
}
export function errorText(e) { return String(e?.message ?? e); }
