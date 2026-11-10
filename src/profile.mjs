// Install profile (1.3): how much of the product this board runs.
//
//   SETTINGS.profile: 'full' (the default, also when absent)  the fleet board, the mesh, the heals
//                     'guardrails'                            the ledger, the gate, the waiting rows
//
// 'guardrails' is the product you can try in five minutes: an agent's irreversible command waits
// for the owner's click, runs once, and leaves a receipt. No cmux, no Mission Control, no mesh, no
// fleet cards. The poll then runs no collector, no mesh reconcile and no heal (server.mjs).
//
// This file also finds the cmux binary. A configured path that does not exist is not trusted: the
// PATH is searched, and "not found" is a fact the board states (the cmux:bridge card must never say
// "socket auth OK" on a Mac with no cmux).
// Pure, no imports from the rest of the board.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const PROFILES = ['full', 'guardrails'];
/** SETTINGS → 'full' | 'guardrails'. Anything else is 'full': today's board. */
export const profileOf = (settings) => (settings?.profile === 'guardrails' ? 'guardrails' : 'full');

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * Where is cmux? The configured path when it exists; else `cmux` on PATH; else not present.
 * → { bin, present, from: 'configured' | 'path' | 'none' }. `bin` is always a string, so call sites
 * that run it without checking still fail with a plain "not found", never crash on null.
 */
export function findCmux(configured, { env = process.env, exists = (p) => existsSync(p) && isFile(p) } = {}) {
  if (configured && exists(configured)) return { bin: configured, present: true, from: 'configured' };
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, 'cmux');
    if (exists(p)) return { bin: p, present: true, from: 'path' };
  }
  return { bin: configured || 'cmux', present: false, from: 'none' };
}
