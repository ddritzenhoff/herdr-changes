// GitHub-style review colors, local to this mod. No GitHub assets or branding.
export function desktopColors(dark = true) {
  const shared = { accent: "#1f6feb", primaryHover: "#388bfd" };
  return dark ? { ...shared,
    background: "#0d1117", sidebar: "#0d1117", raised: "#161b22", input: "#0d1117", canvas: "#010409",
    border: "#30363d", controlBorder: "#484f58", foreground: "#e6edf3", muted: "#9198a1", dim: "#9198a1",
    selected: "#1c2d41", hover: "#161b22", selection: "#17345a", hunk: "#121d2f", empty: "#161b22",
    diffAdd: "#12261e", diffDel: "#2d161b", tokenAdd: "#1f6334", tokenDel: "#8c3339",
    comment: "#161b22", commentBorder: "#30363d", blocked: "#d29922",
    ansi1: "#ff7b72", ansi2: "#7ee787", ansi3: "#ffa657", ansi4: "#79c0ff", ansi5: "#d2a8ff", ansi6: "#a5d6ff",
  } : { ...shared,
    background: "#ffffff", sidebar: "#ffffff", raised: "#f6f8fa", input: "#ffffff", canvas: "#ffffff",
    border: "#d1d9e0", controlBorder: "#b7bfc8", foreground: "#1f2328", muted: "#59636e", dim: "#59636e",
    selected: "#ddf4ff", hover: "#f6f8fa", selection: "#dbe9ff", hunk: "#f1f8ff", empty: "#f6f8fa",
    diffAdd: "#dafbe1", diffDel: "#ffebe9", tokenAdd: "#acf2bd", tokenDel: "#fdb8c0",
    comment: "#ffffff", commentBorder: "#d1d9e0", blocked: "#9a6700",
    ansi1: "#cf222e", ansi2: "#1a7f37", ansi3: "#953800", ansi4: "#0550ae", ansi5: "#8250df", ansi6: "#0a3069",
  };
}
