# data/tasks — Agent Mesh task ledger

One JSON file per task (`<id>.json`), written atomically by the board server
(the only writer). Git-ignored except this README: tasks are live state, not
source. Back up / inspect with `scripts/task.sh list --status live` or
`curl -s localhost:3210/api/tasks?status=live`.

Do not hand-edit while the board is running (it caches the ledger in memory);
stop it, edit, `launchctl kickstart -k gui/$(id -u)/$MC_LABEL_PREFIX.master-console` (label prefix: config/zulu.env).
Never put secrets here — the API rejects credential-looking text.
Schema + rules: ../../AGENT-MESH.md.
