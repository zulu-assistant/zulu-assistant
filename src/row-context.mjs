// Row context (1.3): what the owner reads on a waiting row before the click.
//
// A chip per class and list, from data the board already has when a gate is filed: the class the
// classifier chose, the repo the command targets, and the policy's lists. The chip is an ID from the
// fixed table below; the page maps the id to its text (public/decide.js CHIP_TEXT, pinned equal to
// this table by a test). No chip text ever comes from the agent: an unknown id is dropped here and
// again on the page.
//
// The agent's own reason (the tool call's description) is kept separately, cut to one short line,
// withheld when it looks like a credential, and shown labelled "agent's words".
import { containsSecret } from './secret-text.mjs';
import { globMatch } from './gates.mjs';

export const CHIPS = {
  'public-repo': 'public repo',
  'deploy-on-push': 'deploys on push',
  outbound: 'sends outside',
  store: 'store write',
  self: 'the gate itself',
  desktop: 'desktop control',
  unlisted: 'unlisted tool',
};
// class id → chip id ('mcp-unlisted' and 'desktop' arrive with the 1.3 classifier slices)
const BY_CLASS = { outbound: 'outbound', store: 'store', self: 'self', desktop: 'desktop', 'mcp-unlisted': 'unlisted' };
export const MAX_WORDS = 300;

// the same matcher as the standing check (src/gates.mjs globMatch: `*` stops at `/`, `**` crosses), so a
// chip and a program go can never disagree about a list entry
const inList = (list, slug) => !!slug && (list || []).some((g) => globMatch(String(g).toLowerCase(), String(slug).toLowerCase()));

/** Chip ids for a gate: { cls, slug (owner/name of the repo the command targets, or null), lists (policy.lists) } → [ids]. */
export function rowContext({ cls, slug = null, lists = {} } = {}) {
  const out = [];
  if (inList(lists.publicRemotes, slug)) out.push('public-repo');
  if (inList(lists.deployOnPush, slug)) out.push('deploy-on-push');
  if (BY_CLASS[cls]) out.push(BY_CLASS[cls]);
  return out;
}

/** Only known chip ids, once each, in the table's order (what the ledger stores and the page shows). */
export function cleanContext(list) {
  const have = new Set(Array.isArray(list) ? list.map(String) : []);
  return Object.keys(CHIPS).filter((id) => have.has(id));
}

/** The agent's own description of its call: one line, cut, withheld when it looks like a credential. null when empty. */
export function agentWords(description) {
  if (typeof description !== 'string') return null;
  const s = description.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (containsSecret(s)) return '[withheld: looks like a credential]';
  return s.length > MAX_WORDS ? `${s.slice(0, MAX_WORDS - 1)}…` : s;
}
