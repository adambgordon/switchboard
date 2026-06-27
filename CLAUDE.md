# Switchboard — project guide

A macOS Electron app — light or dark theme — that browses AI coding-agent conversations from both **Claude Code and Codex**: read-only transcript preview, resume/new into a real terminal (node-pty + xterm.js), a live "Formatted" view, and pinning. The layout is two columns — a single unified left pane (Pinned / Live / Recent conversations) and a main pane. **All conversation data is derived from the session files each agent writes — Claude Code's JSONL under `~/.claude/projects/`, Codex's rollouts under `~/.codex/sessions/`** — Switchboard never owns it. The one exception is **rename** — and even that writes through each agent's *own* store, never a Switchboard one: Claude Code gets the same `custom-title` line `/rename` writes (real, survives into `claude --resume`); Codex's rename calls the app-server `thread/name/set`, which updates Codex's own `state_*.sqlite` (`threads.title`). See the **Multi-agent (Codex)** + **Conversation rename + info modal** pointers in [docs/architecture.md](docs/architecture.md).

Stack: Electron 42 (pinned as `latest`, so it tracks upstream) · electron-vite · React 18 + Vite · TypeScript (strict) · plain CSS · node-pty · chokidar · @xterm/xterm · react-markdown · fuse.js. No Tailwind, no state library (plain hooks + localStorage).

## Set up Switchboard (first run)

When the user asks to **"Set up Switchboard"** (typically from a fresh clone — this is the phrase the public README's "Set up" section points them at), run the one-shot setup and then open the built app:

```bash
npm run setup
open dist/mac-arm64/Switchboard.app
```

`npm run setup` (= `scripts/setup.mjs`) installs dependencies, rebuilds `node-pty` for Electron's ABI, and packages `dist/mac-arm64/Switchboard.app` — but it does **not** launch the app, so always follow it with `open`. If it fails on a missing prerequisite (Xcode Command Line Tools, or Node 26 — see `.nvmrc`), walk the user through installing it, then re-run.

## Update Switchboard

When the user asks to **"Update Switchboard"** (the phrase the public README's "Updates" section points them at), pull the latest and re-run the one-shot build, then reopen:

```bash
git pull
npm run setup
open dist/mac-arm64/Switchboard.app
```

`npm run setup` rebuilds `dist/mac-arm64/Switchboard.app` from the pulled source (deps + `node-pty` + package). Tell the user to **quit (⌘Q) any running instance first** — `open` only focuses an already-running app, so a stale instance won't pick up the new build otherwise. If `git pull` reports local changes/conflicts or the build fails on a prerequisite, surface that rather than forcing past it.

## Build, validate, run

Full first-run setup, the dev loop, and the contributor quality gates live in README → **Develop**; this section is the **validate-before-done** checklist. The building blocks (run individually as needed):
1. `npm run typecheck` — `tsc` over BOTH projects (main = node, renderer = web). Must be clean.
2. `npm run build` — `electron-vite build` → `out/`. Must succeed. **Does NOT update the `.app`** — `out/` is what the **boot smoke check** consumes (so run `build` first); `npm run dev` runs its own build, and the packaged `.app` is separate.
3. **Boot smoke:** `SWITCHBOARD_SMOKE=1 node_modules/.bin/electron .` — prints `SMOKE PASS | pty:true | window:loaded`. The only headless check that node-pty loads/spawns under Electron's ABI and the renderer loads. `window:none` is a sampling race (re-run); only `did-fail-load` / `preload-error` lines indicate a real failure.
4. `npm test` — vitest over `test/` (12 suites: main-side parser/indexer/rename/customTitle/windowState + renderer-lib liveness/theme/navHistory/pins/clipboard/findMatches/messageGroups). The renderer UI is not unit-tested.
5. `npm run package` — `electron-vite build` + `electron-builder --dir`, rebuilding the installed `dist/mac-arm64/Switchboard.app`. `npm run build` alone does NOT do this. Quit (⌘Q) and reopen the app to load it.

For iterating, `npm run dev` (hot reload) is the inner loop (first run / after an Electron bump: `npm run rebuild` first — node-pty must match Electron's ABI; see `docs/gotchas.md`). The renderer (visual feel, live terminal, drag/scroll) can only be truly verified by a human running `npm run dev` or the freshly-packaged `.app` — typecheck/build/smoke don't catch React-runtime or visual issues. Say so rather than claiming the UI works.

Set `SWITCHBOARD_DEV_LABEL=<name>` before `npm run dev` to tag the window title **and** the title bar (a mono pill left of the gear) — so several dev instances can run side by side and stay tellable apart (there's no single-instance lock; Vite auto-increments the port). Unset in normal and packaged runs, where the title stays a plain "Switchboard".

## Deep reference (read on demand)

The detailed implementation lore lives in `docs/` so it isn't loaded into every session. Mention the relevant path and the file is pulled in on demand — these are intentionally *not* `@`-imported (which would re-expand them into context). Read the one that covers what you're about to touch:

- **[`docs/architecture.md`](docs/architecture.md)** — module map, the IPC contract (`src/shared/types.ts`), main-process layout, renderer state hooks, the liveness model, the rename / info modal, navigation & focus, Preferences, find-in-conversation, tooltips, theming. *Read before touching `src/main/**`, IPC, or any renderer state/behavior — liveness, navigation/focus, find, theming, modals.*
- **[`docs/gotchas.md`](docs/gotchas.md)** — subsystem traps that have bitten before: node-pty rebuild, the ⌘R-refresh custom menu, terminal/xterm rendering (WebGL/canvas, lineHeight, Unicode v11, cursor, hidden-repaint, the 0×0-resize trap, initial-fit ordering), font warming, packaging, localStorage, the macOS Option key. *Read before touching the terminal, the menu, fonts, the build, or the Formatted view.*
- **[`docs/design.md`](docs/design.md)** — visual & UX invariants: the two-accent color system, row controls, stable-key ordering, single-family type, preview≠spawn, the read-only Formatted view, transcript rendering, design tokens, the two-theme rules. *Read before any change to visual appearance — CSS, color, layout, the two-accent / two-theme rules.*

## Conventions

- **Two agents, like two themes.** Switchboard supports BOTH **Claude Code and Codex**; every change must work for — and be considered for — both, the same bar as light/dark. Anything agent-specific branches on `ConversationMeta.agent`; the seam is the main-process agent split (`sessions/{parser,codexParser,codexThreadsDb,rename,codexRename}`, dual-root `indexer`/`watcher`, per-agent `pty/manager` boot). See the two-agent invariant in [docs/design.md](docs/design.md) and the **Multi-agent (Codex)** section in [docs/architecture.md](docs/architecture.md).
- TypeScript strict; 2-space indent; no semicolons (match `src/shared/types.ts`). Prefer named exports. No formatter is configured.
- Main/preload imports are relative; the renderer uses the `@shared` / `@renderer` aliases.
- **Testing:** unit tests live in `test/` (vitest) and cover **pure logic only** — main-process parsing/indexing plus renderer-lib helpers pulled out of components (`liveness`, `theme`, `navHistory`, `pins`/`reorderArray`, `clipboard`, `findMatches`, `messageGroups`); the **renderer UI is not unit-tested**. Keep pure logic in `lib/` so it's importable under the **node** tsconfig (no DOM lib) — a test-imported module must not touch `window`/`document` (why `theme.ts` is pure and the DOM half is `themeDom.ts`; see Theming in `docs/architecture.md`).
- Repo-wide test/build is cheap here; to iterate on one suite use `npx vitest run test/<name>.test.ts` or `npm run test:watch`.
