#!/usr/bin/env node
// PR body check. Owner rule, 2026-11-15: every pull request description has
// three sections, in this order:
//
//   ## Why                 the problem in plain words, and what it unblocks
//   ## What changes
//   ## Who authorized it   ForceTheQuestion / council ids, and a date
//
// Zero dependencies, Node standard library only, same as third-party/.
//
// The body is UNTRUSTED DATA. It is read from the PR_BODY environment variable
// (set from the event payload by the workflow) and never from argv, so it never
// passes through a shell. No error message ever quotes it: a quoted body could
// carry a workflow command (`::add-mask::`, `::stop-commands::`, ...) into the
// runner log, so every message below is a fixed string.

import { fileURLToPath } from "node:url";

export const HEADINGS = [
  { key: "why", label: "## Why", re: /^why$/ },
  { key: "what", label: "## What changes", re: /^what changes$/ },
  { key: "who", label: "## Who authorized it", re: /^who authori[sz]ed it$/ },
];

// Whole-section placeholders, compared after lower-casing and trimming
// trailing punctuation. A section that merely CONTAINS one of these words is
// fine ("the TODO list was stale"); one that consists of nothing else is not.
const PLACEHOLDERS = new Set([
  "",
  "tbd",
  "tba",
  "todo",
  "n/a",
  "na",
  "none",
  "nothing",
  "-",
  "--",
  "...",
  "…",
  "_no response_",
  "no response",
  "placeholder",
  "wip",
  "?",
  "xxx",
  "fill in",
  "fill me in",
  "lorem ipsum",
]);

// Authorization references. `\b` before `q_` would match inside `faq_1`, since
// `_` is a word character, so the left edge is spelled out instead.
const ID_PATTERNS = [
  /(?<![A-Za-z0-9_])q_[A-Za-z0-9]{4,}(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_-])CC-fancy-\d+(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_-])G-\d+(?![A-Za-z0-9_])/,
  /(?<![A-Za-z0-9_-])owner(?![A-Za-z0-9_])/i,
];

const DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

function hasRealDate(text) {
  for (const m of text.matchAll(DATE)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === mo - 1 &&
      dt.getUTCDate() === d
    ) {
      return true;
    }
  }
  return false;
}

function stripHtmlComments(text) {
  // An unterminated comment hides the rest of the body on GitHub, so it hides
  // it here too.
  return text.replace(/<!--[\s\S]*?(-->|$)/g, "");
}

function isPlaceholder(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return true;
  return lines.every((line) => {
    const t = line.toLowerCase().replace(/[.:;!,]+$/, "").trim();
    if (PLACEHOLDERS.has(t)) return true;
    // A bracketed prompt left in place: "[fill in]", "<describe the problem>".
    if (/^\[[^\]]*\]$/.test(t) || /^<[^>]*>$/.test(t)) return true;
    return false;
  });
}

// Split the body into level-2 sections. Headings inside fenced code blocks are
// content, not structure. A `#` or `##` heading ends a section; `###` and below
// stay inside it.
function sections(body) {
  const found = [];
  let current = null;
  let fence = null;
  for (const line of body.split("\n")) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      if (current) current.lines.push(line);
      continue;
    }
    if (fence === null) {
      const h = line.match(/^ {0,3}(#{1,2})(?:[ \t]+(.*?))?[ \t#]*$/);
      if (h) {
        const title = (h[2] ?? "").trim().replace(/:$/, "").trim().toLowerCase();
        current = h[1].length === 2 ? { title, lines: [] } : null;
        if (current) found.push(current);
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  return found.map((s) => ({ title: s.title, text: s.lines.join("\n") }));
}

export function checkPrBody(raw) {
  const errors = [];
  const body = stripHtmlComments(String(raw ?? "").replace(/\r\n?/g, "\n"));

  if (body.trim() === "") {
    return {
      ok: false,
      errors: [
        "The PR body is empty. It needs three sections, in order: ## Why, ## What changes, ## Who authorized it.",
      ],
    };
  }

  const all = sections(body);
  const located = {};
  for (const h of HEADINGS) {
    const index = all.findIndex((s) => h.re.test(s.title));
    if (index === -1) {
      errors.push(`Missing the "${h.label}" heading (a level-2 heading, on its own line).`);
    } else {
      located[h.key] = { index, text: all[index].text };
    }
  }

  const present = HEADINGS.filter((h) => located[h.key]);
  for (let i = 1; i < present.length; i++) {
    if (located[present[i].key].index < located[present[i - 1].key].index) {
      errors.push(
        "The sections are out of order. They must appear as ## Why, then ## What changes, then ## Who authorized it.",
      );
      break;
    }
  }

  if (located.why && isPlaceholder(located.why.text)) {
    errors.push(
      'The "## Why" section is empty or a placeholder. Say what the problem is, in plain words, and what fixing it unblocks.',
    );
  }

  if (located.who) {
    const who = located.who.text;
    if (isPlaceholder(who)) {
      errors.push(
        'The "## Who authorized it" section is empty or a placeholder. Cite the ForceTheQuestion or council id, and the date.',
      );
    } else {
      if (!ID_PATTERNS.some((re) => re.test(who))) {
        errors.push(
          'The "## Who authorized it" section cites no authorization. Name at least one of: a ForceTheQuestion id (q_...), a council id (CC-fancy-NNNN), a G-NNN id, or the word "owner".',
        );
      }
      if (!hasRealDate(who)) {
        errors.push(
          'The "## Who authorized it" section has no date. Give the date of the authorization as YYYY-MM-DD.',
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  if (process.env.PR_BODY === undefined) {
    console.log(
      "::error::PR_BODY is not set. This check reads the PR body from the PR_BODY environment variable, set from the pull_request event payload; it does not run outside a pull_request event.",
    );
    return 1;
  }
  const { ok, errors } = checkPrBody(process.env.PR_BODY);
  if (ok) {
    console.log("PR body has ## Why, ## What changes and ## Who authorized it, with an authorization and a date.");
    return 0;
  }
  for (const e of errors) console.log(`::error::${e}`);
  console.log(
    "Edit the PR description to fix this; the check re-runs on edit. Template: https://github.com/Particle-Academy/.github/blob/main/.github/PULL_REQUEST_TEMPLATE.md",
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
