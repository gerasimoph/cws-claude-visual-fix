// Prints the Chrome extension ID derived from the "key" in extension/manifest.json.
// Usage: node scripts/extension-id.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const der = Buffer.from(manifest.key, 'base64');
const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));
