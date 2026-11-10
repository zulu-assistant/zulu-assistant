// Text that looks like a credential. Used by the ledger (which refuses to store it), the evidence
// panel and gate rows (which withhold it) and the backup (which leaves such a small file out).
// Pure, no imports: the backup tool loads it without the registry.
const SECRET_PATTERNS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/, /\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,   // JWTs (Supabase service keys)
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i,
];

export function containsSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(String(text || '')));
}
