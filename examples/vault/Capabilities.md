---
type: reference
source: cross-project sweep of all vault project notes
tags: [meta, capabilities, reuse]
date: YYYY-MM-DD
---
# Capabilities — reusable building blocks

Consult this note **before building anything new**. It indexes what already exists across
<OWNER>'s projects, by capability rather than by project, plus the shared resources you must not
step on. Details live in the linked project notes; conventions in [[Vault Guide]].

**Agents: when you sync a project that adds a genuinely reusable capability (or changes a shared
resource), add or update it here.** Keep every entry sourced to a `[[project note]]`.

<!-- Add one `## <Category>` section per capability area as reusable pieces emerge.
     Entry shape:
- **<Capability>** — <what it does, one line>. Entry point: `<path or endpoint>`. See [[<Project>]].
-->

## Messaging & notifications
<!-- e.g. an SMS/email sending service, a push-notification helper -->

## Data & integrations
<!-- e.g. API clients, shared databases, import/export pipelines, parsers -->

## AI & agents
<!-- e.g. prompt libraries, MCP servers, agent tools, evaluation harnesses -->

## Infrastructure patterns
<!-- e.g. the selfheal scheduled-job runner (.scripts/selfheal-runner.sh), backup/restore,
     queue + poller bridges, health endpoints watched by the Ops Board -->

## Shared resources & constraints
<!-- The step-on-toes list — check before adding a new writer, sender or scheduled job.
     One bullet per shared database, shared credential, shared queue, shared sender identity
     (phone number / email address), shared host or port, or single-writer contract. Example:
- **<Shared DB>** — written by [[<Project A>]] and [[<Project B>]]; only A may write table X.
- **Port <N>** — owned by [[<Project C>]]; don't bind it elsewhere.
This is the most important section to keep current. -->
