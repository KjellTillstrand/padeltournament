# Padel Tournament Manager

A padel tournament scheduler and scoreboard for club nights, in two formats:

- **Americano**: rotating partners from generated schedules optimised for fair
  mixing. With a multiple of 4 players, every player partners every other player
  exactly once and opposes everyone exactly twice, with repeat encounters spread
  across the evening. Any other count from 8 to 24 rests the surplus players each
  round, and every player rests equally often and plays the same number of games.
- **Mexicano**: one round at a time: round 1 is a random draw, and every later
  round is paired from the live standings.

**Live app: <https://kjelltillstrand.github.io/padeltournament/>**

The app is a fully static page — no backend, no accounts, no database. All state
(format, schedule, rounds, scores, tournament name, court names) lives in your
browser's localStorage, so a page reload or crash resumes exactly where you left off.

## Using it

1. Open the [live app](https://kjelltillstrand.github.io/padeltournament/).
2. Pick the format. For Americano, pick a schedule size: any count from 8 to 24
   players (2–6 courts; at a count that is not a multiple of 4 the surplus
   players rest each round). For Mexicano, pick a player count from 8 to 24.
3. Enter player names (or keep the placeholders), optionally name your courts and
   set the points per game (16, 21, 24 or 32).
4. Name the tournament and start. Enter one team's score per match — the other
   team's score fills in automatically.
5. Navigate rounds with the round buttons. In Mexicano, generate the next round
   once every match of the latest round has a complete, valid score (the two
   scores sum to the points total); earlier rounds then lock. A Mexicano
   tournament stops at 128 rounds. The scoreboard ranks players by accumulated
   points with gold/silver/bronze placement colors; two players level on points
   are ranked by their head-to-head games where that decides it, and every other
   tie shares its placement.
6. Once the tournament has started, save it with **Save Tournament** in the round
   header. Load and delete saved tournaments in the settings panel: it is shown
   during setup, and during play the **Tournament Settings** button opens it.

### Site variants

The UI can be skinned per venue with the `site` query parameter:

| Variant | URL |
|---|---|
| default | <https://kjelltillstrand.github.io/padeltournament/> |
| libro   | <https://kjelltillstrand.github.io/padeltournament/?site=libro> |
| was     | <https://kjelltillstrand.github.io/padeltournament/?site=was> |

Variants live under `web/sites/<name>/` (background, logo, court styles and
default court names). Unknown values fall back to `default`.

## Development

Requirements: Node.js ≥ 20.

```sh
npm install     # once
npm start       # vite dev server serving the app locally
npm test        # full Playwright suite (all five projects, listed below)
```

`npm test` runs five Playwright projects: `unit` (the node-only specs, run once
and without a browser), `chromium`, `firefox`, `webkit` and `Microsoft Edge`.
To run some of them, name each one and quote names with a space, for example
`npm test -- --project=webkit --project="Microsoft Edge"`. A project you don't
name doesn't run, `unit` included.

<!-- DEFERRED: AB#135 install privileges, npm ci vs install, bundled-browser wording -->
The browser projects need Playwright's bundled browsers. WebKit is part of the
gate, so install it too before a local run: `npx --no playwright install webkit`
(or `npx --no playwright install chromium firefox webkit` on a fresh machine).
Run `npm install` first: `--no` makes npx use the project's pinned Playwright
and fail rather than download another version. On Linux (Debian or Ubuntu), add
`--with-deps` to install the browsers' OS libraries too, as CI does; WebKit
does not launch without them. The `Microsoft Edge` project uses the installed
Microsoft Edge (channel `msedge`); if it is missing,
`npx --no playwright install msedge` installs it. On macOS a few
keyboard-navigation tests skip on WebKit (AB#131); CI runs them on Linux WebKit.

Playwright starts its own server on `127.0.0.1:8199` for the test suite — don't
run one there yourself; an occupied port fails fast by design. `PW_PORT` moves
that server (default `8199`; an integer from 1024 to 65535; empty means the
default), and an invalid value stops the run before any test starts. To run two
suites at once, start them from separate checkouts or worktrees — runs in one
checkout share `test-results/` and `playwright-report/` — and give each its own
port, for example `PW_PORT=8299 npm test` in the second. To use fewer parallel
workers, pass Playwright's `--workers` flag, e.g. `npm test -- --workers=2`.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The served app — vanilla JS/HTML/CSS, no build step. `web/index.html` is the whole app. |
| `web/schedules/` | Generated Americano schedule tables, one per player count (`8p7r.js` … `24p23r.js`). **Generated data — never hand-edit**; regenerate the multiples of 4 (8, 12, 16, 20, 24) with `node scheduler/whist-generate.js` and the other twelve counts (9–23) with `node scheduler/engine/sitout-generate.mjs`. |
| `web/sites/` | Per-venue UI variants (see above). |
| `scheduler/` | Schedule generators (not served). `whist-generate.js` emits the shipped perfect-whist tables (multiples of 4); `engine/sitout-generate.mjs` emits the shipped rest-round tables (every other count from 9 to 23) from the engine; both refuse to write anything that fails verification. `scheduler/engine/` is the parametrized engine for any player count / round length with an equity report. |
| `tests/` | Playwright end-to-end and property tests, tagged against the requirements manifest. |
| `docs/` | `requirements.md` (the requirements prose), `requirements-manifest.json` (the CI coverage gate's source of truth). |

## Quality gates

Every push to `main` runs the full test suite plus a requirement-coverage gate
(`.github/workflows/playwright-tests.yml`); only a green run deploys `web/` to
GitHub Pages. Schedule tables are verified at generation time and again in the
test suite: the multiples of 4 for the perfect-mix property (including an
exhaustive proof of the 8-player spacing bound), the other counts for equal rests,
equal games, no repeated partner and opponent counts within one of each other.

## License

See [LICENSE](LICENSE).
