#!/usr/bin/env node
// verify-lab-cert.mjs -- refuse a release that has no valid lab-run certificate.
//
//   node verify-lab-cert.mjs --package holy-sheet-js --version 2.11.0 \
//        --commit <40-char sha> --source <dir-or-url> [--public-key <file>]
//
// Exit 0 ONLY when the certificate exists, its Ed25519 signature verifies
// against the pinned public key, and its package, version and commit are the
// ones being released. Exit 1 with the reason otherwise. Exit 2 on bad usage.
//
// ## A failed lookup is a failure
//
// A network error, a timeout, an HTTP 500 and a 404 all refuse. A gate that
// passes when it cannot see is a gate that passes whenever it is offline, which
// is exactly when nobody is looking. The reason is printed, so a refusal can be
// diagnosed rather than bypassed.
//
// ## The key is PINNED
//
// `lab-cert-public-key.ed25519` beside this file is a copy of the lab's
// committed `public-key.ed25519` (base64, 32 raw bytes). It is never fetched
// from the same place as the certificate: a source that could serve both could
// sign anything. `--public-key` exists for tests.
//
// ## Canonical form
//
// The signature covers every field except `signature`, as canonical JSON: keys
// sorted at every depth, no whitespace, JSON.stringify escaping. That matches
// the lab's PHP signer (CertificateSigner::canonical) byte for byte; the
// php-signed fixture in the tests is what proves it.
//
// Node built-ins only. Background: .ai/plans/lab-run-certificates.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KEY = path.join(here, 'lab-cert-public-key.ed25519');
const SHA = /^[0-9a-f]{40}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE = /^[a-z0-9][a-z0-9-]*$/;
const TIMEOUT_MS = 20000;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    // PHP and JavaScript print floats differently; a certificate has none.
    throw new Error('a certificate carries integers only, never floats');
  }
  return JSON.stringify(value);
}

class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

function loadKey(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    refuse(`the pinned public key is missing (${file}). Nothing can be verified without it -- NOT a pass.`);
  }
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== text) {
    refuse(`the pinned public key at ${file} is not a base64 Ed25519 public key.`);
  }
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

async function load(source, pkg, version) {
  if (/^https?:\/\//i.test(source)) {
    const url = `${source.replace(/\/+$/, '')}/${pkg}/${version}.json`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
    } catch (error) {
      refuse(`could not fetch ${url} (${error?.cause?.code ?? error?.name ?? 'error'}: ${error?.cause?.message ?? error?.message}). A failed lookup is NOT a pass.`);
    }
    if (res.status === 404) refuse(`no certificate for ${pkg} ${version}: ${url} is 404. Run the lab suite on this commit and \`php artisan lab:certify\` it.`);
    if (!res.ok) refuse(`could not fetch ${url}: HTTP ${res.status}. A failed lookup is NOT a pass.`);
    return { text: await res.text(), where: url };
  }

  const file = path.join(source, pkg, `${version}.json`);
  try {
    return { text: fs.readFileSync(file, 'utf8'), where: file };
  } catch (error) {
    if (error.code === 'ENOENT') refuse(`no certificate for ${pkg} ${version}: ${file} does not exist. Run the lab suite on this commit and \`php artisan lab:certify\` it.`);
    refuse(`could not read ${file} (${error.code}). A failed lookup is NOT a pass.`);
  }
  return null;
}

export async function verify({ pkg, version, commit, source, publicKey = DEFAULT_KEY }) {
  const key = loadKey(publicKey);
  const { text, where } = await load(source, pkg, version);

  let cert;
  try {
    cert = JSON.parse(text);
  } catch {
    refuse(`${where} is not JSON, so it is not a certificate.`);
  }
  if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) refuse(`${where} is not a certificate object.`);

  // The signature first: until it verifies, nothing else in the file is evidence.
  const { signature, ...signed } = cert;
  const sig = typeof signature === 'string' ? Buffer.from(signature, 'base64') : Buffer.alloc(0);
  if (sig.length !== 64) refuse(`${where} has no valid Ed25519 signature field.`);

  let body;
  try {
    body = Buffer.from(canonical(signed), 'utf8');
  } catch (error) {
    refuse(`${where} cannot be canonicalised (${error.message}).`);
  }
  if (!crypto.verify(null, body, key, sig)) {
    refuse(`the signature on ${where} does not verify against the pinned lab key. The certificate was altered, or was not signed by the lab.`);
  }

  if (signed.v !== 1) refuse(`unsupported certificate version v=${JSON.stringify(signed.v)}.`);
  if (signed.package !== pkg) refuse(`the certificate is for package ${JSON.stringify(signed.package)}, not ${pkg}.`);
  if (signed.version !== version) refuse(`the certificate is for version ${JSON.stringify(signed.version)}, not ${version}.`);
  if (typeof signed.commit !== 'string' || signed.commit.toLowerCase() !== commit.toLowerCase()) {
    refuse(`the certificate is for commit ${signed.commit}, but the release is commit ${commit.toLowerCase()}. Lab-run THIS commit and certify it.`);
  }
  if (!Array.isArray(signed.tests) || signed.tests.length === 0) refuse('the certificate names no lab tests.');
  const notPassed = signed.tests.filter((t) => t?.result !== 'pass');
  if (notPassed.length) refuse(`the certificate records tests that did not pass: ${notPassed.map((t) => t?.id).join(', ')}.`);

  return signed;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m || i + 1 >= argv.length) return null;
    out[m[1]] = argv[++i];
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const usage = 'usage: verify-lab-cert.mjs --package <repo> --version <x.y.z> --commit <40-char sha> --source <dir-or-url> [--public-key <file>]';
  if (!a || !PACKAGE.test(a.package ?? '') || !VERSION.test(a.version ?? '') || !SHA.test(a.commit ?? '') || !a.source) {
    console.error(usage);
    if (a?.commit !== undefined && !SHA.test(a.commit)) console.error('  --commit must be the full 40-character SHA.');
    if (a?.version !== undefined && !VERSION.test(a.version)) console.error('  --version is x.y.z, without a leading v.');
    process.exit(2);
  }

  try {
    const cert = await verify({ pkg: a.package, version: a.version, commit: a.commit, source: a.source, publicKey: a['public-key'] ?? DEFAULT_KEY });
    console.log(`verify-lab-cert: OK -- ${cert.package} ${cert.version} at ${cert.commit}: ${cert.tests.length} lab test(s) passed, ${cert.paid_runs} paid run(s), lab ${cert.lab_commit}, issued ${cert.issued_at}.`);
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `verifier error: ${error?.stack ?? error}`;
    console.error(`verify-lab-cert: REFUSED -- ${reason}`);
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
