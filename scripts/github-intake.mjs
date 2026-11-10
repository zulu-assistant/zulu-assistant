#!/usr/bin/env node
// GitHub intake, by hand (src/github-intake.mjs, docs/GITHUB-INTAKE.md).
//
//   node scripts/github-intake.mjs                 what the next poll would see from the cursor
//   node scripts/github-intake.mjs --since 7d      the same for a window (hours or days, 7 days at most)
//   node scripts/github-intake.mjs --since 7d --apply   ask the board to read that window at its next poll
//
// Read-only against GitHub, and it never writes the ledger: the board is its only writer, so
// --apply only leaves data/github-intake/sweep.json for the next poll. Exit 0 = done, 2 = error.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SETTINGS } from '../src/config.mjs';
import { STATE_DIR, fetchFeed, intakeConfig, parseWindow, planIntake, requestSweep } from '../src/github-intake.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const readJson = (name, dflt) => { try { return JSON.parse(readFileSync(path.join(STATE_DIR, name), 'utf8')); } catch { return dflt; } };

try {
  const cfg = intakeConfig(SETTINGS.githubIntake);
  if (!cfg) throw new Error('SETTINGS.githubIntake is off (mode observe or on, and a repo, are needed)');
  const win = flag('--since');
  const ms = win ? parseWindow(win) : null;
  if (win && !ms) throw new Error('--since takes hours or days, e.g. 12h or 7d');
  const since = ms ? Date.now() - ms : readJson('cursor.json', {}).since;
  if (!since) throw new Error('no cursor yet (the first poll sets it); use --since for a window');
  const feed = await fetchFeed(cfg.repo, since);
  const plan = planIntake(feed, { repo: cfg.repo, ignoreAuthors: cfg.ignoreAuthors, seen: readJson('seen.json', {}), since });
  console.log(`${cfg.repo} since ${new Date(since).toISOString()}: ${plan.creates.length} thread(s) would be filed, ${plan.comments.length} follow-up(s)`);
  for (const t of plan.creates) console.log(`  ${t.title}  (@${t.author})  ${t.url}`);
  if (args.includes('--apply')) {
    if (!ms) throw new Error('--apply needs --since');
    await requestSweep(since);
    console.log('asked the board to read this window at its next poll');
  }
} catch (e) { console.error(`github-intake: ${e.message}`); process.exit(2); }
