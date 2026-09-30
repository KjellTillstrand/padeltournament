# Project: Padel Tournament Manager (padeltournament)

## Stack
- Vanilla JS/HTML/CSS static web app under `web/` — no build step. `web/index.html` +
  `web/sites/{default,libro,was}` variants, styles in `web/css/`.
- Tournament schedules are data modules in `web/schedules/` (`12p11r.js` … `24p23r.js`),
  loaded dynamically.
- Schedulers (none are part of the served app): `scheduler/whist-generate.js` generates
  the shipped perfect-whist tables (deterministic, self-verifying — refuses to emit an
  imperfect schedule); `scheduler/engine/` is the parametrized engine for any player
  count/round length (equitable mixing, `equity` report on every result);
  `scheduler/combined.js` is the superseded original solver, kept for history.
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
GitHub Pages, automatic: every push to `main` runs `.github/workflows/playwright-tests.yml`
("Test and deploy") — full suite + the requirement-coverage gate, then the deploy job
publishes `web/` to `gh-pages` (push-to-main only, freshness-guarded). CI/release is a
trust boundary; the workflow, its gate scripts and the requirements manifest are
gate-protected paths.

## Gotchas & Patterns
- Tests exercise localStorage-persisted state; stale state bleeding between specs is
  the classic failure mode here.
- Schedule modules are generated data — regenerate via `node scheduler/whist-generate.js <N>`
  (never hand-edit round arrays; the generator verifies the whist property and refuses
  to write otherwise). `scheduler/combined.js` is superseded.
- Playwright owns the test server: `playwright.config.js` serves `./web` on
  127.0.0.1:8199 and, with `reuseExistingServer: false`, an occupied port is a loud
  error before any test runs. Do not hand-start a server for the suite. (Port 8080
  on this machine is often held by another app, observed: VLC; testing against the
  wrong server reads as an all-red suite.)
- Board operations from inside a worktree MUST pin
  `MOCK_BOARD_STATE=<main checkout>/.claude/mock-board.json` — the mock adapter
  resolves state at the current git toplevel, which in a worktree would fork the
  board. (Adapter-level fix proposed for dotfiles-claude: resolve via
  `git rev-parse --git-common-dir`.)

## Agent Overrides
none
