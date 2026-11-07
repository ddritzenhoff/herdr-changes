//! Local, read-only Git review service. One JSON request per invocation, one JSON response.
//! Only the private store is written; Git hooks, external diffs and textconv are never run.
mod diff;
mod store;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};
use store::{Comment, Store};

type Result<T> = std::result::Result<T, String>;
const MAX_FILE: usize = 512 * 1024;
const MAX_LINES: usize = 12_000;
const MAX_FILES: usize = 1000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
    cwd: String,
    #[serde(default = "worktree")]
    scope: String,
    base: Option<String>,
    path: Option<String>,
    snapshot: Option<String>,
    mode: Option<String>,
    context: Option<usize>,
    reveal: Option<Vec<diff::ContextRange>>,
    fingerprint: Option<String>,
    viewed: Option<bool>,
    side: Option<String>,
    start: Option<usize>,
    end: Option<usize>,
    body: Option<String>,
    id: Option<String>,
    review_id: Option<String>,
}
fn worktree() -> String {
    "worktree".into()
}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn required<'a>(v: &'a Option<String>, name: &str) -> Result<&'a str> {
    v.as_deref().ok_or_else(|| format!("Missing {name}"))
}
fn output(mut cmd: Command) -> Result<Output> {
    cmd.output()
        .map_err(|e| format!("Cannot run {:?}: {e}", cmd.get_program()))
}
fn checked(mut cmd: Command) -> Result<Vec<u8>> {
    let r = cmd.output().map_err(|e| e.to_string())?;
    if !r.status.success() {
        return Err(String::from_utf8_lossy(&r.stderr).trim().to_owned());
    }
    Ok(r.stdout)
}
fn git_at(root: &Path, args: &[&str]) -> Command {
    let mut c = Command::new("git");
    c.current_dir(root)
        .args([
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.autoRefreshIndex=false",
        ])
        .args(args)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    c
}
fn git_text(root: &Path, args: &[&str]) -> Result<String> {
    String::from_utf8(checked(git_at(root, args))?)
        .map(|s| s.trim_end_matches('\n').to_owned())
        .map_err(|_| "Git returned a non-UTF-8 path".into())
}
fn valid_path(path: &str) -> Result<()> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Expected a repository-relative file path".into());
    }
    Ok(())
}

struct Repo {
    root: PathBuf,
    scope: String,
    base: Option<String>,
    label: String,
}
impl Repo {
    fn open(req: &Request) -> Result<Self> {
        if !["worktree", "branch"].contains(&req.scope.as_str()) {
            return Err("Scope must be worktree or branch".into());
        }
        let root = PathBuf::from(git_text(
            Path::new(&req.cwd),
            &["rev-parse", "--show-toplevel"],
        )?);
        let head = git_text(&root, &["rev-parse", "--verify", "HEAD^{commit}"]).ok();
        let (base, label) = if req.scope == "worktree" {
            (head, "HEAD".into())
        } else {
            let main = ["origin/HEAD", "main", "master"]
                .into_iter()
                .find(|b| {
                    output(git_at(
                        &root,
                        &["rev-parse", "--verify", &format!("{b}^{{commit}}")],
                    ))
                    .is_ok_and(|r| r.status.success())
                })
                .ok_or("No origin/HEAD, main or master branch. Use Working tree instead.")?;
            (
                Some(git_text(&root, &["merge-base", "HEAD", main])?),
                format!("merge-base({main})"),
            )
        };
        Ok(Self {
            root,
            scope: req.scope.clone(),
            base,
            label,
        })
    }
    fn files(&self) -> Result<Vec<Value>> {
        // No rename detection: renames are a deletion plus an addition for stable side anchors.
        let mut paths = BTreeMap::new();
        if let Some(base) = &self.base {
            let data = checked(git_at(
                &self.root,
                &[
                    "diff",
                    "--name-status",
                    "-z",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    base,
                    "--",
                ],
            ))?;
            let entries: Vec<_> = data.split(|b| *b == 0).filter(|s| !s.is_empty()).collect();
            for pair in entries.chunks_exact(2) {
                let path = std::str::from_utf8(pair[1])
                    .map_err(|_| "Non-UTF-8 file names are not supported")?;
                paths.insert(
                    path.to_owned(),
                    String::from_utf8_lossy(pair[0]).to_string(),
                );
            }
        } else {
            let data = checked(git_at(&self.root, &["ls-files", "-z", "--cached"]))?;
            for path in data.split(|b| *b == 0).filter(|s| !s.is_empty()) {
                paths.insert(
                    std::str::from_utf8(path)
                        .map_err(|_| "Non-UTF-8 filename")?
                        .to_owned(),
                    "A".into(),
                );
            }
        }
        let data = checked(git_at(
            &self.root,
            &["ls-files", "-z", "--others", "--exclude-standard"],
        ))?;
        for path in data.split(|b| *b == 0).filter(|s| !s.is_empty()) {
            paths.insert(
                std::str::from_utf8(path)
                    .map_err(|_| "Non-UTF-8 filename")?
                    .to_owned(),
                "A".into(),
            );
        }
        if paths.len() > MAX_FILES {
            return Err(format!(
                "More than {MAX_FILES} changed files. Narrow the repository before reviewing."
            ));
        }
        let mut stats = BTreeMap::new();
        if let Some(base) = &self.base {
            let data = checked(git_at(
                &self.root,
                &[
                    "diff",
                    "--numstat",
                    "-z",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    base,
                    "--",
                ],
            ))?;
            for entry in data.split(|b| *b == 0).filter(|s| !s.is_empty()) {
                let mut fields = entry.splitn(3, |b| *b == b'\t');
                let add = fields
                    .next()
                    .and_then(|s| std::str::from_utf8(s).ok())
                    .and_then(|s| s.parse::<usize>().ok());
                let del = fields
                    .next()
                    .and_then(|s| std::str::from_utf8(s).ok())
                    .and_then(|s| s.parse::<usize>().ok());
                if let Some(path) = fields.next().and_then(|s| std::str::from_utf8(s).ok()) {
                    stats.insert(path.to_owned(), (add, del));
                }
            }
        }
        Ok(paths.into_iter().map(|(path, status)| {
            // A cheap change token for background checks and viewed flags. Actual
            // comment freshness is still checked against full file contents.
            let metadata = fs::symlink_metadata(self.root.join(&path)).ok();
            let stamp = metadata.as_ref().map(|m| (m.len(), m.modified().ok(), m.permissions().readonly(), m.file_type().is_symlink()));
            #[cfg(unix)]
            let extra = {
                use std::os::unix::fs::MetadataExt;
                metadata.as_ref().map(|m| (m.mode(), m.ctime(), m.ctime_nsec()))
            };
            #[cfg(not(unix))]
            let extra = ();
            let fingerprint = digest(format!("{:?}", (&self.base, &path, &status, stamp, extra)));
            let (add, del) = stats.get(&path).cloned().unwrap_or((None, None));
            json!({"path":path, "status":status, "fingerprint":fingerprint, "add":add, "del":del})
        }).collect())
    }
    fn read_worktree(&self, path: &str) -> Result<Option<Vec<u8>>> {
        valid_path(path)?;
        // Reject symlinks in every path component, not just the file, to avoid reading outside the repo.
        let mut at = self.root.clone();
        for component in Path::new(path).components() {
            at.push(component);
            match fs::symlink_metadata(&at) {
                Ok(m) if m.file_type().is_symlink() => {
                    return Err("Symlinks are not previewed".into())
                }
                Ok(_) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.to_string()),
            }
        }
        let meta = fs::metadata(&at).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Submodules and directories are not previewed".into());
        }
        if meta.len() > MAX_FILE as u64 {
            return Err("File exceeds the 512 KiB review limit".into());
        }
        // Bound the actual read too, in case an agent grows the file after metadata().
        let mut bytes = Vec::new();
        fs::File::open(at)
            .map_err(|e| e.to_string())?
            .take((MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_FILE {
            return Err("File exceeds the 512 KiB review limit".into());
        }
        Ok(Some(bytes))
    }
    fn read_base(&self, path: &str, base: Option<&str>) -> Result<Option<Vec<u8>>> {
        valid_path(path)?;
        let Some(base) = base else { return Ok(None) };
        if base.len() != 40 && base.len() != 64 || !base.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid base commit".into());
        }
        let spec = format!("{base}:{path}");
        let exists = output(git_at(&self.root, &["cat-file", "-e", &spec]))?;
        if !exists.status.success() {
            return Ok(None);
        }
        let kind = git_text(&self.root, &["cat-file", "-t", &spec])?;
        if kind != "blob" {
            return Err("Submodules are not previewed".into());
        }
        let size = git_text(&self.root, &["cat-file", "-s", &spec])?
            .parse::<usize>()
            .map_err(|e| e.to_string())?;
        if size > MAX_FILE {
            return Err("Base file exceeds the 512 KiB review limit".into());
        }
        checked(git_at(&self.root, &["cat-file", "blob", &spec])).map(Some)
    }
    fn snapshot(&self, req: &Request) -> Result<Snapshot> {
        let path = required(&req.path, "path")?;
        if !self.files()?.iter().any(|f| f["path"] == path) {
            return Err(
                "This path is not in the current review scope. Refresh the file list.".into(),
            );
        }
        // The file list and every file opened from it share a resolved base, even if HEAD moves.
        let base = req.base.clone().or_else(|| self.base.clone());
        let old = self.read_base(path, base.as_deref())?;
        let new = self.read_worktree(path)?;
        let old_hash = digest(serde_json::to_vec(&old).unwrap());
        let new_hash = digest(serde_json::to_vec(&new).unwrap());
        let decode = |v: Option<Vec<u8>>| -> Result<String> {
            let bytes = v.unwrap_or_default();
            if bytes.contains(&0) {
                return Err("Binary file — text review is not available".into());
            }
            let s = String::from_utf8(bytes)
                .map_err(|_| "Non-UTF-8 file — text review is not available")?;
            if s.lines().count() > MAX_LINES {
                return Err(format!("File exceeds {MAX_LINES} lines"));
            }
            Ok(s)
        };
        let id = digest(serde_json::to_vec(&(path, &base, &old_hash, &new_hash)).unwrap());
        Ok(Snapshot {
            id,
            path: path.into(),
            base,
            old: decode(old)?,
            new: decode(new)?,
            old_hash,
            new_hash,
        })
    }
    fn stale(&self, s: &Snapshot) -> bool {
        s.base != self.base
            || self
                .read_worktree(&s.path)
                .map(|v| digest(serde_json::to_vec(&v).unwrap()) != s.new_hash)
                .unwrap_or(true)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Snapshot {
    id: String,
    path: String,
    base: Option<String>,
    old: String,
    new: String,
    old_hash: String,
    new_hash: String,
}
impl Snapshot {
    fn source(&self, side: &str) -> Result<&str> {
        match side {
            "old" => Ok(&self.old),
            "new" => Ok(&self.new),
            _ => Err("Side must be old or new".into()),
        }
    }
    fn quote(&self, side: &str, start: usize, end: usize) -> Result<String> {
        let lines: Vec<_> = self.source(side)?.lines().collect();
        if start == 0 || end < start || end > lines.len() || end - start > 49 {
            return Err("Select 1–50 existing lines".into());
        }
        let text = lines[start - 1..end].join("\n");
        if text.len() > 12_000 {
            return Err("Selected lines exceed 12 KiB. Select a smaller range.".into());
        }
        Ok(text)
    }
}

fn handle(req: Request, home: &Path) -> Result<Value> {
    let repo = Repo::open(&req)?;
    let mut store = Store::open(home, &repo)?;
    match req.action.as_str() {
        "scan" => {
            let files = repo.files()?;
            let before = store.viewed.clone();
            store.viewed.retain(|path, token| {
                files
                    .iter()
                    .any(|f| f["path"] == *path && f["fingerprint"] == *token)
            });
            if before != store.viewed {
                store.save_viewed()?;
            }
            Ok(
                json!({"root":repo.root,"scope":repo.scope,"base":repo.base,"base_label":repo.label,"files":files,"comments":store.comments,"viewed":store.viewed}),
            )
        }
        "viewed" => {
            let path = required(&req.path, "path")?;
            valid_path(path)?;
            if req.viewed.ok_or("Missing viewed")? {
                let token = required(&req.fingerprint, "fingerprint")?;
                if !repo
                    .files()?
                    .iter()
                    .any(|f| f["path"] == path && f["fingerprint"] == token)
                {
                    return Err("This file changed before it could be marked viewed".into());
                }
                store.viewed.insert(path.into(), token.into());
            } else {
                store.viewed.remove(path);
            }
            store.save_viewed()?;
            Ok(json!({"viewed":store.viewed}))
        }
        "open" | "snapshot" => {
            let s = if req.action == "snapshot" {
                store.snapshot(required(&req.snapshot, "snapshot")?)?
            } else {
                let s = repo.snapshot(&req)?;
                store.save_snapshot(&s)?;
                s
            };
            let context = req.context.unwrap_or(3);
            if context > MAX_LINES {
                return Err(format!("Context cannot exceed {MAX_LINES} lines"));
            }
            let reveal = diff::context_ranges(&s, req.reveal.unwrap_or_default())?;
            let rendered = diff::render(
                &s,
                req.mode.as_deref().unwrap_or("structural"),
                context,
                &reveal,
            )?;
            let add = rendered.rows.iter().filter(|r| r.kind == "new").count();
            let del = rendered.rows.iter().filter(|r| r.kind == "old").count();
            Ok(
                json!({"snapshot":s.id,"path":s.path,"base":s.base,"stale":repo.stale(&s),"context":context,"reveal":reveal,"add":add,"del":del,"diff":rendered}),
            )
        }
        "comment" => {
            let snapshot = required(&req.snapshot, "snapshot")?;
            let s = store.snapshot(snapshot)?;
            let side = required(&req.side, "side")?;
            let start = req.start.ok_or("Missing start")?;
            let end = req.end.unwrap_or(start);
            let quote = s.quote(side, start, end)?;
            let body = required(&req.body, "body")?.trim();
            if body.is_empty() || body.len() > 4000 {
                return Err("Comments must contain 1–4000 bytes".into());
            }
            let id = req.id.clone().unwrap_or_else(|| store::unique_id(body));
            if req.id.is_some() && !store.comments.iter().any(|c| c.id == id) {
                return Err("Comment no longer exists. Refresh drafts.".into());
            }
            store.comments.retain(|c| c.id != id);
            if store.comments.len() >= 100 {
                return Err("At most 100 draft comments are supported".into());
            }
            store.comments.push(Comment {
                id,
                snapshot: snapshot.into(),
                path: s.path,
                side: side.into(),
                start,
                end,
                body: body.into(),
                quote,
            });
            store.save()?;
            Ok(json!({"comments":store.comments}))
        }
        "delete" => {
            let id = required(&req.id, "id")?;
            store.comments.retain(|c| c.id != id);
            store.save()?;
            Ok(json!({"comments":store.comments}))
        }
        "prepare" => store.prepare(&repo),
        "sent" => store.sent(required(&req.review_id, "review_id")?),
        _ => Err("Unknown action".into()),
    }
}

fn main() {
    let result = (|| -> Result<Value> {
        let mut args = std::env::args().skip(1);
        if args.next().as_deref() != Some("--store") {
            return Err("Usage: herdr-review --store /private/data/path '<JSON request>'".into());
        }
        let home = PathBuf::from(args.next().ok_or("Missing store path")?);
        let data = args.next().ok_or("Missing JSON request")?;
        if data.len() > 64 * 1024 || args.next().is_some() {
            return Err("Request exceeds 64 KiB or has extra arguments".into());
        }
        let req = serde_json::from_str(&data).map_err(|e| format!("Invalid request: {e}"))?;
        handle(req, &home)
    })();
    match result {
        Ok(value) => println!("{}", json!({"ok":true,"data":value})),
        Err(error) => {
            println!("{}", json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests;
