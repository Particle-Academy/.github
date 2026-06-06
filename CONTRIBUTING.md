# Contributing to Fancy UI

Thanks for wanting to build with us. **Fancy UI** is Particle Academy's suite
of UI primitives engineered for **Human+ UX** — applications where humans and
agents share the same UI surface, trading control fluidly through MCP tool
bridges instead of DOM scraping.

These guidelines apply org-wide to every Particle Academy repository (GitHub
applies this `.github` repo's defaults to any repo that lacks its own). A few
packages carry repo-specific notes in their own `CONTRIBUTING.md` or
`CLAUDE.md` — when present, those take precedence.

---

## Ways to contribute

You don't have to write code to move the suite forward:

- **File an issue** — bug reports and well-scoped feature requests are gold.
  Use the issue forms (Bug report / Feature request) so we get the details we
  need on the first pass.
- **Open a pull request** — fix a bug, sharpen the docs, add a test, or land a
  feature. See [Working in a package](#working-in-a-package) below.
- **Propose a new component** — Fancy UI grows by adding primitives that earn
  their place. Open a feature request describing the primitive, the props
  surface a human *and* an agent would author against, and how it satisfies the
  [Human+ component contract](#the-human-component-contract). Generic beats
  themed: each primitive should be a reusable building block, not a one-app
  widget.
- **Register your project** — built something with Fancy UI? Tell us. We
  showcase community projects, and registering yours is the first step toward
  the badge below.
- **Wear the badge** — shipping with Fancy UI? Add the **Powered by Fancy UI**
  badge to your README:

  ```md
  [![Powered by Fancy UI](https://img.shields.io/badge/Powered%20by-Fancy%20UI-6d28d9)](https://github.com/Particle-Academy)
  ```

---

## The repo model — one repo per package

**There is no monorepo.** Each package in the suite is its own independent,
public git repository with its own release cadence, its own issue tracker, and
its own `LICENSE`. They are peers, not submodules. A non-exhaustive map:

| Package | What it is |
|---|---|
| `react-fancy` | Core React component library (stays raw React) |
| `fancy-3d` (+ `-babylon`, `-three`) | Engine-agnostic 3D core + engine adapters |
| `fancy-echarts` | React wrapper around Apache ECharts |
| `fancy-code` / `fancy-sheets` / `fancy-flow` | Code editor / spreadsheet / workflow editor |
| `fancy-slides` / `fancy-whiteboard` / `fancy-artboard` | Decks / whiteboard / design canvas |
| `fancy-diff` / `fancy-motion` / `fancy-screens` | Diff viewer / timeline / screen registry |
| `fancy-inertia` / `fancy-query` / `fancy-cms-ui` | Inertia bridge / server-state / CMS editor |
| `agent-integrations` | MCP server + per-package bridges |
| `laravel-catalog` / `laravel-fms` / `laravel-fun-lab` / `fancy-cms` | PHP packages (Composer) |
| `holy-sheet` / `dark-slide` (+ `-js` ports) | xlsx / pptx writers for agentic docs |

**To contribute to a package, clone that specific repo — not "the suite."**
A change that spans two packages is two separate pull requests (see
[One PR per repo](#one-pr-per-repo)).

JS/TS packages publish to **npm** under `@particle-academy/*`; PHP packages
publish to **Packagist** under `particle-academy/*`. Consumers install from
those registries like any external app would.

---

## Working in a package

### TypeScript / JavaScript packages

```bash
git clone https://github.com/Particle-Academy/<package>.git
cd <package>
npm install
npm run dev          # or: tsup --watch  (drives the package's own demos)
npm run build        # ESM + CJS + DTS via tsup
npm run lint         # type-check (tsc --noEmit)
```

Each TS package iterates in **isolation** against its own demos — you don't
need the showcase site to develop a primitive. Write your change, run the
watch build, exercise it in the package's demo.

### PHP packages (Composer)

```bash
git clone https://github.com/Particle-Academy/<package>.git
cd <package>
composer install
php artisan test --compact     # Pest; or: vendor/bin/pest
vendor/bin/pint --dirty        # format changed files (REQUIRED before pushing)
```

Tests are **Pest** — prefer feature tests, use factories and their states, and
use datasets for validation testing.

### The showcase

The public showcase (`px-ui-sandbox`) consumes the packages from npm/Packagist
like any external app — it has no source aliases to sibling packages, so it
won't pick up your local package change until that change is **published by a
maintainer** and the showcase's dependency is bumped. Develop against the
package's own demos; don't expect edit-and-see across the showcase boundary.

---

## Code style

- **Match the surrounding code.** Check sibling files for structure, naming,
  and patterns before introducing your own. Consistency beats cleverness.
- **PHP:** run `vendor/bin/pint --dirty` before every push. Always use curly
  braces for control structures, constructor property promotion, explicit
  return types and type hints, and PHPDoc over inline comments.
- **TypeScript:** explicit types on all exports; `interface` for props
  (extend the native HTML attributes and `Omit` conflicts); keep `tsc
  --noEmit` clean. Tailwind v4 only — `@import "tailwindcss"`, CSS-first
  `@theme` config, no deprecated opacity utilities. **No `<flux:*>`.**
- **Zero third-party runtime dependencies.** This is a hard rule across the
  suite. Packages are self-contained — algorithms run in-house, in-browser.
  A small set of sanctioned peers/externals (e.g. `react`, `tailwindcss`,
  react-fancy itself, `lucide-react` as react-fancy's icon library) is the
  ceiling, not an invitation. If you think you need a new runtime dependency,
  open an issue first — the answer is almost always "write it in-house."

### The Human+ component contract

Every **stateful or interactive** component must satisfy both constraints:

1. **Authoring surface** — humans *and* agents can rapidly compose beautiful,
   well-functioning apps with it. Terse props, JSON-friendly inputs, sensible
   defaults, good types.
2. **Inhabited surface** — the running app embeds agents as first-class
   participants. Agents read/write component state via MCP bridges and stable
   handles, **not** Playwright or DOM scraping. The component itself is the
   agent's affordance.

Concretely, a stateful/interactive component must meet all of:

- **Controlled state** — `value` + `onChange`. No internal-only state for
  anything an agent might read or write.
- **Stable handles** — each interactive element has a stable identity (`id`,
  `data-*`, or a selector prop). Agents never guess DOM.
- **JSON-friendly inputs** — arrays of objects, primitives, simple
  discriminated unions. Avoid forcing React children for things an agent must
  populate.
- **Bridgeable surface** — a `register<Surface>Bridge(server, { adapter })`
  exists or could be sketched in one sitting, exposing MCP tools
  (`grid_paint`, `chip_reclassify`, …).
- **Observable activity** — mutations broadcast `AgentActivity` events so
  presence, undo, and coaching layers compose for free.
- **Trust-but-verify hooks** — destructive or human-visible actions support a
  `pendingMode` / staged-write affordance: agents propose, humans confirm.

Purely visual primitives (static label, divider, layout shell) owe only
constraint #1. Anything stateful or interactive owes both. The canonical,
always-current version of this contract lives in the workspace guide:
[**Component contract**](https://github.com/Particle-Academy/fancy-ui/blob/main/CLAUDE.md#component-contract).

---

## Commit & PR conventions

### Conventional Commits

Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(slider): add range mode with two thumbs
fix(modal): restore focus to trigger on close
docs(diff): document the unified-diff partial limitation
test(catalog): cover one-time price checkout
chore: bump dev tooling
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`.

### One PR per repo

A change that spans two packages (say, a `react-fancy` prop that `fancy-slides`
then consumes) is **two pull requests**, one in each repo, plus — if it touches
the showcase — a showcase commit once both land. Coordinate the order in your
PR descriptions and link them to each other.

### Keep PRs focused

- One logical change per PR. Don't bundle a refactor with a feature.
- **Write tests.** PHP changes need Pest coverage; TS changes need their demo
  updated and, where there's a test setup, a test. A bug fix should come with a
  test that fails before and passes after.
- Update the docs alongside the code — the package README and any `docs/*.md`
  that describe the surface you changed. Don't wait to be asked.
- Run the formatter / type-check and make sure the build is green before you
  request review.
- Fill out the pull request template checklist honestly.

### Versioning & releases are the maintainers' job

**Contributors do not bump versions, create tags, or publish.** Don't edit the
`version` field in `package.json` / `composer.json`, and don't push tags.
Maintainers handle the release flow and decide when changes ship to npm /
Packagist. Just land your change behind a clean PR; we'll cut the release.

---

## A friendly note on rewards

The public showcase is gamified. Bug reports, merged PRs, accepted new
components, and registered projects can earn **XP, levels, and achievements**.
You don't contribute *for* the points — but they're a fun way to track your
footprint across the suite, and a nice excuse to come back and build more.

---

## Code of Conduct

Participation in any Particle Academy repo is governed by our
[Code of Conduct](./CODE_OF_CONDUCT.md). Be kind, be constructive, assume good
faith.

## Security

Found a vulnerability? **Don't open a public issue.** Follow the responsible
disclosure process in [SECURITY.md](./SECURITY.md).

## License

Each repository is MIT-licensed; see that repo's own `LICENSE` file for the
authoritative text. By contributing, you agree your contribution is licensed
under the same terms as the repository you're contributing to.
