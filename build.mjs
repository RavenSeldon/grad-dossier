#!/usr/bin/env node
// Builds the dossier site from content/ into docs/ (or --out <dir>).
//
//   node build.mjs                  encrypted build into docs/ (asks for a passphrase)
//   node build.mjs --preview        unencrypted build into preview/ (git-ignored, for local viewing)
//
// Encrypted builds use PBKDF2-SHA256 (600,000 iterations) and AES-256-GCM via WebCrypto.
// Only ciphertext reaches docs/. The plaintext in content/ is git-ignored and never published.
// Set DOSSIER_PASSPHRASE to skip the prompt (useful for scripts).

import { readFile, writeFile, mkdir, cp, rm, readdir, stat } from 'node:fs/promises';
import { webcrypto, randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marked } from './vendor/marked.esm.js';

const subtle = webcrypto.subtle;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ITERATIONS = 600000;
const MIN_PASSPHRASE = 12;

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const outArg = args.indexOf('--out');
const OUT = path.resolve(ROOT, outArg >= 0 ? args[outArg + 1] : (preview ? 'preview' : 'docs'));

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ---------- content ----------

function slugify(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

function stripTitleAndByline(md) {
  const lines = md.split('\n');
  let title = 'Graduate applications dossier';
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 >= 0) {
    title = lines[h1].replace(/^# /, '').trim();
    lines.splice(h1, 1);
    // Drop the exported byline ("Oct 2, 2026 · @Name") if it is the next non-empty line.
    const next = lines.findIndex((l, i) => i >= h1 && l.trim() !== '');
    if (next >= 0 && /·\s*@/.test(lines[next])) lines.splice(next, 1);
  }
  return { title, md: lines.join('\n') };
}

function renderHtml(md) {
  let html = marked.parse(md, { gfm: true, breaks: false });
  const used = new Set();
  html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    let id = slugify(inner);
    let n = 2;
    while (used.has(id)) id = `${slugify(inner)}-${n++}`;
    used.add(id);
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" target="_blank" rel="noopener noreferrer"');
  return html;
}

async function loadContent() {
  const mdPath = path.join(ROOT, 'content', 'dossier.md');
  if (!(await exists(mdPath))) fail('content/dossier.md is missing. Export the dossier as Markdown and save it there.');
  const raw = await readFile(mdPath, 'utf8');
  const { title, md } = stripTitleAndByline(raw);
  let deadlines = [];
  const dlPath = path.join(ROOT, 'content', 'deadlines.json');
  if (await exists(dlPath)) {
    try {
      deadlines = JSON.parse(await readFile(dlPath, 'utf8')).items || [];
    } catch (e) {
      fail(`content/deadlines.json is not valid JSON: ${e.message}`);
    }
  }
  return {
    title,
    updated: new Date().toISOString().slice(0, 10),
    html: renderHtml(md),
    deadlines,
  };
}

// ---------- passphrase ----------

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function getPassphrase() {
  if (process.env.DOSSIER_PASSPHRASE) return process.env.DOSSIER_PASSPHRASE;
  if (!process.stdin.isTTY) fail('No passphrase. Run this in a terminal, or set DOSSIER_PASSPHRASE.');
  console.log('Choose the passphrase you will type to unlock the site.');
  console.log(`Use at least ${MIN_PASSPHRASE} characters; four or more random words is best.`);
  console.log('Use the same passphrase every time so devices you have unlocked stay unlocked.\n');
  const a = await askHidden('Passphrase: ');
  const b = await askHidden('Repeat it:  ');
  if (a !== b) fail('The two entries did not match. Nothing was built.');
  return a;
}

// ---------- crypto ----------

const b64 = (buf) => Buffer.from(buf).toString('base64');

async function loadSalt() {
  // The salt is not secret. Keeping it stable lets a remembered device key survive rebuilds
  // that use the same passphrase.
  const saltPath = path.join(ROOT, 'dossier.salt');
  if (await exists(saltPath)) {
    const s = (await readFile(saltPath, 'utf8')).trim();
    if (Buffer.from(s, 'base64').length === 16) return s;
  }
  const s = b64(randomBytes(16));
  await writeFile(saltPath, s + '\n');
  return s;
}

async function encrypt(payload, passphrase, saltB64) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt: Buffer.from(saltB64, 'base64'), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { mode: 'enc', v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: saltB64, iv: b64(iv), ct: b64(ct) };
}

// ---------- output ----------

function embed(json) {
  // Safe inside <script type="application/json">: no "<" can close the tag.
  return JSON.stringify(json).replace(/</g, '\\u003c');
}

async function writeSite(envelope) {
  if (path.relative(ROOT, OUT).startsWith('..')) fail('--out must be inside the project folder.');
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const appDir = path.join(ROOT, 'app');
  for (const name of await readdir(appDir)) {
    if (name === 'index.html' || name === 'sw.js' || name.startsWith('.')) continue;
    await cp(path.join(appDir, name), path.join(OUT, name), { recursive: true });
  }
  const template = await readFile(path.join(appDir, 'index.html'), 'utf8');
  if (!template.includes('<!--PAYLOAD-->')) fail('app/index.html is missing the <!--PAYLOAD--> marker.');
  const index = template.replace(
    '<!--PAYLOAD-->',
    `<script type="application/json" id="payload">${embed(envelope)}</script>`,
  );
  await writeFile(path.join(OUT, 'index.html'), index);

  const shellFiles = ['index.html', 'app.css', 'app.js', 'manifest.webmanifest'];
  const hash = createHash('sha256');
  for (const f of shellFiles) hash.update(await readFile(path.join(OUT, f)));
  const version = hash.digest('hex').slice(0, 12);
  const sw = (await readFile(path.join(appDir, 'sw.js'), 'utf8')).replace('__VERSION__', version);
  await writeFile(path.join(OUT, 'sw.js'), sw);
  await writeFile(path.join(OUT, '.nojekyll'), '');
  return version;
}

// ---------- main ----------

if (preview && path.relative(ROOT, OUT) === 'docs') fail('Refusing to write an unencrypted preview into docs/, which is what gets published.');

const content = await loadContent();
let envelope;
if (preview) {
  envelope = { mode: 'plain', data: content };
} else {
  const passphrase = await getPassphrase();
  if (passphrase.length < MIN_PASSPHRASE) fail(`Passphrase is shorter than ${MIN_PASSPHRASE} characters. Nothing was built.`);
  envelope = await encrypt(content, passphrase, await loadSalt());
}
const version = await writeSite(envelope);
const rel = path.relative(ROOT, OUT) || '.';
console.log(`\n✓ Built ${preview ? 'an unencrypted preview' : 'the encrypted site'} in ${rel}/ (version ${version}).`);
if (preview) console.log(`  Open ${rel}/index.html in a browser. This folder is git-ignored; never publish it.`);
