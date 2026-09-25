# Project: Padel Tournament Manager (padeltournament)

## Stack
- Vanilla JS/HTML/CSS static web app under `web/` — no build step. `web/index.html` +
  `web/sites/{default,libro,was}` variants, styles in `web/css/`.
- Tournament schedules are data modules in `web/schedules/` (`12p11r.js` … `24p23r.js`),
  loaded dynamically.
- `scheduler/combined.js` is the offline schedule solver (multi-run randomized pairing);
  it generates schedule data, it is not part of the served app.
- All state (schedule, rounds, scores, tournament name, court names) persists in
  browser localStorage — no backend, no database. See `docs/requirements.md`.
- Playwright end-to-end tests in `tests/`.

## Work Item Source
Mock board (file-backed board adapter): `board.env` with `BOARD_PLATFORM=mock`; state
lives in `.claude/mock-board.json` (git-ignored, machine-local, durable across
sessions). `docs/requirements.md` is the upstream requirements prose — `/refine`
from it onto the board.

## Board / Iteration
n/a — single-user mock board; no team, no iterations.

## Auth (Azure DevOps)
n/a — this project uses no Azure DevOps. The mock board is credential-free (authority
is OS-user write access to the state file).

## Repo Hosting & Git
GitHub: `KjellTillstrand/padeltournament` — use the `gh` CLI for PRs; the forge port
reads `forge.env` (github adapter). Auth is the ambient `gh auth login` session.

## Test Command
`npm test` (Playwright; CI runs the same suite via
`.github/workflows/playwright-tests.yml`)

## Lint Command
none configured

## Local Dev Setup
`npm install` once, then `npm start` (vite dev server).

## Deploy
none — static app; the Playwright workflow is the only pipeline.

## Gotchas & Patterns
- Tests exercise localStorage-persisted state; stale state bleeding between specs is
  the classic failure mode here.
- Schedule modules are generated data — regenerate via `scheduler/combined.js` rather
  than hand-editing round arrays.

## Agent Overrides
none
