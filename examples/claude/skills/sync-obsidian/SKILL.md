---
name: sync-obsidian
description: Sync the current project's documentation and memory into the central Obsidian vault. Use when the user says "sync to obsidian", "update my vault", "update obsidian", "save this to my notes", or at the end of a substantive piece of project work that should be recorded durably.
---

# Sync to Obsidian

Mirror the project you are working on into the central Obsidian vault so its documentation and
memory survive beyond this session.

Vault location: `$VAULT` (Zulu Assistant sets it in `overlay/config/zulu.env`; default
`$HOME/Vault`). If the folder is not accessible, ask the user where it is, then continue.

## Procedure

1. Read the vault's `Vault Guide.md` first. It defines the structure, frontmatter schema, note
   templates and the onboarding checklist. Follow it exactly — it is the source of truth and may
   be newer than this skill.
2. Identify the project (the active repo or working folder) and its vault folder: match an
   existing folder if there is one; otherwise name it after the project.
3. **Existing project:** update the relevant notes to the current live state of what changed this
   session. Do not leave stale pre-execution plans. For status notes, append a dated
   `## Update — YYYY-MM-DD` section rather than rewriting history. Bump `last-synced:` in the
   overview note.
4. **New project:** onboard it per the Vault Guide checklist —
   - create `/<Project Name>/` and the overview note `/<Project Name>/<Project Name>.md`
     (with `status:` and `last-synced:`);
   - add child notes for the meaningful parts (per service/module or per deliverable);
   - add a one-line entry under `Home.md` → `## Projects` (and any cross-project link);
   - add the vault-sync block to the project's own `CLAUDE.md`;
   - add the project to the table in `.scripts/vault-staleness-check.sh`.
5. If the work shipped a reusable capability or changed a shared resource, update
   `Capabilities.md`.
6. Link liberally with `[[wikilinks]]`, within the project and across projects.
7. Verify: every `[[wikilink]]` you wrote resolves to a real note (create the target or fix the
   link), and every new or edited note has frontmatter.
8. Report briefly: notes created vs updated, and links added.

## Notes

- The vault is a documentation/memory layer — concise, current, cross-linked. Not a dump of raw
  output.
- Routine Q&A or throwaway exploration needs no note; sync when project state changed.
- Prefer updating an existing note over creating a near-duplicate.
- Never write secrets, tokens or credentials into the vault.
