---
name: graphify
description: "Use for any question about a codebase, its architecture, file relationships, or project content — especially when graphify-out/ exists, where the question should be treated as a graphify query first. Builds and queries a persistent code knowledge graph with query/path/explain tools."
---

# graphify — code memory

Graphify (third-party, `uv tool install graphifyy==0.9.83`) turns a repo into a knowledge graph:
god nodes, communities and cross-file relationships, stored in `graphify-out/`. This is a short,
generic skill for Zulu Assistant fleets. For the full upstream skill (extraction modes, exports,
merges), run `graphify install --platform claude`, which replaces this file.

## Fast path — a graph exists

If `graphify-out/graph.json` exists in the current project and the request is a question about
the code (not a rebuild), **query the graph before grepping or reading files**:

```bash
graphify query "<question>"            # broad context (BFS); add --dfs to trace one path
graphify query "<question>" --budget 1500
graphify path "<A>" "<B>"              # shortest relationship between two concepts
graphify explain "<concept>"           # one node and its neighbours, in plain language
```

Then read raw files only to modify or debug specific lines. If `graphify-out/wiki/index.md`
exists, use it for broad navigation. Read `graphify-out/GRAPH_REPORT.md` only for an architecture
review or when query/path/explain did not surface enough.

## Build or refresh

```bash
graphify update .        # re-extract code (AST only, no API cost) — run after every code change
graphify hook install    # git hooks: rebuild after each commit and checkout
graphify cluster-only .  # re-run community detection on an existing graph
```

`update` refuses to shrink the graph after large deletions; pass `--force` after a refactor that
removed code. `graphify-out/` is per machine — keep it in `.gitignore`, never commit it.

## Hook guards

`.claude/settings.json` can carry `PreToolUse` hooks that call `graphify hook-guard search`
(shell searches) and `graphify hook-guard read` (`Read`/`Glob`). When a graph exists they inject
a reminder to query it first; they never block a tool call. Template:
`examples/claude/settings.json`.

## When a graph does not exist

1. Check `graphify --version`. If missing, tell the user the install line above; do not install
   it silently.
2. Offer to build one with `graphify update .` for code-only repos.
3. Until then, fall back to normal search.

## Rules for subagents

Include the graph-first rule in every subagent prompt that explores code: "`graphify-out/graph.json`
exists — run `graphify query` before grepping or reading source files."
