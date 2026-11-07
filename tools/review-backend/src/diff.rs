use super::*;
use serde::Deserialize;
use std::{
    collections::HashMap,
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

const DIFFT_VERSION: &str = "0.72.0";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Span {
    start: usize,
    end: usize,
    highlight: String,
}
// A range of identical lines in the two frozen sides, never working-tree text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ContextRange {
    old_start: usize,
    new_start: usize,
    count: usize,
}
#[derive(Clone, Debug, Serialize)]
struct Gap {
    #[serde(flatten)]
    range: ContextRange,
    before: bool,
    after: bool,
}
#[derive(Clone, Debug, Serialize)]
pub(super) struct Row {
    pub(super) kind: String,
    side: Option<String>,
    number: Option<usize>,
    old_number: Option<usize>,
    new_number: Option<usize>,
    text: String,
    spans: Vec<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gap: Option<Gap>,
}
#[derive(Serialize)]
pub(super) struct Rendered {
    engine: String,
    notice: Option<String>,
    pub(super) rows: Vec<Row>,
}
#[derive(Deserialize)]
struct Difft {
    status: String,
    aligned_lines: Option<Vec<(Option<usize>, Option<usize>)>>,
    #[serde(default)]
    chunks: Vec<Vec<Line>>,
}
#[derive(Deserialize)]
struct Line {
    lhs: Option<Side>,
    rhs: Option<Side>,
}
#[derive(Deserialize)]
struct Side {
    line_number: usize,
    changes: Vec<Span>,
}

fn row(kind: &str, old: Option<usize>, new: Option<usize>, text: &str, spans: Vec<Span>) -> Row {
    let side = if new.is_some() {
        Some("new".into())
    } else if old.is_some() {
        Some("old".into())
    } else {
        None
    };
    Row {
        kind: kind.into(),
        side,
        number: new.or(old),
        old_number: old,
        new_number: new,
        text: text.into(),
        spans,
        gap: None,
    }
}
fn files(s: &Snapshot) -> Result<(tempfile::TempDir, PathBuf, PathBuf)> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let name = Path::new(&s.path).file_name().ok_or("Missing filename")?;
    let old_dir = dir.path().join("old");
    let new_dir = dir.path().join("new");
    fs::create_dir(&old_dir).map_err(|e| e.to_string())?;
    fs::create_dir(&new_dir).map_err(|e| e.to_string())?;
    // Preserve special basenames (Dockerfile, Makefile, .gitignore) for language detection.
    let old = old_dir.join(name);
    let new = new_dir.join(name);
    fs::write(&old, &s.old).map_err(|e| e.to_string())?;
    fs::write(&new, &s.new).map_err(|e| e.to_string())?;
    Ok((dir, old, new))
}
fn textual(s: &Snapshot, notice: Option<String>) -> Result<Rendered> {
    let (dir, old, new) = files(s)?;
    let r = output(git_at(
        dir.path(),
        &[
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            &format!("--unified={MAX_LINES}"),
            "--",
            old.to_str().ok_or("Invalid temp path")?,
            new.to_str().ok_or("Invalid temp path")?,
        ],
    ))?;
    if !matches!(r.status.code(), Some(0 | 1)) {
        return Err(String::from_utf8_lossy(&r.stderr).into());
    }
    let patch = String::from_utf8(r.stdout).map_err(|e| e.to_string())?;
    Ok(Rendered {
        engine: "Git text diff".into(),
        notice,
        // Request complete context once, then compact both engines identically.
        // Keep newline annotations, but regenerate range headers after folding.
        rows: parse_patch(&patch)?
            .into_iter()
            .filter(|r| r.kind != "hunk" || !r.text.starts_with("@@ "))
            .collect(),
    })
}
fn parse_patch(patch: &str) -> Result<Vec<Row>> {
    let mut rows = Vec::new();
    let (mut old, mut new) = (0, 0);
    let mut in_hunk = false;
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let nums: Vec<_> = line.split_whitespace().collect();
            let parse = |s: &str| {
                s[1..]
                    .split(',')
                    .next()
                    .unwrap_or("")
                    .parse::<usize>()
                    .map_err(|e| e.to_string())
            };
            old = parse(nums.get(1).ok_or("Bad old hunk")?)?;
            new = parse(nums.get(2).ok_or("Bad new hunk")?)?;
            in_hunk = true;
            rows.push(row("hunk", None, None, line, vec![]));
        } else if in_hunk {
            if let Some(text) = line.strip_prefix('-') {
                rows.push(row("old", Some(old), None, text, vec![]));
                old += 1;
            } else if let Some(text) = line.strip_prefix('+') {
                rows.push(row("new", None, Some(new), text, vec![]));
                new += 1;
            } else if let Some(text) = line.strip_prefix(' ') {
                rows.push(row("context", Some(old), Some(new), text, vec![]));
                old += 1;
                new += 1;
            } else if line.starts_with('\\') {
                rows.push(row("hunk", None, None, line, vec![]));
            }
        }
    }
    Ok(rows)
}
fn difft(s: &Snapshot) -> Result<Rendered> {
    let binary = std::env::var("HERDR_REVIEW_DIFFT").unwrap_or_else(|_| "difft".into());
    let mut version_cmd = Command::new(&binary);
    version_cmd.arg("--version");
    let version = String::from_utf8(checked(version_cmd)?).map_err(|e| e.to_string())?;
    if version.lines().next() != Some(&format!("Difftastic {DIFFT_VERSION}")) {
        return Err(format!(
            "Difftastic JSON adapter is tested with {DIFFT_VERSION}; installed: {}",
            version.lines().next().unwrap_or("unknown")
        ));
    }
    let (_dir, old, new) = files(s)?;
    let stdout = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let stderr = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut child = Command::new(&binary)
        .args([
            "--display=json",
            "--color=never",
            "--graph-limit=1000000",
            "--byte-limit=524288",
            "--parse-error-limit=0",
        ])
        .arg(&old)
        .arg(&new)
        .env("DFT_UNSTABLE", "yes")
        .env_remove("DFT_OVERRIDE")
        .stdout(Stdio::from(stdout.reopen().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(stderr.reopen().map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !matches!(status.code(), Some(0 | 1)) {
                return Err(fs::read_to_string(stderr.path()).unwrap_or_default());
            }
            break;
        }
        if start.elapsed() > Duration::from_secs(12) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Difftastic exceeded 12 seconds".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    if stdout
        .as_file()
        .metadata()
        .map_err(|e| e.to_string())?
        .len()
        > 6 * 1024 * 1024
    {
        return Err("Difftastic output exceeded 6 MiB".into());
    }
    let json: Difft = serde_json::from_slice(&fs::read(stdout.path()).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Unsupported Difftastic JSON: {e}"))?;
    if json.status == "unchanged" {
        return textual(
            s,
            Some(
                "No structural changes. Showing text changes (including formatting) instead."
                    .into(),
            ),
        );
    }
    // Created/deleted files have no JSON token spans or alignment in 0.72.0.
    let Some(aligned) = json.aligned_lines else {
        return textual(
            s,
            Some("Difftastic supplied no alignment for this file; showing text diff.".into()),
        );
    };
    let mut lhs = HashMap::new();
    let mut rhs = HashMap::new();
    for chunk in json.chunks {
        for l in chunk {
            if let Some(v) = l.lhs {
                lhs.insert(v.line_number, v.changes);
            }
            if let Some(v) = l.rhs {
                rhs.insert(v.line_number, v.changes);
            }
        }
    }
    let old: Vec<_> = s.old.lines().collect();
    let new: Vec<_> = s.new.lines().collect();
    let mut rows = Vec::new();
    for (a, b) in aligned {
        let old_line = a.and_then(|i| old.get(i));
        let new_line = b.and_then(|i| new.get(i));
        // Keep formatting changes visible too: there is intentionally no
        // structural/text toggle in the review-only UI.
        let changed = old_line != new_line
            || a.is_some_and(|i| lhs.contains_key(&i))
            || b.is_some_and(|i| rhs.contains_key(&i));
        let validate = |spans: Vec<Span>, text: &str| -> Result<Vec<Span>> {
            if spans.iter().any(|s| {
                s.start > s.end || !text.is_char_boundary(s.start) || !text.is_char_boundary(s.end)
            }) {
                return Err("Difftastic returned invalid UTF-8 token offsets".into());
            }
            Ok(spans)
        };
        if changed {
            if let (Some(i), Some(text)) = (a, old_line) {
                rows.push(row(
                    "old",
                    Some(i + 1),
                    None,
                    text,
                    validate(lhs.remove(&i).unwrap_or_default(), text)?,
                ));
            }
            if let (Some(i), Some(text)) = (b, new_line) {
                rows.push(row(
                    "new",
                    None,
                    Some(i + 1),
                    text,
                    validate(rhs.remove(&i).unwrap_or_default(), text)?,
                ));
            }
        } else if let (Some(i), Some(text)) = (b, new_line) {
            rows.push(row("context", a.map(|i| i + 1), Some(i + 1), text, vec![]));
        } else if let (Some(i), Some(text)) = (a, old_line) {
            rows.push(row("context", Some(i + 1), None, text, vec![]));
        }
    }
    if !rows.iter().any(|r| r.kind == "old" || r.kind == "new") {
        return textual(s, Some("No structural hunks; showing text changes.".into()));
    }
    Ok(Rendered {
        engine: format!("Difftastic {DIFFT_VERSION}"),
        notice: None,
        rows,
    })
}
fn compact(rows: Vec<Row>, context: usize, reveal: &[ContextRange]) -> Vec<Row> {
    let mut keep = vec![false; rows.len()];
    for (i, r) in rows.iter().enumerate() {
        if r.kind != "context" {
            let end = rows.len().min(i + context + 1);
            keep[i.saturating_sub(context)..end].fill(true);
        } else if reveal.iter().any(|range| {
            r.old_number.zip(r.new_number).is_some_and(|(old, new)| {
                old.checked_sub(range.old_start)
                    .zip(new.checked_sub(range.new_start))
                    .is_some_and(|(a, b)| a == b && a < range.count)
            })
        }) {
            keep[i] = true;
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let r = &rows[i];
        if keep[i] {
            if i == 0 {
                out.push(row(
                    "hunk",
                    None,
                    None,
                    &format!(
                        "@@ old {} · new {} @@",
                        r.old_number.unwrap_or(0),
                        r.new_number.unwrap_or(0)
                    ),
                    vec![],
                ));
            }
            out.push(r.clone());
            i += 1;
        } else {
            let start = i;
            while i < rows.len() && !keep[i] {
                i += 1;
            }
            let count = i - start;
            let mut header = row("hunk", None, None, &format!("{count} hidden lines"), vec![]);
            header.gap = Some(Gap {
                range: ContextRange {
                    old_start: r.old_number.expect("unchanged old line"),
                    new_start: r.new_number.expect("unchanged new line"),
                    count,
                },
                before: start > 0,
                after: i < rows.len(),
            });
            out.push(header);
        }
    }
    out
}

pub(super) fn context_ranges(
    s: &Snapshot,
    mut reveal: Vec<ContextRange>,
) -> Result<Vec<ContextRange>> {
    let old_lines = s.old.lines().count();
    let new_lines = s.new.lines().count();
    if reveal.len() > MAX_LINES
        || reveal.iter().any(|r| {
            r.old_start == 0
                || r.new_start == 0
                || r.count == 0
                || r.old_start
                    .checked_add(r.count - 1)
                    .is_none_or(|end| end > old_lines)
                || r.new_start
                    .checked_add(r.count - 1)
                    .is_none_or(|end| end > new_lines)
        })
    {
        return Err("Context range is outside the snapshot".into());
    }
    // Repeated clicks grow a few intervals, not an ever-growing request log.
    reveal.sort_by_key(|r| (r.old_start, r.new_start));
    let mut merged: Vec<ContextRange> = Vec::new();
    for range in reveal {
        if let Some(last) = merged.last_mut() {
            if range.old_start <= last.old_start + last.count
                && range.old_start + last.new_start == range.new_start + last.old_start
            {
                last.count = last
                    .count
                    .max(range.old_start + range.count - last.old_start);
                continue;
            }
        }
        merged.push(range);
    }
    Ok(merged)
}

pub(super) fn render(
    s: &Snapshot,
    mode: &str,
    context: usize,
    reveal: &[ContextRange],
) -> Result<Rendered> {
    if !["text", "structural"].contains(&mode) {
        return Err("Mode must be structural or text".into());
    }
    // There is nothing structural to align in wholly added/deleted files.
    let mut rendered = if mode == "text" || s.old.is_empty() || s.new.is_empty() {
        textual(s, None)?
    } else {
        difft(s).or_else(|e| {
            textual(
                s,
                Some(format!(
                    "Structural diff unavailable: {e}. Showing text diff."
                )),
            )
        })?
    };
    rendered.rows = compact(rendered.rows, context, reveal);
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_numbers_and_deleted_side() {
        let rows = parse_patch(
            "--- a/a\n+++ b/a\n@@ -4,2 +4,2 @@\n same\n-old\n+new\n\\ No newline at end of file\n",
        )
        .unwrap();
        assert_eq!(rows[1].number, Some(4));
        assert_eq!(rows[2].side.as_deref(), Some("old"));
        assert_eq!(rows[2].number, Some(5));
        assert_eq!(rows[3].number, Some(5));
        assert_eq!(rows[4].kind, "hunk");
    }
}
