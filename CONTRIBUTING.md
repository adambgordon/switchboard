# Contributing

## Overview

- **`main` is protected** — every change lands via a pull request. Branch off `main`, push your branch, and open a PR.
- The maintainer ([@adambgordon](https://github.com/adambgordon)) reviews and **squash-merges**, so each change is one commit on `main`.

## Before opening a PR

- `npm run typecheck` — must be clean (`tsc` over the main and renderer projects).
- `npm test` — must pass (vitest unit suites).
- For UI changes, run `npm run dev` and check your change in **both light and dark themes** (the title-bar sun/moon toggles them) — the app is theme-aware, and a cue that reads in one theme can vanish in the other.
- Match the existing style: TypeScript strict, 2-space indent, no semicolons, named exports.

## Where things live

- [`README.md`](README.md) → **Develop** for the dev loop, the multi-instance dev trick, and the quality gates.
- [`docs/architecture.md`](docs/architecture.md) (module map + state), [`docs/design.md`](docs/design.md) (visual / UX invariants), and [`docs/gotchas.md`](docs/gotchas.md) (subsystem traps) — read the relevant one before a non-trivial change.
