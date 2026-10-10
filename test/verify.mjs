#!/usr/bin/env node
// Checks a build end to end: encrypt with a test passphrase, then decrypt the way the browser does.
// Run: node test/verify.mjs   (uses a throwaway output folder; your docs/ is untouched)
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'test/.out';
const PASS = 'correct horse battery staple test';
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; };

execFileSync('node', ['build.mjs', '--out', OUT], { cwd: ROOT, env: { ...process.env, DOSSIER_PASSPHRASE: PASS }, stdio: 'pipe' });
const html = await readFile(path.join(ROOT, OUT, 'index.html'), 'utf8');
const m = html.match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/);
check(Boolean(m), 'payload is embedded in index.html');
const env = JSON.parse(m[1]);
check(env.mode === 'enc' && env.iter >= 600000, 'payload is encrypted with ≥600k PBKDF2 iterations');

const md = await readFile(path.join(ROOT, 'content/dossier.md'), 'utf8');
const sample = md.split('\n').find((l) => l.startsWith('## ')).slice(3, 30);
check(!html.includes(sample), `no plaintext in the built page (looked for "${sample}")`);

const b = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const subtle = webcrypto.subtle;
const derive = async (pass) => subtle.deriveKey(
  { name: 'PBKDF2', salt: b(env.salt), iterations: env.iter, hash: 'SHA-256' },
  await subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']),
  { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
);
const data = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: b(env.iv) }, await derive(PASS), b(env.ct))));
check(typeof data.html === 'string' && data.html.includes('<h2 id='), 'correct passphrase decrypts to the rendered dossier');
check(Array.isArray(data.deadlines), 'deadlines travel with the payload');
let rejected = false;
try { await subtle.decrypt({ name: 'AES-GCM', iv: b(env.iv) }, await derive('wrong passphrase here'), b(env.ct)); } catch { rejected = true; }
check(rejected, 'a wrong passphrase is rejected');

const sw = await readFile(path.join(ROOT, OUT, 'sw.js'), 'utf8');
check(!sw.includes('__VERSION__'), 'service worker carries a build version');

try { await rm(path.join(ROOT, OUT), { recursive: true, force: true }); } catch { console.log('  (could not remove test/.out; it is git-ignored and safe to delete)'); }
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
