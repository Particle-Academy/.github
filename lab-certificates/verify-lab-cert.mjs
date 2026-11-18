#!/usr/bin/env node
// verify-lab-cert.mjs -- refuse a release that has no valid lab-run certificate.
//
//   node verify-lab-cert.mjs --package holy-sheet-js --version 2.11.0 \
//        --commit <40-char sha> --source <dir-or-url> [--keys <file>]
//
// Exit 0 ONLY when the certificate exists, its Ed25519 signature verifies
// against a key in the pinned key list that was valid for it, and its package,
// version and commit are the ones being released. Exit 1 with the reason
// otherwise. Exit 2 on bad usage.
//
// ## A failed lookup is a failure
//
// A network error, a timeout, an HTTP 500 and a 404 all refuse. A gate that
// passes when it cannot see is a gate that passes whenever it is offline, which
// is exactly when nobody is looking. The reason is printed, so a refusal can be
// diagnosed rather than bypassed.
//
// ## The keys are PINNED
//
// `lab-cert-keys.json` beside this file is a copy of the lab's committed
// `lab-cert-keys.json`. It is never fetched from the same place as the
// certificate: a source that could serve both could sign anything. `--keys`
// exists for tests.
//
// ## Key rotation (.ai/plans/lab-cert-key-rotation.md)
//
// A record names its key with `key_id` inside the signed body; a record with
// none (everything issued before key ids) resolves to the one key marked
// `unlabelled`. A key verifies a record only when:
//
//   - the signature verifies against THAT key;
//   - `issued_at` lies in the key's window, not_before <= issued_at < not_after;
//   - for a RETIRED key (one with `frozen_signatures`), the record's signature
//     is one the key had already made when it was retired.
//
// The last rule is the one that matters. `issued_at` is written by whoever
// holds the key, so a window alone would let a leaked key sign a certificate
// dated before its retirement. The frozen list is what it actually signed.
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
export const DEFAULT_KEYS = path.join(here, 'lab-cert-keys.json');
const SHA = /^[0-9a-f]{40}$/i;
const KEY_ID = /^ed25519:[0-9a-f]{16}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DIGEST = /^[0-9a-f]{64}$/;
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

// The key id the lab derives: `ed25519:` + 16 hex of sha256 over the raw key.
export function keyIdFor(raw) {
  return 'ed25519:' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// The pinned key list, every entry checked. Any flaw refuses the whole list: a
// list that is half-read is a list whose other half is silently trusted.
export function loadKeys(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    refuse(`the pinned key list is missing (${file}). Nothing can be verified without it -- NOT a pass.`);
  }
  const bad = (why) => refuse(`the pinned key list at ${file} is invalid: ${why}. Nothing was verified -- NOT a pass.`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    bad('not JSON');
  }
  if (doc === null || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.keys) || doc.keys.length === 0) bad('it needs v:1 and a non-empty keys array');

  const seen = new Set();
  const keys = doc.keys.map((k, i) => {
    if (k === null || typeof k !== 'object') bad(`key ${i} is not an object`);
    const raw = typeof k.public_key === 'string' ? Buffer.from(k.public_key, 'base64') : Buffer.alloc(0);
    if (raw.length !== 32 || raw.toString('base64') !== k.public_key) bad(`key ${i} has no base64 Ed25519 public_key`);
    if (typeof k.id !== 'string' || !KEY_ID.test(k.id) || k.id !== keyIdFor(raw)) bad(`key ${i}'s id ${JSON.stringify(k.id)} is not its public key's (${keyIdFor(raw)})`);
    if (seen.has(k.id)) bad(`key ${k.id} is listed twice`);
    seen.add(k.id);
    for (const edge of ['not_before', 'not_after']) {
      if (k[edge] !== null && k[edge] !== undefined && !(typeof k[edge] === 'string' && INSTANT.test(k[edge]))) bad(`key ${k.id} ${edge} is not null or YYYY-MM-DDTHH:MM:SSZ`);
    }
    if (k.unlabelled !== undefined && typeof k.unlabelled !== 'boolean') bad(`key ${k.id} unlabelled is not a boolean`);
    let frozen = null;
    if (k.frozen_signatures !== undefined) {
      if (!Array.isArray(k.frozen_signatures) || !k.frozen_signatures.every((d) => typeof d === 'string' && DIGEST.test(d))) bad(`key ${k.id} frozen_signatures is not a list of sha256 hex digests`);
      frozen = new Set(k.frozen_signatures);
    }
    return {
      id: k.id,
      publicKeyB64: k.public_key,
      key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }),
      notBefore: k.not_before ?? null,
      notAfter: k.not_after ?? null,
      unlabelled: k.unlabelled === true,
      frozen,
    };
  });
  if (keys.filter((k) => k.unlabelled).length > 1) bad('more than one key is unlabelled');
  return keys;
}

// The file's text, or null when it is ABSENT (HTTP 404, ENOENT). Every other
// outcome -- a network error, a timeout, any other status, an unreadable file --
// refuses here, so a caller can never mistake "could not look" for "not there".
async function load(source, pkg, name) {
  if (/^https?:\/\//i.test(source)) {
    const url = `${source.replace(/\/+$/, '')}/${pkg}/${name}`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs()), redirect: 'follow' });
    } catch (error) {
      refuse(`could not fetch ${url} (${error?.cause?.code ?? error?.name ?? 'error'}: ${error?.cause?.message ?? error?.message}). A failed lookup is NOT a pass.`);
    }
    if (res.status === 404) return { text: null, where: url, absent: `${url} is 404` };
    if (!res.ok) refuse(`could not fetch ${url}: HTTP ${res.status}. A failed lookup is NOT a pass.`);
    let text;
    try {
      text = await res.text();
    } catch (error) {
      refuse(`could not read the body of ${url} (${error?.name ?? 'error'}: ${error?.message}). A failed lookup is NOT a pass.`);
    }
    return { text, where: url };
  }

  const file = path.join(source, pkg, name);
  try {
    return { text: fs.readFileSync(file, 'utf8'), where: file };
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null, where: file, absent: `${file} does not exist` };
    refuse(`could not read ${file} (${error.code}). A failed lookup is NOT a pass.`);
  }
  return null;
}

// Tests shorten it to prove a timeout refuses. It can only make the gate
// refuse sooner or wait longer; no value makes a lookup pass.
function timeoutMs() {
  const n = Number(process.env.VERIFY_LAB_CERT_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : TIMEOUT_MS;
}

// Parse, then verify the detached signature against the key the record names,
// inside that key's window and, for a retired key, its frozen signatures. Until
// all of that holds, nothing else in the file is evidence.
function signedRecord(text, where, keys, what) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    refuse(`${where} is not JSON, so it is not ${what}.`);
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) refuse(`${where} is not ${what} object.`);

  const { signature, ...signed } = record;
  const sig = typeof signature === 'string' ? Buffer.from(signature, 'base64') : Buffer.alloc(0);
  if (sig.length !== 64) refuse(`${where} has no valid Ed25519 signature field.`);

  let body;
  try {
    body = Buffer.from(canonical(signed), 'utf8');
  } catch (error) {
    refuse(`${where} cannot be canonicalised (${error.message}).`);
  }
  let key;
  if (Object.hasOwn(signed, 'key_id')) {
    key = keys.find((k) => k.id === signed.key_id);
    if (!key) refuse(`${where} names an unknown key ${JSON.stringify(signed.key_id)}; the pinned key list has ${keys.map((k) => k.id).join(', ')}.`);
  } else {
    key = keys.find((k) => k.unlabelled);
    if (!key) refuse(`${where} names no key_id, and the pinned key list has no unlabelled key.`);
  }

  if (!crypto.verify(null, body, key.key, sig)) {
    refuse(`the signature on ${where} does not verify against the pinned lab key ${key.id}. It was altered, or was not signed by the lab.`);
  }

  const at = signed.issued_at;
  if (typeof at !== 'string' || !INSTANT.test(at)) refuse(`${where} has no issued_at of the form YYYY-MM-DDTHH:MM:SSZ (${JSON.stringify(at)}), so no key window can be checked.`);
  if (key.notBefore !== null && at < key.notBefore) refuse(`${where} was issued at ${at}, before key ${key.id} is valid (${key.notBefore}).`);
  if (key.notAfter !== null && at >= key.notAfter) refuse(`${where} was issued at ${at}, after key ${key.id} was retired (${key.notAfter}).`);
  if (key.frozen !== null) {
    const digest = crypto.createHash('sha256').update(sig).digest('hex');
    if (!key.frozen.has(digest)) {
      refuse(`${where} is signed by the retired key ${key.id} but is not one the retired key had made before ${key.notAfter ?? 'it was retired'}. A retired key signs nothing new, whatever date the record claims.`);
    }
  }
  return { ...signed, verified_key: key.id };
}

// `<package>/exempt.json`, written by `lab:exempt`: a supporting package that is
// not part of the kit releases without a certificate. Consulted ONLY when the
// certificate is absent -- a certificate that is present is judged on its own,
// so an exemption can never paper over a forged or wrong-commit certificate.
function verifyExemption(text, where, keys, pkg) {
  const signed = signedRecord(text, where, keys, 'an exemption');
  if (signed.kind !== 'exemption') refuse(`${where} is not an exemption (kind=${JSON.stringify(signed.kind)}).`);
  if (signed.v !== 1) refuse(`unsupported exemption version v=${JSON.stringify(signed.v)}.`);
  if (signed.package !== pkg) refuse(`the exemption is for package ${JSON.stringify(signed.package)}, not ${pkg}.`);
  if (signed.revoked === true) refuse(`the exemption for ${pkg} was revoked (${JSON.stringify(signed.reason)}, ${signed.issued_at}). It needs a lab certificate.`);
  if (signed.revoked !== false) refuse(`the exemption for ${pkg} does not say it is unrevoked (revoked=${JSON.stringify(signed.revoked)}), so it does not count.`);
  if (typeof signed.reason !== 'string' || signed.reason.trim() === '') refuse(`the exemption for ${pkg} carries no reason, so it does not count.`);
  if (typeof signed.issued_at !== 'string') refuse(`the exemption for ${pkg} has no issued_at.`);
  return signed;
}

export async function verify({ pkg, version, commit, source, keysFile = DEFAULT_KEYS }) {
  const keys = loadKeys(keysFile);
  const { text, where, absent } = await load(source, pkg, `${version}.json`);

  if (text === null) {
    const ex = await load(source, pkg, 'exempt.json');
    if (ex.text === null) {
      refuse(`no certificate for ${pkg} ${version}: ${absent}, and no exemption (${ex.absent}). Run the lab suite on this commit and \`php artisan lab:certify\` it.`);
    }
    return verifyExemption(ex.text, ex.where, keys, pkg);
  }

  const signed = signedRecord(text, where, keys, 'a certificate');

  if (signed.kind !== undefined) refuse(`${where} is not a certificate (kind=${JSON.stringify(signed.kind)}).`);
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
  const usage = 'usage: verify-lab-cert.mjs --package <repo> --version <x.y.z> --commit <40-char sha> --source <dir-or-url> [--keys <file>]';
  if (!a || !PACKAGE.test(a.package ?? '') || !VERSION.test(a.version ?? '') || !SHA.test(a.commit ?? '') || !a.source) {
    console.error(usage);
    if (a?.commit !== undefined && !SHA.test(a.commit)) console.error('  --commit must be the full 40-character SHA.');
    if (a?.version !== undefined && !VERSION.test(a.version)) console.error('  --version is x.y.z, without a leading v.');
    process.exit(2);
  }

  try {
    const cert = await verify({ pkg: a.package, version: a.version, commit: a.commit, source: a.source, keysFile: a.keys ?? DEFAULT_KEYS });
    if (cert.kind === 'exemption') {
      console.log(`verify-lab-cert: EXEMPT -- ${cert.package}: ${cert.reason} (issued ${cert.issued_at}, lab ${cert.lab_commit}, key ${cert.verified_key}). No lab certificate for ${a.version}; the lab exempts this package.`);
      return;
    }
    console.log(`verify-lab-cert: OK -- ${cert.package} ${cert.version} at ${cert.commit}: ${cert.tests.length} lab test(s) passed, ${cert.paid_runs} paid run(s), lab ${cert.lab_commit}, issued ${cert.issued_at}, key ${cert.verified_key}.`);
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `verifier error: ${error?.stack ?? error}`;
    console.error(`verify-lab-cert: REFUSED -- ${reason}`);
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
