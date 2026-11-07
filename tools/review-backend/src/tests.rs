use super::*;

struct Fixture {
    repo: tempfile::TempDir,
    data: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let f = Self {
            repo: tempfile::tempdir().unwrap(),
            data: tempfile::tempdir().unwrap(),
        };
        f.git(&["init", "-b", "main"]);
        f.git(&["config", "user.email", "test@example.invalid"]);
        f.git(&["config", "user.name", "Review Test"]);
        fs::write(
            f.repo.path().join("main.rs"),
            "fn main() {\n    let café = 1;\n}\n",
        )
        .unwrap();
        f.git(&["add", "--all"]);
        f.git(&["commit", "-m", "base"]);
        f
    }
    fn git(&self, args: &[&str]) -> String {
        git_text(self.repo.path(), args).unwrap()
    }
    fn run(&self, mut v: Value) -> Result<Value> {
        v["cwd"] = json!(self.repo.path());
        handle(serde_json::from_value(v).unwrap(), self.data.path())
    }
    fn edit(&self) {
        fs::write(
            self.repo.path().join("main.rs"),
            "fn main() {\n    let café = 2;\n}\n",
        )
        .unwrap();
    }
    fn open(&self) -> Value {
        self.run(json!({"action":"open","path":"main.rs","mode":"text"}))
            .unwrap()
    }
    fn comment(&self, snapshot: &Value, body: &str) -> Value {
        self.run(json!({"action":"comment","snapshot":snapshot["snapshot"],"side":"new","start":2,"body":body})).unwrap()
    }
}

#[test]
fn captures_unicode_snapshot_and_restarts_with_saved_drafts() {
    let f = Fixture::new();
    f.edit();
    let open = f.open();
    assert_eq!(open["diff"]["engine"], "Git text diff");
    let saved = f.comment(&open, "Please explain this value.");
    assert!(saved["comments"][0]["quote"]
        .as_str()
        .unwrap()
        .contains("café = 2"));
    let scan = f.run(json!({"action":"scan"})).unwrap();
    assert_eq!(scan["comments"], saved["comments"]);
    assert_eq!(scan["files"][0]["path"], "main.rs");
}
#[test]
fn flags_concurrent_edits_and_keeps_frozen_quote() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    f.comment(&s, "Use a constant.");
    fs::write(f.repo.path().join("main.rs"), "// entirely replaced\n").unwrap();
    let preview = f.run(json!({"action":"prepare"})).unwrap();
    assert_eq!(preview["stale_count"], 1);
    assert!(preview["text"].as_str().unwrap().contains("café = 2"));
    assert!(preview["text"].as_str().unwrap().contains("OUTDATED"));
    let old = f
        .run(json!({"action":"snapshot","snapshot":s["snapshot"],"mode":"text"}))
        .unwrap();
    assert_eq!(old["stale"], true);
}
#[test]
fn acknowledges_only_exact_comment_versions_and_keeps_archive() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    let saved = f.comment(&s, "First.");
    let prepared = f.run(json!({"action":"prepare"})).unwrap();
    f.run(json!({"action":"comment","snapshot":s["snapshot"],"side":"new","start":2,"body":"Edited after preview.","id":saved["comments"][0]["id"]})).unwrap();
    let ack = f
        .run(json!({"action":"sent","review_id":prepared["review_id"]}))
        .unwrap();
    assert_eq!(ack["comments"].as_array().unwrap().len(), 1);
    assert_eq!(ack["comments"][0]["body"], "Edited after preview.");
    let next = f.run(json!({"action":"prepare"})).unwrap();
    let ack = f
        .run(json!({"action":"sent","review_id":next["review_id"]}))
        .unwrap();
    assert!(ack["comments"].as_array().unwrap().is_empty());
    let dir = fs::read_dir(f.data.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(fs::read_dir(dir).unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("sent-")));
}
#[test]
fn preview_does_not_clear_drafts_or_send_anything() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    f.comment(&s, "Review only.");
    f.run(json!({"action":"prepare"})).unwrap();
    assert_eq!(
        f.run(json!({"action":"scan"})).unwrap()["comments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn branch_scope_includes_committed_and_untracked_changes() {
    let f = Fixture::new();
    f.git(&["checkout", "-b", "feature"]);
    f.edit();
    f.git(&["commit", "-am", "change"]);
    fs::write(f.repo.path().join("new file\twith tabs.rs"), "new\n").unwrap();
    let working = f.run(json!({"action":"scan"})).unwrap();
    assert_eq!(working["files"].as_array().unwrap().len(), 1);
    let branch = f.run(json!({"action":"scan","scope":"branch"})).unwrap();
    assert_eq!(branch["files"].as_array().unwrap().len(), 2);
    assert!(branch["base_label"].as_str().unwrap().contains("main"));
}
#[test]
fn newborn_repository_is_supported() {
    let f = Fixture {
        repo: tempfile::tempdir().unwrap(),
        data: tempfile::tempdir().unwrap(),
    };
    f.git(&["init", "-b", "main"]);
    fs::write(f.repo.path().join("first.rs"), "fn main() {}\n").unwrap();
    let scan = f.run(json!({"action":"scan"})).unwrap();
    assert!(scan["base"].is_null());
    let s = f
        .run(json!({"action":"open","path":"first.rs","mode":"text"}))
        .unwrap();
    assert!(s["diff"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "new"));
}
#[test]
fn comments_on_deleted_lines_use_old_side() {
    let f = Fixture::new();
    fs::remove_file(f.repo.path().join("main.rs")).unwrap();
    let s = f.open();
    let saved = f.run(json!({"action":"comment","snapshot":s["snapshot"],"side":"old","start":1,"end":3,"body":"Why remove this?"})).unwrap();
    assert_eq!(saved["comments"][0]["side"], "old");
    assert!(f.run(json!({"action":"prepare"})).unwrap()["text"]
        .as_str()
        .unwrap()
        .contains("old lines 1–3"));
}
#[test]
fn rejects_bad_ranges_paths_ids_and_unknown_fields() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    for (start, end) in [(0, 1), (3, 1), (1, 100)] {
        assert!(f.run(json!({"action":"comment","snapshot":s["snapshot"],"side":"new","start":start,"end":end,"body":"x"})).is_err());
    }
    assert!(valid_path("../outside").is_err());
    assert!(valid_path("/etc/passwd").is_err());
    assert!(f
        .run(json!({"action":"snapshot","snapshot":"../../bad"}))
        .is_err());
    assert!(
        serde_json::from_value::<Request>(json!({"action":"scan","cwd":"/","oops":true})).is_err()
    );
}
#[cfg(unix)]
#[test]
fn refuses_symlink_and_symlink_parent() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let external = tempfile::tempdir().unwrap();
    fs::write(external.path().join("secret"), "private").unwrap();
    symlink(external.path().join("secret"), f.repo.path().join("link")).unwrap();
    assert!(f
        .run(json!({"action":"open","path":"link","mode":"text"}))
        .unwrap_err()
        .contains("Symlinks"));
    symlink(external.path(), f.repo.path().join("dir")).unwrap();
    let req: Request =
        serde_json::from_value(json!({"action":"scan","cwd":f.repo.path()})).unwrap();
    assert!(Repo::open(&req)
        .unwrap()
        .read_worktree("dir/secret")
        .is_err());
}
#[test]
fn binary_and_large_files_fail_without_losing_drafts() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    f.comment(&s, "Keep me.");
    fs::write(f.repo.path().join("binary"), [1, 0, 2]).unwrap();
    assert!(f
        .run(json!({"action":"open","path":"binary","mode":"text"}))
        .unwrap_err()
        .contains("Binary"));
    fs::write(f.repo.path().join("large"), vec![b'x'; MAX_FILE + 1]).unwrap();
    assert!(f
        .run(json!({"action":"open","path":"large","mode":"text"}))
        .unwrap_err()
        .contains("512 KiB"));
    assert_eq!(
        f.run(json!({"action":"scan"})).unwrap()["comments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn changes_to_head_mark_comments_outdated() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    f.comment(&s, "Check this.");
    f.git(&["commit", "-am", "new head"]);
    assert_eq!(
        f.run(json!({"action":"prepare"})).unwrap()["stale_count"],
        1
    );
}
#[test]
fn comments_are_separate_per_scope_and_repo() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    f.comment(&s, "Working tree.");
    assert!(
        f.run(json!({"action":"scan","scope":"branch"})).unwrap()["comments"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let other = Fixture::new();
    let req = serde_json::from_value(json!({"action":"scan","cwd":other.repo.path()})).unwrap();
    assert!(handle(req, f.data.path()).unwrap()["comments"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn mode_only_change_does_not_invent_lines() {
    let f = Fixture::new();
    f.git(&["update-index", "--chmod=+x", "main.rs"]);
    let s = f.open();
    assert!(s["diff"]["rows"].as_array().unwrap().is_empty());
}
#[test]
fn patch_metacharacters_are_literal_paths() {
    let f = Fixture::new();
    let path = ":(glob)*.rs";
    fs::write(f.repo.path().join(path), "literal\n").unwrap();
    let s = f
        .run(json!({"action":"open","path":path,"mode":"text"}))
        .unwrap();
    assert_eq!(s["path"], path);
}
#[test]
fn git_external_diff_is_never_executed() {
    let f = Fixture::new();
    f.git(&[
        "config",
        "diff.external",
        "/this-program-must-not-be-executed",
    ]);
    f.edit();
    let s = f.open();
    assert_eq!(s["diff"]["engine"], "Git text diff");
}

#[test]
fn corrupt_drafts_are_preserved_and_store_requests_are_exclusive() {
    let f = Fixture::new();
    let req: Request =
        serde_json::from_value(json!({"action":"scan","cwd":f.repo.path()})).unwrap();
    let repo = Repo::open(&req).unwrap();
    let lock = Store::open(f.data.path(), &repo).unwrap();
    assert!(f
        .run(json!({"action":"scan"}))
        .unwrap_err()
        .contains("Another reviewer request"));
    drop(lock);
    let dir = fs::read_dir(f.data.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(dir.join("drafts.json"), "not valid JSON").unwrap();
    assert!(f
        .run(json!({"action":"scan"}))
        .unwrap_err()
        .contains("preserving"));
    assert_eq!(
        fs::read_to_string(dir.join("drafts.json")).unwrap(),
        "not valid JSON"
    );
}

#[test]
fn viewed_flags_persist_but_reset_when_file_or_head_changes() {
    let f = Fixture::new();
    f.edit();
    let scan = f.run(json!({"action":"scan"})).unwrap();
    let token = &scan["files"][0]["fingerprint"];
    f.run(json!({"action":"viewed","path":"main.rs","fingerprint":token,"viewed":true}))
        .unwrap();
    assert_eq!(
        f.run(json!({"action":"scan"})).unwrap()["viewed"]["main.rs"],
        *token
    );
    fs::write(f.repo.path().join("main.rs"), "// agent edited it again\n").unwrap();
    assert!(f.run(json!({"action":"scan"})).unwrap()["viewed"]
        .as_object()
        .unwrap()
        .is_empty());
    assert!(f
        .run(json!({"action":"viewed","path":"main.rs","fingerprint":token,"viewed":true}))
        .is_err());
}

#[test]
fn expanding_context_reopens_the_same_frozen_snapshot() {
    let f = Fixture::new();
    let old = (1..=60)
        .map(|i| format!("let value_{i} = {i};\n"))
        .collect::<String>();
    fs::write(f.repo.path().join("main.rs"), &old).unwrap();
    f.git(&["commit", "-am", "long base"]);
    fs::write(
        f.repo.path().join("main.rs"),
        old.replace("value_30 = 30", "value_30 = 999"),
    )
    .unwrap();
    let s = f.open();
    fs::write(
        f.repo.path().join("main.rs"),
        "// subsequent changes must not leak into this snapshot\n",
    )
    .unwrap();
    let expanded = f
        .run(json!({"action":"snapshot","snapshot":s["snapshot"],"mode":"text","context":13}))
        .unwrap();
    assert_eq!(expanded["snapshot"], s["snapshot"]);
    assert!(
        expanded["diff"]["rows"].as_array().unwrap().len()
            > s["diff"]["rows"].as_array().unwrap().len()
    );
    assert_eq!(expanded["stale"], true);
    assert!(!expanded.to_string().contains("subsequent changes"));
    assert!(f
        .run(json!({"action":"snapshot","snapshot":s["snapshot"],"context":12001}))
        .is_err());
}

#[test]
fn manifest_has_text_stats_and_literal_paths_for_all_uncommitted_files() {
    let f = Fixture::new();
    f.edit();
    fs::write(f.repo.path().join("untracked.rs"), "// new\n").unwrap();
    let scan = f.run(json!({"action":"scan"})).unwrap();
    let files = scan["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    let modified = files.iter().find(|v| v["path"] == "main.rs").unwrap();
    assert_eq!(modified["add"], 1);
    assert_eq!(modified["del"], 1);
    assert_eq!(modified["fingerprint"].as_str().unwrap().len(), 64);
}

fn directional_context_expansion(mode: &str) {
    let f = Fixture::new();
    let old = (1..=100)
        .map(|i| format!("fn value_{i}() -> usize {{ {i} }}\n"))
        .collect::<String>();
    fs::write(f.repo.path().join("main.rs"), &old).unwrap();
    f.git(&["commit", "-am", "context base"]);
    let new = old
        .replace(
            "fn value_20() -> usize { 20 }",
            "fn value_20() -> usize { 999 }\nfn inserted() -> usize { 42 }",
        )
        .replace(
            "fn value_70() -> usize { 70 }",
            "fn value_70() -> usize { 888 }",
        );
    fs::write(f.repo.path().join("main.rs"), &new).unwrap();
    let mut data = f
        .run(json!({"action":"open","path":"main.rs","mode":mode}))
        .unwrap();
    if mode == "structural" {
        assert_eq!(data["diff"]["engine"], "Difftastic 0.72.0");
    }
    let gaps = |v: &Value| {
        v["diff"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r.get("gap").cloned())
            .collect::<Vec<_>>()
    };
    let numbers = |v: &Value, side: &str| {
        v["diff"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|r| r[side].as_u64())
            .collect::<Vec<_>>()
    };
    let original = gaps(&data);
    assert_eq!(original.len(), 3, "{}", data["diff"]);
    assert_eq!(
        (
            original[0]["before"].as_bool(),
            original[0]["after"].as_bool()
        ),
        (Some(false), Some(true))
    );
    assert_eq!(
        (
            original[1]["before"].as_bool(),
            original[1]["after"].as_bool()
        ),
        (Some(true), Some(true))
    );
    assert_eq!(
        (
            original[2]["before"].as_bool(),
            original[2]["after"].as_bool()
        ),
        (Some(true), Some(false))
    );
    // A line inserted by the first change offsets the next gap's coordinates.
    assert_eq!(
        original[1]["new_start"].as_u64().unwrap(),
        original[1]["old_start"].as_u64().unwrap() + 1
    );
    let snapshot = data["snapshot"].clone();
    let stats = (data["add"].clone(), data["del"].clone());
    fs::write(
        f.repo.path().join("main.rs"),
        "// live edits must not appear\n",
    )
    .unwrap();
    for (gap, up) in [
        (&original[0], true),
        (&original[1], false),
        (&original[1], true),
        (&original[2], false),
    ] {
        let offset = if up {
            gap["count"].as_u64().unwrap() - 10
        } else {
            0
        };
        let range = json!({"old_start":gap["old_start"].as_u64().unwrap()+offset,"new_start":gap["new_start"].as_u64().unwrap()+offset,"count":10});
        let mut reveal = data["reveal"].as_array().unwrap().clone();
        reveal.push(range);
        let before = numbers(&data, "new_number").len();
        data = f
            .run(json!({"action":"snapshot","snapshot":snapshot,"mode":mode,"reveal":reveal}))
            .unwrap();
        assert_eq!(data["snapshot"], snapshot);
        assert_eq!((data["add"].clone(), data["del"].clone()), stats);
        assert_eq!(
            numbers(&data, "new_number").len(),
            before + 10,
            "only the requested ten lines appear"
        );
        assert_eq!(data["stale"], true);
        assert!(!data.to_string().contains("live edits must not appear"));
    }
    // Meeting expansions join hunks with no duplicate lines or leftover controls.
    let mut reveal = data["reveal"].as_array().unwrap().clone();
    for gap in gaps(&data) {
        reveal.push(
            json!({"old_start":gap["old_start"],"new_start":gap["new_start"],"count":gap["count"]}),
        );
    }
    data = f
        .run(json!({"action":"snapshot","snapshot":snapshot,"mode":mode,"reveal":reveal}))
        .unwrap();
    assert!(gaps(&data).is_empty());
    assert_eq!(
        numbers(&data, "old_number"),
        (1..=100).collect::<Vec<u64>>()
    );
    assert_eq!(
        numbers(&data, "new_number"),
        (1..=101).collect::<Vec<u64>>()
    );
    assert!(
        data["reveal"].as_array().unwrap().len() <= 3,
        "adjacent reveal intervals are merged"
    );
    let comment = f.run(json!({"action":"comment","snapshot":snapshot,"side":"new","start":101,"body":"Comment on expanded code"})).unwrap();
    assert_eq!(
        comment["comments"][0]["quote"],
        "fn value_100() -> usize { 100 }"
    );
}

#[test]
fn text_context_expands_each_gap_end_independently() {
    directional_context_expansion("text");
}

#[test]
#[ignore = "requires Difftastic 0.72.0 on PATH"]
fn structural_context_expands_each_gap_end_independently() {
    directional_context_expansion("structural");
}

#[test]
fn context_ranges_reject_invalid_or_overflowing_coordinates() {
    let f = Fixture::new();
    f.edit();
    let s = f.open();
    for range in [
        json!({"old_start":0,"new_start":1,"count":1}),
        json!({"old_start":1,"new_start":0,"count":1}),
        json!({"old_start":1,"new_start":1,"count":0}),
        json!({"old_start":1,"new_start":1,"count":4}),
        json!({"old_start":usize::MAX,"new_start":1,"count":2}),
    ] {
        assert!(f
            .run(json!({"action":"snapshot","snapshot":s["snapshot"],"reveal":[range]}))
            .is_err());
    }
}

#[test]
fn file_boundaries_and_newline_annotations_do_not_invent_context_controls() {
    let f = Fixture::new();
    fs::write(f.repo.path().join("main.rs"), "one\ntwo\nthree\n").unwrap();
    f.git(&["commit", "-am", "short base"]);
    fs::write(f.repo.path().join("main.rs"), "ONE\ntwo\nTHREE").unwrap();
    let s = f.open();
    let rows = s["diff"]["rows"].as_array().unwrap();
    assert!(!rows.iter().any(|r| r.get("gap").is_some()));
    assert!(rows
        .iter()
        .any(|r| r["text"] == "\\ No newline at end of file"));
}

#[test]
#[ignore = "requires Difftastic 0.72.0 on PATH"]
fn real_difftastic_structural_adapter() {
    let f = Fixture::new();
    f.edit();
    let s = f
        .run(json!({"action":"open","path":"main.rs","mode":"structural"}))
        .unwrap();
    assert_eq!(s["diff"]["engine"], "Difftastic 0.72.0", "{}", s["diff"]);
    assert!(s["diff"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| !r["spans"].as_array().unwrap().is_empty()));
}
