// 001: the first schema stamp (#346). Installs before 1.1 have no data/schema-version.json; this
// records schema 1 and changes nothing else. SETTINGS.upgrade needs no migration: an overlay that
// predates the key reads as "on against SETTINGS.repoUrl" (src/upgrade.mjs upgradeConfig).
export const id = '001-schema-stamp';
export const description = 'stamp schema 1 (no data changes)';
export async function up() {}
