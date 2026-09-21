// Does the allowlist gate actually BLOCK the install, or merely run beside it?
//
// A check that finishes after the thing it guards is a report, not a gate: by
// the time a parallel `third-party` job reports, `npm ci` has already executed
// the package's install lifecycle scripts and pip has already run a build
// backend on the runner. Raised by the Prism estate, 2026-09-21.
//
// Two rules were replaced to answer this properly, and both were the same
// mistake -- a claim about behaviour that nothing checked:
//
//   1. WHICH workflows need the gate was decided by FILENAME (publish, ci,
//      test). That is a stand-in for "probably installs dependencies", and it
//      decayed the moment a file was renamed. Thirteen PHP changelog gates
//      became publish.yml and produced 21 false warnings, while five repos
//      whose install workflows were named build.yml, conformance.yml,
//      dogfood.yml and static.yml had been ungated the whole time and reported
//      clean.
//
//   2. WHETHER a job was gated was decided per FILE, so a gate anywhere in the
//      file covered every job in it -- including jobs that could not wait for
//      it.
//
// NO THIRD-PARTY DEPENDENCIES, matching check.mjs. The subset of YAML that
// workflows use is regular enough to read by indent, and taking a YAML parser
// to inspect the dependency gate would be its own small joke.

const GATE_MARKER = 'third-party/check.mjs';

// What the file DOES, not what it is called.
const INSTALLS =
  /(composer\s+(install|update|require)|npm\s+(ci|install)|pnpm\s+(install|add)|yarn\s+(install|add)|pip\s+install|uv\s+(sync|pip)|poetry\s+install|cargo\s+(build|fetch))/;

/**
 * Read one workflow into `{ job: { needs, steps, text } }`.
 *
 * Only the shape this question needs: job names, their `needs` in all three
 * spellings GitHub accepts (scalar, inline list, block list), and their steps
 * in order.
 */
export function parseWorkflowJobs(text) {
  const jobs = {};
  let inJobs = false;
  let cur = null;
  let needsBlock = false;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');

    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // A non-indented key ends the jobs mapping.
    if (/^\S/.test(line)) {
      inJobs = false;
      continue;
    }

    const head = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (head) {
      cur = head[1];
      jobs[cur] = { needs: [], steps: [], text: '' };
      needsBlock = false;
      continue;
    }
    if (!cur) continue;
    jobs[cur].text += line + '\n';

    const inlineNeeds = line.match(/^ {4}needs:\s*(.+)$/);
    if (inlineNeeds) {
      jobs[cur].needs.push(
        ...inlineNeeds[1]
          .replace(/[[\]'"]/g, '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      );
      needsBlock = false;
      continue;
    }
    if (/^ {4}needs:\s*$/.test(line)) {
      needsBlock = true;
      continue;
    }
    if (needsBlock) {
      const item = line.match(/^ {6}-\s*(.+)$/);
      if (item) {
        jobs[cur].needs.push(item[1].replace(/['"]/g, '').trim());
        continue;
      }
      needsBlock = false;
    }

    if (/^ {6}- /.test(line)) jobs[cur].steps.push(line + '\n');
    else if (jobs[cur].steps.length) jobs[cur].steps[jobs[cur].steps.length - 1] += line + '\n';
  }
  return jobs;
}

/**
 * The names of jobs in this workflow that install third-party code without the
 * gate having already passed.
 *
 * Blocked means: the check runs EARLIER IN THE SAME JOB, or this job depends --
 * directly or TRANSITIVELY -- on a job that runs it.
 *
 * The transitive part is load-bearing and was measured, not assumed. `needs` is
 * transitive in Actions: a job cannot start until everything upstream has
 * succeeded. A direct-edge-only check called fancy-conformance's
 * `cross-language` ungated when it needs four jobs that each need `allowlist`,
 * and it would have sent someone to "fix" a job that was already correct.
 */
/**
 * Drop whole-line comments before asking what a step does.
 *
 * Without this the detector reads COMMENTARY as behaviour. Measured the hour it
 * was written: `pa-ux-sandbox/dogfood.yml` was reported ungated because the
 * comment introducing its gate says "this job INSTALLS -- composer install and
 * npm ci below". The words were in a comment attached to `actions/checkout`, so
 * the checkout step counted as an install occurring BEFORE the gate.
 *
 * Both YAML comments and shell comments inside a `run:` block start a line with
 * `#`, and neither is executed, so one rule covers both. Trailing `#` is left
 * alone: a real command can precede one.
 */
function executable(step) {
  return step
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

export function ungatedJobs(text) {
  const jobs = parseWorkflowJobs(text);
  const gateJobs = new Set(
    Object.keys(jobs).filter((n) => executable(jobs[n].text).includes(GATE_MARKER)),
  );

  const reachesGate = (name, seen = new Set()) => {
    for (const up of jobs[name]?.needs || []) {
      if (seen.has(up)) continue;
      seen.add(up);
      if (gateJobs.has(up)) return true;
      if (reachesGate(up, seen)) return true;
    }
    return false;
  };

  const ungated = [];
  for (const [name, job] of Object.entries(jobs)) {
    const installAt = job.steps.findIndex((st) => INSTALLS.test(executable(st)));
    if (installAt === -1) continue;
    const gateAt = job.steps.findIndex((st) => executable(st).includes(GATE_MARKER));
    if (gateAt !== -1 && gateAt < installAt) continue;
    if (reachesGate(name)) continue;
    ungated.push(name);
  }
  return ungated;
}

export { GATE_MARKER, INSTALLS };
