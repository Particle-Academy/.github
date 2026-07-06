# Particle Academy

**A Civicognita initiative.** Particle Academy is a non-profit **Community Support
Service** building **stronger communities** through holistic education — **career
building**, **wellness training**, and **entrepreneurship evangelism**, with
entrepreneurship as the vehicle for personal & professional transformation.
**Digital today, and gearing up for a physical entrepreneurship center.**
→ [particle.academy](https://particle.academy)

This GitHub org is also **where our open-source engineering lives** — the tools we
build to teach with and to give the community a Human+ foundation.

## 🧩 Fancy UI

A constellation of small, independent UI packages for **Human+ UX**: applications
where humans and agents share the same UI surface and trade control fluidly through
MCP tool bridges, never DOM scraping.

- ~50 React primitives in `react-fancy`, plus specialized editors — sheets, slides,
  flow, code, whiteboard, diff, 3D, and more
- Every interactive surface ships an **MCP bridge**, so agents are first-class
  participants rather than external scripts
- Laravel / PHP packages for catalog, feature management, gamification, and agentic
  document generation
- **Fancy Pixel** + **Fancy Heuristics** for "Powered by Fancy UI" verification
  badges and human-and-agent behavioural analytics

Each package is its own public repo, published to npm (`@particle-academy/*`) and
Packagist (`particle-academy/*`). Explore the kit at
[ui.particle.academy](https://ui.particle.academy).

## 🔷 Prism — Laravel LLM package

We maintain the community fork of
**[Prism](https://github.com/Particle-Academy/prism)** — the fluent Laravel
interface for working with LLMs (text generation, multi-step conversations, tools,
structured output). After upstream
[`prism-php/prism`](https://github.com/prism-php/prism) went unmaintained (March
2026), Particle Academy continues its development as a **drop-in replacement** (the
`Prism\Prism` namespace is unchanged):

```bash
composer require particle-academy/prism
```

Docs: [prismphp.com](https://prismphp.com).

## 🤝 Contributing

**New here?** Read
[CONTRIBUTING.md](https://github.com/Particle-Academy/.github/blob/main/CONTRIBUTING.md)
and come build something.
