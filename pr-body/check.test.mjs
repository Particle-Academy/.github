import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkPrBody } from "./check.mjs";

const CLI = fileURLToPath(new URL("./check.mjs", import.meta.url));

const GOOD = [
  "## Why",
  "",
  "Release notes never said what broke, so consumers upgraded blind.",
  "",
  "## What changes",
  "",
  "- adds a checker",
  "",
  "## Who authorized it",
  "",
  "ForceTheQuestion q_922b2bf0, 2026-11-15.",
].join("\n");

function body({ why, what, who } = {}) {
  return [
    "## Why",
    why ?? "Something is broken and this fixes it.",
    "## What changes",
    what ?? "- one thing",
    "## Who authorized it",
    who ?? "Owner, 2026-11-15.",
  ].join("\n");
}

function failsWith(text, pattern) {
  const r = checkPrBody(text);
  assert.equal(r.ok, false, "expected the body to be refused");
  assert.ok(
    r.errors.some((e) => pattern.test(e)),
    `no error matched ${pattern}; got: ${JSON.stringify(r.errors)}`,
  );
}

test("a body with all three sections and an id plus a date passes", () => {
  assert.deepEqual(checkPrBody(GOOD), { ok: true, errors: [] });
});

test("an empty or missing body is refused", () => {
  failsWith("", /empty/i);
  failsWith("   \n\n", /empty/i);
  failsWith(undefined, /empty/i);
  failsWith(null, /empty/i);
});

for (const heading of ["Why", "What changes", "Who authorized it"]) {
  test(`a body missing "## ${heading}" is refused, naming it`, () => {
    const text = GOOD.replace(`## ${heading}`, `## Something else`);
    failsWith(text, new RegExp(`## ${heading}`));
  });
}

test("headings out of order are refused", () => {
  const text = [
    "## What changes",
    "- one thing",
    "## Why",
    "Because.",
    "## Who authorized it",
    "Owner, 2026-11-15.",
  ].join("\n");
  failsWith(text, /order/i);
});

test("a heading at the wrong level does not count", () => {
  failsWith(GOOD.replace("## Why", "### Why"), /## Why/);
  failsWith(GOOD.replace("## Why", "Why"), /## Why/);
});

test("headings match case-insensitively, with an optional trailing colon", () => {
  const text = GOOD.replace("## Why", "## why:").replace(
    "## Who authorized it",
    "## WHO AUTHORIZED IT",
  );
  assert.equal(checkPrBody(text).ok, true);
});

test("the British spelling 'authorised' is accepted", () => {
  const text = GOOD.replace("## Who authorized it", "## Who authorised it");
  assert.equal(checkPrBody(text).ok, true);
});

test("CRLF line endings are handled", () => {
  assert.equal(checkPrBody(GOOD.replace(/\n/g, "\r\n")).ok, true);
});

test("an empty Why section is refused", () => {
  failsWith(body({ why: "" }), /Why.*empty/i);
  failsWith(body({ why: "   \n  " }), /Why.*empty/i);
});

test("a Why section holding only the template's HTML comment is empty", () => {
  failsWith(
    body({ why: "<!-- The problem in plain words. -->" }),
    /Why.*empty/i,
  );
});

test("a multi-line HTML comment does not count as content", () => {
  failsWith(body({ why: "<!--\nexplain\nthis\n-->" }), /Why.*empty/i);
});

for (const placeholder of [
  "TBD",
  "tbd.",
  "TODO",
  "N/A",
  "none",
  "-",
  "...",
  "…",
  "_No response_",
  "placeholder",
  "WIP",
  "?",
  "[fill in]",
  "<describe the problem>",
]) {
  test(`a Why of only "${placeholder}" is refused as a placeholder`, () => {
    failsWith(body({ why: placeholder }), /Why.*(empty|placeholder)/i);
  });
}

test("a placeholder in Who is refused", () => {
  failsWith(body({ who: "TBD" }), /Who.*(empty|placeholder)/i);
  failsWith(body({ who: "" }), /Who.*(empty|placeholder)/i);
});

test("a real Why that merely contains a placeholder word still passes", () => {
  assert.equal(
    checkPrBody(body({ why: "The TODO list in the README was stale." })).ok,
    true,
  );
});

test("Who citing a ForceTheQuestion id and a date passes", () => {
  assert.equal(checkPrBody(body({ who: "q_922b2bf0 on 2026-11-15" })).ok, true);
});

test("Who citing a council id and a date passes", () => {
  assert.equal(checkPrBody(body({ who: "CC-fancy-0042, 2026-11-15" })).ok, true);
});

test("Who citing a G- id and a date passes", () => {
  assert.equal(checkPrBody(body({ who: "G-123 (2026-11-15)" })).ok, true);
});

test("Who citing the owner and a date passes", () => {
  assert.equal(checkPrBody(body({ who: "The owner, in chat, 2026-11-15." })).ok, true);
});

test("Who with prose but no id and no 'owner' is refused", () => {
  failsWith(
    body({ who: "Approved by the team on 2026-11-15." }),
    /q_|CC-fancy|G-|owner/,
  );
});

test("Who citing the owner with no date is refused", () => {
  failsWith(body({ who: "The owner said yes." }), /date/i);
});

test("Who citing an id with no date is refused", () => {
  failsWith(body({ who: "q_922b2bf0" }), /date/i);
});

test("an impossible date does not count as a date", () => {
  failsWith(body({ who: "owner, 2026-13-45" }), /date/i);
});

test("look-alike ids do not count", () => {
  // 'q_' alone, a council id for another project, a G- with no digits, and
  // 'owners' / 'codeowner' are not the word 'owner'.
  for (const who of [
    "q_ on 2026-11-15",
    "CC-prism-0042, 2026-11-15",
    "G-abc, 2026-11-15",
    "codeowners, 2026-11-15",
    "faq_123 on 2026-11-15",
  ]) {
    failsWith(body({ who }), /q_|CC-fancy|G-|owner/);
  }
});

test("an id inside an HTML comment in Who does not count", () => {
  failsWith(
    body({ who: "<!-- e.g. q_922b2bf0, 2026-11-15 -->" }),
    /Who.*(empty|placeholder)/i,
  );
});

test("an id cited in Why does not satisfy Who", () => {
  failsWith(
    body({ why: "Asked in q_922b2bf0 on 2026-11-15.", who: "Approved." }),
    /q_|CC-fancy|G-|owner/,
  );
});

test("headings inside a fenced code block are ignored", () => {
  const text = [
    "## Why",
    "Example below.",
    "```md",
    "## What changes",
    "## Who authorized it",
    "owner 2026-11-15",
    "```",
  ].join("\n");
  failsWith(text, /## What changes/);
});

test("a later section ends Who, so its content cannot satisfy Who", () => {
  const text = body({ who: "Approved." }) + "\n## Checklist\n- owner 2026-11-15";
  failsWith(text, /q_|CC-fancy|G-|owner/);
});

test("a ### subheading stays inside its section", () => {
  const text = body({ who: "### Record\nq_922b2bf0, 2026-11-15" });
  assert.equal(checkPrBody(text).ok, true);
});

test("errors are fixed strings and never echo the body", () => {
  // The body is untrusted. An error that quoted it could carry a workflow
  // command (::set-output, ::add-mask, ...) straight into the runner's log.
  const hostile = "::error::pwned\n::set-env name=X::y";
  const r = checkPrBody(`## Why\n${hostile}\n## What changes\n## Who authorized it\n${hostile}`);
  assert.equal(r.ok, false);
  for (const e of r.errors) assert.ok(!e.includes("pwned") && !e.includes("set-env"), e);
});

// The org PR template is what most authors start from. Its headings must be the
// ones this checker looks for, or every PR opened from it fails on a heading
// nobody can see is wrong -- and left unfilled, it must NOT pass.

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

test("the shipped PR template has every required heading, in order", () => {
  const r = checkPrBody(TEMPLATE);
  assert.ok(
    !r.errors.some((e) => /Missing the|out of order/.test(e)),
    JSON.stringify(r.errors),
  );
});

test("the shipped PR template, left unfilled, is refused", () => {
  const r = checkPrBody(TEMPLATE);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Why.*empty/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /Who.*empty/.test(e)), JSON.stringify(r.errors));
});

test("the shipped PR template, filled in, passes", () => {
  const filled = TEMPLATE.replace(
    "## Why\n",
    "## Why\nThe gate was silent on empty bodies.\n",
  ).replace("## Who authorized it\n", "## Who authorized it\nq_922b2bf0, 2026-11-15\n");
  assert.notEqual(filled, TEMPLATE, "the fill-in replacements matched nothing");
  assert.deepEqual(checkPrBody(filled).errors, []);
});

// CLI: reads the body from the PR_BODY environment variable only.

function runCli(env) {
  return spawnSync(process.execPath, [CLI], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("CLI exits 0 for a good body read from PR_BODY", () => {
  const r = runCli({ PR_BODY: GOOD });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("CLI exits 1 and prints ::error:: annotations for a bad body", () => {
  const r = runCli({ PR_BODY: "## Why\nTBD" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^::error::/m);
});

test("CLI exits 1 when PR_BODY is unset, rather than passing vacuously", () => {
  const r = runCli({});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /PR_BODY/);
});

test("CLI does not take the body from argv", () => {
  // A body passed as an argument would have travelled through a shell.
  const r = spawnSync(process.execPath, [CLI, GOOD], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
});
