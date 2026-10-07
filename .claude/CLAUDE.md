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
uploads `web/` as a Pages artifact and publishes it with `actions/deploy-pages` to the
`github-pages` environment (push-to-main only, freshness-guarded; the Pages source is
"GitHub Actions" — the old `gh-pages` branch is no longer published to, though not yet
deleted). CI/release is a trust boundary; the workflow, its gate scripts and the
requirements manifest are gate-protected paths.

## Delivery Path
PR + required CI. Drained PRs target `main` and land only once the `Test and deploy`
workflow checks on the PR are green. "Required" is by process: `main` has no branch
protection or ruleset, so GitHub does not enforce it. The forge port's `land_proposal`
still refuses mechanically when checks are failing, pending, absent (CI not started) or
unreadable, or when a review requests changes. So a drain must wait for the PR's CI to
report before landing.
- No integration queue: this repo has no `scripts/forge/queue.sh`. Do not copy one in.
  Queue adoption is tracked upstream as dotfiles-claude AB#666.
- The drain proposes with `~/.claude/forge/port.sh propose_change <branch> --base main
  --title <t> --body-file <f>` (all four are required) and lands with the forge port's
  `land_proposal <id> --strategy squash`. `land_proposal` is under `permissions.ask`, so
  the operator approves every merge (the ask rule matches the `~/.claude/forge/port.sh`
  spelling; use that spelling).
- Recorded 2026-10-04, AB#68. This records the landing route asked for by DF-4 in
  `docs/upstream/dotfiles-claude-fixes.md` (prose only; no `forge.env` declaration yet).

## Governance
Declared in `.claude/gate.json`: profile `adopting` (R1), with the `tracking` dial
overridden to `board` (the mock board above). Without the key the harness resolves to
`regulated` (R3): its adoption preflight would refuse this repo's drains (no harness
manifest yet), and its landing route is a queue this repo lacks.
What each relaxed R1 dial does here:
- `adoption=warn`: adoption gaps are announced at the drain's batch gate, not refused.
- `coverage=record`: the harness dial only records. The real, blocking control is this
  repo's own CI requirement-coverage gate (`scripts/check-req-coverage.mjs`, see Deploy).
- `landing=pr-ci`: as in Delivery Path.
- `containment=throwaway-home`: no effect here. Containment applies only inside the
  integration queue, which this repo lacks.
- `batch_approval=auto-allowed` by profile, but the drain still BLOCKS `--auto` while
  adoption is incomplete (`adopted=false`). The operator approves batches interactively
  by practice. Merge approval is mechanical (`land_proposal` under `permissions.ask`).
- `runtime_currency=advisory` by profile: no harness hook enforces it for this repo, but
  drain §0 still requires `install.sh --check` to exit 0 before claiming anything. A
  failing check is a stop.
- Recorded 2026-10-07, AB#78. The resolver's standing warning ("gated but resolves to
  rung R1 …") is expected while on R1. Promotion to R2 follows AB#79.
- Full adoption is AB#79: the harness's `.claude/requirements.json` manifest, plus making
  the adoption checker recognise this repo's `R-TAG:` test titles. Until then the checker
  sees only six stray `REQ-<n>` ids (`@verifies` comments) and would generate a
  misleading manifest, so none is committed.

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
