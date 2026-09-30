# Padel Tournament Manager

A padel tournament scheduler and scoreboard for club nights: rotating-partner
("Americano"-style) play from generated schedules that are mathematically optimised
for fair mixing — every player partners every other player exactly once and opposes
everyone exactly twice, with repeat encounters spread across the evening.

**Live app: <https://kjelltillstrand.github.io/padeltournament/>**

The app is a fully static page — no backend, no accounts, no database. All state
(schedule, rounds, scores, tournament name, court names) lives in your browser's
localStorage, so a page reload or crash resumes exactly where you left off.

## Using it

1. Open the [live app](https://kjelltillstrand.github.io/padeltournament/).
2. Pick a schedule size — 8, 12, 16, 20 or 24 players (2–6 courts, everyone plays
   every round).
3. Enter player names (or keep the placeholders), optionally name your courts and
   set the points per game (24 or 32).
4. Name the tournament and start. Enter one team's score per match — the other
   team's score fills in automatically.
5. Navigate rounds with the arrows; the scoreboard ranks players by accumulated
   points with gold/silver/bronze placement colors.
6. Save, load and delete tournaments from the round header at any time.

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
npm test        # full Playwright suite (chromium, firefox, edge)
```

Playwright starts its own server on `127.0.0.1:8199` for the test suite — don't
run one there yourself; an occupied port fails fast by design.

## Repository layout

| Path | What it is |
|---|---|
| `web/` | The served app — vanilla JS/HTML/CSS, no build step. `web/index.html` is the whole app. |
| `web/schedules/` | Generated schedule tables (`8p7r.js` … `24p23r.js`). **Generated data — never hand-edit**; regenerate with `node scheduler/whist-generate.js`. |
| `web/sites/` | Per-venue UI variants (see above). |
| `scheduler/` | Schedule generators (not served). `whist-generate.js` emits the shipped perfect-whist tables and refuses to write anything that fails verification; `scheduler/engine/` is the parametrized engine for any player count / round length with an equity report. |
| `tests/` | Playwright end-to-end and property tests, tagged against the requirements manifest. |
| `docs/` | `requirements.md` (the requirements prose), `requirements-manifest.json` (the CI coverage gate's source of truth). |

## Quality gates

Every push to `main` runs the full test suite plus a requirement-coverage gate
(`.github/workflows/playwright-tests.yml`); only a green run deploys `web/` to
GitHub Pages. Schedule tables are verified for the perfect-mix property at
generation time and again in the test suite — including an exhaustive proof of the
8-player spacing bound.

## License

See [LICENSE](LICENSE).
