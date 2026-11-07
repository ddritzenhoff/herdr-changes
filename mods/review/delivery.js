// Transport only. A successful return means paste + Enter, not model acknowledgement.
export async function submitToIdleAgent(hc, address, text) {
  if (!address || !text) throw new Error("Choose an agent and prepare a review first.");
  const result = await hc(["send", "--if", "idle", "--json", address, text]);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || "Send failed; drafts retained.");
}
