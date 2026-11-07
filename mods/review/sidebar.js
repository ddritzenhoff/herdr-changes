// Appearance only: these preferences are shared by Review copies and persisted
// by Herdr, independently of repository snapshots, drafts, or terminal state.
export const filePaneKey = "review.filePane";
export const filePaneDefaults = { width: 240, collapsed: false };
export function filePanePreferences(value) {
  return {
    width: typeof value?.width === "number" && Number.isFinite(value.width)
      ? Math.max(180, Math.min(600, Math.round(value.width))) : filePaneDefaults.width,
    collapsed: value?.collapsed === true,
  };
}

// Fit a small Review pane without overwriting the user's preferred width. The
// native divider owns dragging and calls on_resize only when a drag finishes.
export function filePaneBounds(available) {
  const total = Number.isFinite(available) ? Math.max(0, available) : Infinity;
  const contentMin = Math.min(260, total / 2);
  const max = Math.max(0, Math.min(600, total - contentMin - 1));
  return { min: Math.min(180, max), max, contentMin };
}
