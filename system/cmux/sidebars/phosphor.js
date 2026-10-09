// phosphor — Ops Board sidebar for cmux (Tier 1).
// Canonical copy: <repo>/system/cmux/sidebars/phosphor.js (scripts/cmux-tier1-install.mjs
// renders the brand token from the registry and installs it to ~/.config/cmux/sidebars/)
// Installed to:   ~/.config/cmux/sidebars/phosphor.js  (scripts/cmux-tier1-install.mjs)
//
// Green-on-black, CVD-safe (every state is glyph + label, never color alone),
// no gradients, no gray shadows. Binds ONLY to cmux state: the sidebar runtime
// has no network, so board JSON (fleet ok/warn/down) is not reachable here —
// that lives in the Dock's board panel. Mesh state arrives through what the
// board writes into cmux (Tier 2): workspace color (domain), description
// (DOMAIN · owns) and the progress bar, whose label carries the task state
// ("#4 WORKING · 1/4") because status pills are not exposed to sidebars.
//
// Unlike the built-in sidebar, a group header here is only a label: every
// workspace — the group's anchor included — gets its own row, so no workspace
// can hide behind a group name (Mission Control once did).
//
// Lives in the RIGHT sidebar (`cmux right-sidebar set custom phosphor`); the
// left sidebar stays the cmux default. Two modes (header toggle):
//   ATTENTION (default each open — the runtime has no persisted state): only
//     rows that need the owner — agent NEEDS-INPUT, task APPROVAL or BLOCKED
//     (from the progress label), or unread notifications — sorted in that
//     order, oldest state-change first; everything else folds into one count
//     line per group, or a single calm line when nothing needs the owner.
//   ALL: the full grouped roster, drag-reorder inside a group.

const C = {
  bg: "#000000",
  ink: "#28FE14",        // phosphor green (bright)
  ink2: "#00A600",       // dim green
  rule: "#0D5F0D",       // card edge / dividers
  sel: "#28FE1426",      // selected row wash
  hover: "#28FE1414",
  run: "#00E5E5",        // RUNNING (board: l-running)
  input: "#E5E500",      // NEEDS INPUT (board: status-warning)
  codex: "#9D7BFF",      // Codex hue (Tier 2 domainColors.codex)
};

// agent state → glyph + label + color (board LIFECYCLE vocabulary)
// INPUT is NOT taken from cmux's agent `needs_input` (it marked idle
// residents as needing input). The board publishes prompts it has
// verified — Claude permission/question notifications, Codex approval dialogs
// — as a "▲ INPUT · …" progress label; that is the only INPUT source here.
const STATE = {
  input:   { glyph: "▲", label: "INPUT", color: C.input },
  working: { glyph: "◉", label: "RUN",   color: C.run },
  idle:    { glyph: "○", label: "IDLE",  color: C.ink2 },
  ended:   { glyph: "·", label: "ENDED", color: C.rule },
  none:    { glyph: "·", label: "SHELL", color: C.rule },
};
const INPUT_PREFIX = "▲ INPUT · ";
const labelOf = (w) => (w && w.progress && w.progress.label) || "";
const inputOf = (w) => labelOf(w).indexOf(INPUT_PREFIX) === 0;
// context gauge from the board: "ctx 61%" inside the progress label;
// bands mirror config/jobs.mjs CONTEXT (amber ≥60, red ≥80)
const CTX_AMBER = 60, CTX_RED = 80;
function ctxOf(w) {
  const m = labelOf(w).match(/ctx (\d+)%/);
  return m ? Number(m[1]) : null;
}
const ctxColor = (pct) => (pct >= CTX_RED ? "#FF4444" : pct >= CTX_AMBER ? C.input : C.ink2);
// task text without the input prefix; "" when the workspace has no ledger task
function taskOf(w) {
  const l = inputOf(w) ? labelOf(w).slice(INPUT_PREFIX.length) : labelOf(w);
  return /#\d+|\d+ tasks/.test(l) ? l : "";
}

const agentOf = (w) => (w && w.agents && w.agents.length ? w.agents[0] : null);
const isCodex = (w) => {
  const a = agentOf(w);
  return (a && a.kind === "codex") || (w && String(w.color || "").toUpperCase() === C.codex);
};
function stateOf(w) {
  if (inputOf(w)) return STATE.input;
  const a = agentOf(w);
  if (!a) return STATE.none;
  if (a.status === "working") return STATE.working;
  if (a.status === "ended") return STATE.ended;
  return STATE.idle;                    // idle and cmux's needs_input alike
}

function ago(fromEpoch) {
  const now = (data.clock() || {}).epoch;
  if (!now || !fromEpoch) return "";
  const s = Math.max(0, Math.floor(now - fromEpoch));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 172800) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function sinceOf(w) {
  const a = agentOf(w);
  return (a && (a.sinceEpoch || a.lastActivityAt)) || (w && w.latestAt) || null;
}

// ---- mode ----------------------------------------------------------------------
const [mode, setMode] = signal("attention");

// Why does this workspace need the owner? → { tier, label } or null. Lower tier
// sorts first. Task state comes from the progress label (the board mirrors the
// `task` pill there because sidebars cannot read pills).
function attentionOf(w) {
  if (!w) return null;
  const task = taskOf(w);
  if (inputOf(w)) return { tier: 0, label: "INPUT" };
  if (/APPROVAL/.test(task)) return { tier: 1, label: "APPROVAL" };
  if (/BLOCKED/.test(task)) return { tier: 2, label: "BLOCKED" };
  if (w.unread > 0) return { tier: 3, label: "UNREAD" };
  return null;
}

// The bar is its OWN list entry with static sizes baked into its key (the
// runtime ignores a function-valued .frame()). It now
// shows CONTEXT USED (band-colored), present whenever the board measured a
// context for the workspace; the task checklist stays in the label text.
const BAR_W = 120;
function barEntry(w, keyPrefix, groupId) {
  const pct = ctxOf(w);
  if (pct == null) return null;
  const px = Math.round((BAR_W * Math.min(100, pct)) / 100);
  return { kind: "bar", id: "b:" + keyPrefix + w.id + ":" + px, wsId: w.id, groupId, px, color: ctxColor(pct) };
}
function pushRow(out, row, w) {
  out.push(row);
  const bar = barEntry(w, row.attention ? "a:" : "", row.groupId);
  if (bar) out.push(bar);
}

// ---- flat list: fixed group headers + workspace rows (grouped first) --------
const groupById = (id) => (data.groups() || []).find((g) => g.id === id);

function attentionEntries() {
  const ws = data.workspaces() || [];
  const hits = ws.map((w) => ({ w, at: attentionOf(w) })).filter((x) => x.at);
  hits.sort((x, y) => x.at.tier - y.at.tier || (sinceOf(x.w) || 0) - (sinceOf(y.w) || 0));
  // distinct keys per mode: a row template is built once per key, so an
  // attention row must not be reused as an ALL row (and vice versa)
  const out = [];
  for (const x of hits) pushRow(out, { kind: "ws", id: "a:" + x.w.id, wsId: x.w.id, groupId: x.w.group || null, attention: true }, x.w);
  const quiet = ws.filter((w) => !attentionOf(w));
  const count = (list) => list.filter((w) => stateOf(w) === STATE.working).length;
  if (!out.length) {
    out.push({ kind: "calm", id: "calm" });
  }
  // one count line per group (and one for ungrouped) for everything quiet
  const groups = data.groups() || [];
  const buckets = new Map();
  for (const w of quiet) {
    const key = w.group && groups.some((g) => g.id === w.group) ? w.group : "loose";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(w);
  }
  if (buckets.size) out.push({ kind: "quiet-head", id: "qh" });
  for (const [key, list] of buckets) {
    out.push({ kind: "quiet", id: "q:" + key + ":" + list.length + ":" + count(list),
      groupId: key === "loose" ? null : key, running: count(list), idle: list.length - count(list) });
  }
  return out;
}

const entries = computed(() => {
  if (mode() === "attention") return attentionEntries();
  const ws = data.workspaces() || [];
  const groups = data.groups() || [];
  const out = [];
  const seen = new Set();
  // groups in the order their first member appears
  for (const w of ws) {
    if (!w.group || seen.has(w.group)) continue;
    const g = groups.find((x) => x.id === w.group);
    if (!g) continue;
    seen.add(g.id);
    out.push({ kind: "header", id: "h:" + g.id, groupId: g.id });
    if (!g.collapsed) {
      for (const m of ws.filter((x) => x.group === g.id)) pushRow(out, { kind: "ws", id: m.id, groupId: g.id }, m);
    }
  }
  const loose = ws.filter((w) => !w.group || !seen.has(w.group));
  if (loose.length) {
    out.push({ kind: "header", id: "h:loose", groupId: null });
    for (const w of loose) pushRow(out, { kind: "ws", id: w.id, groupId: null }, w);
  }
  return out;
});

// Drag-reorder INSIDE a group only (cross-group drops are ignored — group
// membership is the mesh's domain decision, changed with sync-groups).
function handleMove(id, index) {
  if (mode() !== "all") return;             // the attention list is sorted, not ordered
  const ws = data.workspaces() || [];
  const dragged = ws.find((w) => w.id === id);
  if (!dragged) return;
  const list = entries().filter((e) => e.id !== id);
  const prev = list[index - 1];
  const target = prev ? prev.groupId : undefined;
  if ((target || null) !== (dragged.group || null)) return;
  const next = list.slice(index).find((e) => e.kind === "ws");
  const nextW = next && next.groupId === (dragged.group || null) ? ws.find((w) => w.id === next.id) : null;
  let to;
  if (nextW) to = dragged.index < nextW.index ? nextW.index - 1 : nextW.index;
  else {
    const members = ws.filter((w) => (w.group || null) === (dragged.group || null));
    const last = members[members.length - 1];
    to = last ? (dragged.index < last.index ? last.index : last.index + 1) : dragged.index;
  }
  if (to !== dragged.index) cmux("workspace.reorder", { workspace_id: id, index: to });
}

// ---- views --------------------------------------------------------------------
function header() {
  const ws = () => data.workspaces() || [];
  const count = (st) => ws().filter((w) => stateOf(w) === STATE[st]).length;
  return VStack({ spacing: 3 }, [
    HStack({ spacing: 8 }, [
      Rectangle().fill(C.ink).frame({ width: 8, height: 8 }).cornerRadius(2),
      Text("__BRAND__").font(12).bold().monospaced().color(C.ink),
      Spacer(),
      Text(() => (data.clock() || {}).time || "").font(11).monospaced().color(C.ink2),
    ]),
    // mode toggle: ATTENTION (default) | ALL
    HStack({ spacing: 6 }, [
      modeTab("attention", "ATTENTION"),
      modeTab("all", "ALL"),
      Spacer(),
    ]),
    // cmux-side counts only (fleet ok/warn/down needs board JSON → Dock panel)
    Text(() => {
      const hot = ws().filter((w) => (ctxOf(w) || 0) >= CTX_RED).length;
      return "▲ " + count("input") + " INPUT  ◉ " + count("working") + " RUN  ○ " + count("idle") + " IDLE  ✉ " + (data.unreadTotal() || 0)
        + (hot ? "  ctx▮ " + hot + "≥80%" : "");
    })
      .font(10).monospaced().lineLimit(1).color(() => (count("input") ? C.input : C.ink2)),
  ])
    .paddingHorizontal(10)
    .paddingVertical(8)
    .borderColor(C.rule)
    .borderWidth(1)
    .cornerRadius(4);
}

function modeTab(value, label) {
  const on = () => mode() === value;
  return Text(label).font(10).bold().monospaced()
    .color(() => (on() ? C.bg : C.ink2))
    .paddingHorizontal(7)
    .paddingVertical(2)
    .background(() => (on() ? C.ink : null))
    .borderColor(C.rule)
    .borderWidth(1)
    .cornerRadius(3)
    .hoverBackground(C.hover)
    .onTap(() => setMode(value));
}

// "✓ nothing needs you · n running · n idle"
function calmLine() {
  const ws = () => data.workspaces() || [];
  const n = () => ws().filter((w) => stateOf(w) === STATE.working).length;
  return Text(() => "✓ nothing needs you · " + n() + " running · " + (ws().length - n()) + " idle")
    .font(11).monospaced().color(C.ink)
    .paddingHorizontal(8).paddingVertical(10)
    .frame({ maxWidth: "infinity" })
    .fixed();
}

function quietHead() {
  return Text("QUIET").font(9).bold().monospaced().color(C.rule)
    .paddingHorizontal(8).paddingVertical(3)
    .frame({ maxWidth: "infinity" })
    .fixed();
}

// one folded line per group: "■ STORE   ◉ 1 run  ○ 6 idle"
function quietLine(entry) {
  const g = () => (entry.groupId ? groupById(entry.groupId) : null);
  return HStack({ spacing: 6 }, [
    Rectangle().fill(() => (g() && g().color) || C.rule).frame({ width: 6, height: 6 }).cornerRadius(1),
    Text(() => (g() ? g().name : "UNGROUPED")).font(10).monospaced().color(C.ink2).lineLimit(1),
    Spacer(),
    Text((entry.running ? "◉ " + entry.running + " run  " : "") + "○ " + entry.idle + " idle")
      .font(10).monospaced().color(C.rule),
  ])
    .paddingHorizontal(8).paddingVertical(3)
    .frame({ maxWidth: "infinity" })
    .fixed()
    .onTap(() => { setMode("all"); });
}

function groupHeader(entry) {
  const g = () => (entry.groupId ? groupById(entry.groupId) : null);
  return HStack({ spacing: 6 }, [
    Image(() => (g() && g().collapsed ? "chevron.right" : "chevron.down"))
      .font(9).color(C.ink2)
      .frame({ width: 12, height: 14 })
      .onTap(() => {
        if (!g()) return;
        cmux(g().collapsed ? "workspace.group.expand" : "workspace.group.collapse", { group_id: g().id });
      }),
    Rectangle().fill(() => (g() && g().color) || C.rule).frame({ width: 6, height: 6 }).cornerRadius(1),
    Text(() => (g() ? g().name : "UNGROUPED")).font(10).bold().monospaced().color(C.ink2),
    Spacer(),
    Text(() => {
      const n = (data.workspaces() || []).filter((w) => (entry.groupId ? w.group === entry.groupId : !w.group)).length;
      return String(n);
    }).font(10).monospaced().color(C.rule),
  ])
    .paddingHorizontal(8)
    .paddingVertical(4)
    .frame({ maxWidth: "infinity" })
    .fixed();
}

// Compact two-line row, sized for a ~240px right panel: the state badge sits
// BEFORE the title in a fixed-width slot (it never wraps), the title takes the
// rest and truncates; line two is the task (or description), with age.
function workspaceRow(entry) {
  const wsId = entry.wsId || entry.id;
  const w = () => (data.workspaces() || []).find((x) => x.id === wsId);
  const st = () => stateOf(w());
  const dotColor = () => (isCodex(w()) ? C.codex : st().color);
  const badge = () => {
    const at = entry.attention ? attentionOf(w()) : null;
    return at ? at.label : st().label;
  };
  const badgeColor = () => {
    const at = entry.attention ? attentionOf(w()) : null;
    if (!at) return dotColor();
    return at.tier === 2 ? "#FF8C3C" : at.tier === 3 ? C.ink : C.input;   // BLOCKED orange, UNREAD green
  };
  return VStack({ spacing: 1 }, [
    HStack({ spacing: 5 }, [
      Text(() => st().glyph).font(10).color(dotColor).lineLimit(1).frame({ width: 10 }),
      Text(badge).font(9).bold().monospaced().lineLimit(1).color(badgeColor).frame({ width: 56, alignment: "leading" }),
      Text(() => (w() ? w().title : "")).font(11).monospaced().lineLimit(1).truncation("tail").marquee()
        .color(() => (w() && w().selected ? C.ink : C.ink2))
        .frame({ maxWidth: "infinity", alignment: "leading" }),
      Text(() => (w() && w().unread > 0 ? "✉" + w().unread : "")).font(9).monospaced().lineLimit(1).color(C.input),
      Text(() => ago(sinceOf(w()))).font(9).monospaced().lineLimit(1).color(C.rule),
    ]),
    Text(() => {
      const g = entry.attention && w() && w().group ? groupById(w().group) : null;
      const cx = isCodex(w()) ? "codex · " : "";
      const pct = ctxOf(w());
      const task = taskOf(w()).replace(/^ctx \d+% · /, "");
      return (g ? g.name + " · " : "") + cx + (pct != null ? "ctx " + pct + "% · " : "") + (task || ((w() && w().description) || ""));
    }).font(9).monospaced().lineLimit(1).truncation("tail")
      .color(() => {
        const pct = ctxOf(w());
        if (pct != null && pct >= CTX_AMBER) return ctxColor(pct);
        return taskOf(w()) ? C.ink : C.rule;
      })
      .paddingLeading(15)
      .frame({ maxWidth: "infinity", alignment: "leading" }),
  ])
    .paddingHorizontal(6)
    .paddingVertical(3)
    .marginLeading(entry.groupId && !entry.attention ? 6 : 0)
    .cornerRadius(3)
    .borderColor(() => (w() && String(w().color || "") ? w().color : C.bg))
    .borderWidth(() => (w() && w().selected ? 1 : 0))
    .background(() => (w() && w().selected ? C.sel : null))
    .hoverBackground(C.hover)
    .frame({ maxWidth: "infinity" })
    .onTap(() => { if (w()) cmux("workspace.select", { workspace_id: w().id }); });
}

// 2px context bar under a row; width and color are static (from the entry key).
function barRow(entry) {
  return HStack({ spacing: 0 }, [
    Rectangle().fill(entry.color || C.ink2).frame({ width: entry.px, height: 2 }),
    Rectangle().fill(C.rule).frame({ width: BAR_W - entry.px, height: 2 }),
    Spacer(),
  ])
    .paddingLeading(entry.groupId ? 27 : 21)
    .paddingVertical(1)
    .frame({ maxWidth: "infinity", maxHeight: 4 })
    .fixed();
}

sidebar(() =>
  VStack({ spacing: 6 }, [
    header(),
    Reorderable(
      { items: entries, key: (e) => e.id, spacing: 1, onMove: handleMove },
      (e) => {
        const entry = e();
        if (entry.kind === "header") return groupHeader(entry);
        if (entry.kind === "calm") return calmLine();
        if (entry.kind === "quiet-head") return quietHead();
        if (entry.kind === "quiet") return quietLine(entry);
        if (entry.kind === "bar") return barRow(entry);
        return workspaceRow(entry);
      }
    ),
    Spacer(),
  ])
    .padding(6)
    .background(C.bg)
);
