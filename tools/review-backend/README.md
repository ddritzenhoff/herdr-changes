# Agent Review

A review-only Herdr tab inspired by GitHub's **Files changed** view. Rust owns
read-only Git access, Difftastic, immutable snapshots, persistent comments,
viewed flags and review-message assembly. `../../mods/review/` supplies the
native GPUI interface; `../../mods/review-tabs/` launches and reuses review tabs.
No web view, model call or network request is made by the reviewer at runtime.
No GitHub source code, logos or assets are used.

## Build / restore

Requires Git, Rust/Cargo, Herdr/herdr-core, and Difftastic **0.72.0**. On macOS:

```sh
brew install difftastic
sh ~/.config/herdr-app/tools/review-backend/build.sh
herdr-app check ~/.config/herdr-app/mods/review
herdr-app check ~/.config/herdr-app/mods/review-tabs
```

Configure your personal layout as described in the repository's root README.
Its tab bar should use the `review-tabs` clone, which preserves Herdr's tab
controls and listens for `review-tabs.open`. Merge the Cmd+Shift+R binding from
`keys.json`; unmodified shipped layouts do not contain this launcher.

Dependencies are locked in `Cargo.lock`; `target/` is ignored. Difftastic's JSON
format is unstable, so the adapter accepts only 0.72.0. A missing/other version,
parse failure or 12-second timeout falls back to Git text diff, with a note.
`HERDR_REVIEW_DIFFT` can override the executable; Herdr must inherit the variable.
Git's global diff configuration is never changed.

## Open a review

Focus the agent terminal and press **Cmd+Shift+R**. A **Review** tab opens directly
to its right. Pressing the shortcut again returns to that tab, rather than
creating another. Closing it does not stop the agent. The launcher uses the
agent's foreground-process directory, not the shell's last reported directory,
and pins that directory and recipient when opening the review.

The launcher creates the tab through the current app's CLI to obtain its actual
ID, then places/registers it. This avoids guessing from transient keyboard focus
while a new mod pane initializes. Registration is runtime shared state and is
pruned when tabs close. No comments or code are stored in that registry.

The review shows **HEAD → current working tree**, including staged/unstaged
changes combined and untracked files. It is not limited to changes made by one
agent. There is no repository toolbar, branch/scope picker, refresh button,
view-mode selector, Comments sidebar tab, or permanent comment composer.

## Review and comment

- The left panel contains the changed-file tree. Drag its right-hand divider to
  resize it (normally 180–600 px; fitted narrower when the Review pane is small).
  The sidebar icon beside **Files changed** collapses it to a narrow restore-button
  rail; click that icon again to restore the last expanded width. Both width and
  collapsed state are saved in Herdr's local shared preferences across Review
  tabs, repositories and app restarts. No repository code or drafts are stored
  in this appearance preference. `review.toggle-files` also toggles the tree.
- Collapse folders or click a file to expand its card and align its header to
  the top of the single scrolling review page, including short final files.
  The selected card has a continuous blue outline around its header, diff and
  inline comments; it persists while scrolling until another file is selected.
  Resizing/collapsing the tree never discards an open comment.
- Click a line number or code line to give it a persistent blue outline.
  This visual selection is independent of the current comment editor's anchor.
  Native hover reveals a filled blue **+**, even while another line is selected.
- Comment/editor cards are inset below the code, capped at 760 px and aligned
  with their old/new split lane (spanning narrow layouts when needed).
- Cards load their diffs as they become visible. **Modified files are split**;
  **new files are unified**; deleted files have a single old-code column. Lines
  wrap to the available width. Difftastic aligns existing code and highlights
  changed tokens; formatting differences remain visible too.
- Hover a code line to reveal the blue **+** in its gutter. Click it to open a
  textarea in an inset card beneath that line. Click the other side's + to
  anchor a comment to removed code.
- **Shift-click lines or another +** for a range on the same file, snapshot and
  side (up to 50 lines). Clicking code text only outlines the line; it never
  relocates an open comment. Click + inside an outlined range to comment on it.
- **Add comment** saves a local draft; it does not send anything. Drafts display
  inline with **Edit** and **Delete**. The editor disappears after saving.
- A file's **Viewed** checkbox records review progress and collapses its card.
  Its viewed flag resets when the file/base change token changes. Viewed is
  unrelated to staging or committing. Checkboxes update optimistically per file,
  never pulse/dim the whole page, and roll back that file only if saving fails.
  Pending/deferred manifests preserve these local updates.
- **Context expansion** uses gutter arrows beside each hidden range. The top
  arrow reveals earlier lines, the bottom arrow reveals later lines, and stacked
  down/up arrows between hunks expand from either end. Each click reveals up to
  ten unchanged lines from that frozen snapshot, without expanding other gaps or
  jumping to the file header. Meeting hunks join, and arrows disappear at file
  boundaries. Expanded lines support the usual selection and comments; newer
  agent edits cannot leak into an old review.
- File-tree navigation/scrolling preserves open comment text. Save or Cancel
  before opening a different comment, collapsing its file or sending feedback.

The whole page uses one virtual list of freshly painted native elements. Row
controls use a single list-owned handler with stable keys and fixed hit zones;
comment/editor action strips are separate rows and share their card's hit bounds.
No cached elements or nested JavaScript view entities are mounted in deferred rows: in Herdr 0.1.13 those
mounts can be released offscreen, producing a blank pane on scrolling. The
native textarea's **state**, not its row view, stays alive while offscreen.

Visible-file demand is drained outside layout every 120 ms, with one backend
request at a time and at most three queued files. This scheduler does not redraw
an idle page or load diffs in hidden tabs. Wrapped/tokenized source rows are
cached per file response, width and context. Unchanged manifest checks do not
rebuild the page, and ordinary typing only repaints the native textarea.

## Background changes and saved drafts

A cheap manifest is checked every 15 seconds while this review tab/window is
active. There is no redraw/animation timer. Previously visible changed files
reload lazily. Viewed flags are tied to a metadata/base change token; comment
freshness is checked against the actual captured file contents.

**An open editor or send preview freezes the current page.** New manifests and
in-flight diff results wait until editing/preview finishes. A warning indicates
when the selected file changed; new code never silently moves a comment anchor.

Every comment retains the file path, old/new side, line range, original quote,
base commit and SHA-256 snapshot ID. If a current file now has another snapshot,
its old comments appear below the diff as **outdated**, with their quoted code.
Comments whose files are no longer changed remain recoverable in clearly marked
outdated-draft cards, not in the changed-file tree. Editing a draft updates its
body against the original snapshot. It does not relocate its anchor.

Saved drafts survive reloads/restarts, independently of the review tab. Unsaved
textarea text survives scrolling/navigation, but not closing/reloading the mod;
save it before closing. Sent batches are archived locally. Snapshots/archives
are not automatically pruned.

## Send feedback

**Review & send (N)** opens the exact outgoing message, sorted by file and line,
with original code quotes and outdated warnings. The recipient is the agent
that opened the review, not whichever agent is focused later. There is no
recipient selector or new-agent launcher.

**Send feedback** is enabled only while that agent exists and is not working or
blocked. A final `hc send --if idle` guards status races; nothing is force-sent.
Successful transport means paste + Enter, not an acknowledgement from the model.
Check the agent transcript, particularly for large messages.

Failure retains drafts. Success archives and removes only the exact comment
versions sent, preserving concurrent edits/new comments from other review tabs.
If archiving fails after sending, only **retry archive** is offered in the current
preview, preventing an accidental duplicate send. A crash during transport and
archiving is not transactional; check the agent before retrying after a crash.

## Privacy / limitations

Private code, drafts, viewed flags and archives live in Git-ignored
`~/.config/herdr-app/data/review/`, in repository/scope-hashed directories (0700).
Writes are atomic; each store is exclusively locked during a backend request.
Corrupt drafts/viewed state is reported, not silently overwritten. Nothing is
uploaded by the reviewer. Only explicit Send passes the message to an agent.
Remove `data/review/` when no review is running to clear all private review data.

- Local repositories and existing Herdr agents only. The macOS/Linux launcher
  uses `env` plus the local `herdr-app` CLI; Windows launching is not tested.
- No commits, staging, discard, patch application, GitHub API or PR operations.
- No file/hunk comments, threaded replies, automatic comment relocation, or
  queued delivery to busy agents yet.
- Binaries, non-UTF-8 files, symlinks and directories/submodules are listed but
  cannot be text-reviewed. Renames are delete/add. Empty/mode-only files show an
  explanatory card. Unchanged code does not have full syntax highlighting.
- 1,000 changed files; 512 KiB / 12,000 lines per file; 50 lines / 12 KiB per
  comment selection; 4,000 bytes per comment; 100 drafts; 48 KiB per sent batch.
  Display clips individual lines after 4,000 characters; original quotes remain.
- Captures are per-file, not a repository-wide transaction while agents write.
  A file can change between preview and delivery; original quotes remain intact.
- Replacing the review tab bar with another mod removes the keyboard launcher.

## Validate

```sh
cd ~/.config/herdr-app/tools/review-backend
cargo fmt --check
cargo test --locked -- --include-ignored # includes real Difftastic 0.72.0
cargo clippy --locked --all-targets -- -D warnings
node --test ~/.config/herdr-app/tests/review*.test.mjs
herdr-app check ~/.config/herdr-app/mods/review
herdr-app check ~/.config/herdr-app/mods/review-tabs
herdr-app status
```

Directional-context tests cover both Git text and real Difftastic alignment,
inserted-line offsets, repeated expansion/hunk joining, file boundaries, immutable
snapshots and comments on revealed code. UI tests cover arrow hit zones, failure
recovery and preserving open editors. File-pane tests cover persisted width and
collapse state, reopened/existing Review copies, invalid preferences, narrow
viewports, native geometry resets, and preserving unsaved comments.

Tests use temporary repositories and mocked agent transport. Native integration
checks exercise stacked cards, scrolling large diffs offscreen/back, inline editor/save, and adjacent-tab
creation/reuse; they never send review text to a real agent. `review.submit`
opens the preview from scripts while the mod is visible; it never sends by itself.
