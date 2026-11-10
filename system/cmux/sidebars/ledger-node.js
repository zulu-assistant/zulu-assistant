// ledger-node: the selected workspace's ledger task as a cmux custom sidebar (OPTIONAL).
// It reads the task from the progress label the board writes for each workspace.
// Installed next to phosphor.js by scripts/cmux-tier1-install.mjs, never selected by it.
// Pick it yourself: `cmux right-sidebar set custom ledger-node --no-focus`.
//
// The runtime has no network, filesystem or timers, so it cannot GET the board's
// /api/tasks. The ledger data that reaches it is what the board mirrors into cmux:
// the workspace progress label, e.g. "[▲ INPUT · ]ctx 61% · #411 WORKING · 1/4 · <title>".
// The title segment is there while mesh.json titleInLabel is true (the default).

const C = {
  ink: "#28FE14",
  ink2: "#00A600",
  rule: "#0D5F0D",
  warn: "#E5E500",
  bad: "#FF4444",
};

// workspace title → mesh address (AGENT-MESH.md: slug of the workspace title)
const slug = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const labelOf = (w) => (w && w.progress && w.progress.label) || "";

// One task:      "#411 WORKING · 1/4 · <title>" (title optional)
// Several tasks: "22 tasks · #344 BLOCKED · 0/4 · <title>" — the headline task (the agent's focus, else
// the urgent one, else the latest), or "22 tasks · #344 BLOCKED · #421 WORKING · 1/4 · <title>" when the
// headline isn't the urgent one. The headline is the "#N STATUS · d/t" group; an urgent token before it is `also`.
function taskOf(w) {
  const l = labelOf(w);
  const n = l.match(/(\d+) tasks\b/);
  const count = n ? Number(n[1]) : 1;
  const m = l.match(/#(\d+) ([A-Z]+) · (\d+\/\d+)(?: · (.+))?/) || l.match(/#(\d+) ([A-Z]+)(?: · (\d+\/\d+))?(?: · (.+))?/);
  if (!m) return n && count > 0 ? { id: "", status: "", checklist: "", title: "", count, more: count, also: "" } : null;
  const first = l.match(/#(\d+) ([A-Z]+)/);
  const also = n && first && first[1] !== m[1] ? `#${first[1]} ${first[2]}` : "";
  return { id: m[1], status: m[2], checklist: m[3] || "", title: m[4] || "", count, more: count - 1, also };
}

// "and 21 more · also #344 BLOCKED" under the headline; nothing for a single task
const moreLine = (t) =>
  !t || t.count < 2 ? "" : (t.id ? `and ${t.more} more` : `${t.count} tasks`) + (t.also ? ` · also ${t.also}` : "");

const statusColor = (s) =>
  s === "BLOCKED" ? C.bad : s === "APPROVAL" ? C.warn : s === "OPEN" ? C.ink2 : C.ink;

const selected = () => (data.workspaces() || []).find((w) => w.selected) || null;
const task = () => taskOf(selected());

sidebar(() =>
  VStack({ spacing: 6, alignment: "leading" }, [
    Text("LEDGER").font(11).monospaced().bold().color(C.ink2),
    Divider(),
    HStack({ spacing: 6 }, [
      Text(() => (task() && task().id ? "#" + task().id : "—")).font(12).monospaced().bold().color(C.ink),
      Text(() => (task() ? task().title || (task().id ? "(no title in the label)" : `${task().count} tasks`) : "no ledger task"))
        .font(12)
        .lineLimit(1)
        .color(() => (task() && task().title ? C.ink : C.rule)),
      Spacer(),
      Text(() => (task() ? task().status : "")).font(11).monospaced().color(() => statusColor(task() ? task().status : "")),
    ]),
    HStack({ spacing: 6 }, [
      Text(() => "@" + slug(selected() ? selected().title : "")).font(11).monospaced().color(C.ink2).lineLimit(1),
      Spacer(),
      Text(() => (task() ? task().checklist : "")).font(11).monospaced().color(C.ink2),
    ]),
    Text(() => moreLine(task())).font(11).monospaced().color(() => (task() && task().also ? statusColor(task().also.split(" ")[1]) : C.ink2)).lineLimit(1),
  ]).padding(8)
);
