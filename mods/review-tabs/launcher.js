import { agents, focused, terminals, spaces, shared, setShared, run, notify, nextCommand, exec, appHome } from "herdr";

export async function openReview() {
  const focus = focused(), all = spaces(), liveTabs = new Set(all.flatMap(s => s.tabs.map(t => t.id)));
  const stored = shared("review.tabs") ?? {};
  const registry = Object.fromEntries(Object.entries(stored).filter(([, v]) => liveTabs.has(v.tab)));
  if (Object.keys(registry).length !== Object.keys(stored).length) setShared("review.tabs", registry);
  const current = Object.values(registry).find(r => r.tab === focus?.tab);
  const agent = agents().find(a => a.address === (focus?.shown || focus?.terminal));
  if (!agent) {
    if (current) return; // Already in this agent's review, not a request for another tab.
    notify({ title: "Review changes", body: "Focus the agent terminal whose changes you want to review, then press Cmd+Shift+R.", level: "info" });
    return;
  }
  if (agent.address.includes("/")) {
    notify({ title: "Review changes", body: "The reviewer currently supports local agents and repositories only.", level: "info" });
    return;
  }
  const terminal = terminals().find(t => t.address === agent.address);
  // The foreground process's cwd is the agent's actual launch directory, not
  // the shell's last OSC directory or whichever terminal happens to be focused later.
  const root = terminal?.foreground?.cwd || terminal?.cwd;
  if (!root) {
    notify({ title: "Review changes", body: "The agent's working directory is not available yet.", level: "info" });
    return;
  }
  const key = `${agent.space}:${agent.address}`, existing = registry[key];
  if (existing && existing.launchRoot === root) {
    const tabs = all.find(s => s.id === agent.space)?.tabs.filter(t => t.id !== existing.tab) ?? [];
    const parent = tabs.findIndex(t => t.id === agent.tab);
    if (parent >= 0) run("tab.move", { id: existing.tab, index: parent + 2 });
    run("tab.select", { id: existing.tab });
    return;
  }
  // run() does not return created IDs. Ask the current app's CLI once so tab
  // registration and placement never depend on which tab has focus during init.
  const args = { name: "Review", space: agent.space, mod: "review", props: {
    root, agent: agent.address, agentName: agent.program.name, space: agent.space, agentTab: agent.tab, launchRoot: root,
  } };
  const result = await exec("env", [`HERDR_APP_HOME=${appHome()}`, "herdr-app", "do", "tab.new", JSON.stringify(args)]);
  let made;
  try { made = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || "Could not open the review tab"); }
  if (result.code !== 0 || typeof made.tab !== "string") throw new Error(made.error || result.stderr || "Could not open the review tab");
  setShared("review.tabs", { ...(shared("review.tabs") || {}), [key]: { tab: made.tab, launchRoot: root } });
  const tabs = spaces().find(s => s.id === agent.space)?.tabs.filter(t => t.id !== made.tab) || [];
  const parent = tabs.findIndex(t => t.id === agent.tab);
  if (parent >= 0) run("tab.move", { id: made.tab, index: parent + 2 });
}

export function listenForReviews(cx) {
  cx.spawn(async cx => {
    let until = 0;
    for (;;) {
      const command = await nextCommand();
      if (command === "open" && Date.now() >= until) {
        until = Date.now() + 750;
        try { await openReview(); }
        catch (e) { notify({ title: "Could not open review", body: String(e.message || e), level: "error" }); }
      }
    }
  });
}
