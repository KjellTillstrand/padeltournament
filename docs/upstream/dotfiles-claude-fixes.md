# dotfiles-claude fix register

Defects and mechanism proposals found while running the dotfiles-claude harness
(drain, refine, retro, hooks, ports) on this repository, recorded here to be
delivered upstream. This repo cannot fix them: they live in dotfiles-claude.

**How to deliver:** each entry is shaped like a dotfiles-claude Story (Goal /
Problem / Evidence / Mechanism / Target / Verify). Paste an entry, or the whole
file, into a `/refine` session in dotfiles-claude as the plan. Then update the
entry's **Status** line here with the upstream id (`filed as AB#NNN`) and, once
it ships, the PR. Don't delete delivered entries: mark them `delivered` so the
history stays readable.

Every entry names a **mechanism** (a gate, a verification step, or a process
step), never prose alone, per the retro rule (REQ-490).

| ID | Title | Mechanism | Status |
|----|-------|-----------|--------|
| DF-1 | Drain writes "Deployed" without verifying the deploy | verification-step | open |
| DF-2 | Worktree teardown fails after a squash merge, so worktrees accumulate | process-step | open |
| DF-3 | Worktree-isolation guard false-positives on paths containing `git` | gate (matcher fix) | open |
| DF-4 | Drain requires `scripts/forge/queue.sh`, which onboarding never provisioned | process-step (onboarding) | open (operator in progress) |
| DF-5 | Mock board adapter forks the board when run from a worktree | gate (adapter fix) | open |
| DF-6 | Mock board `create_item` leaves a new item's state null | gate (adapter fix) | open |
| DF-7 | Review re-checks resumed by message lose their isolated worktree | process-step | open |
| DF-8 | `/code-review` given a branch name reviews nothing and reports nothing | process-step | open |
| DF-9 | `install.sh --check` fails on every `/model` switch, tripping drain preflight | gate (check fix) | open |
| DF-10 | Drain parent roll-up names states the mock board doesn't have | process-step | open |
| DF-11 | Specialists start overlapping full-suite runs | verification-step | open |

---

## DF-1: Drain writes "Deployed" without verifying the deploy

- **Status:** open
- **Source:** retro of drain-491-closeout, 2026-10-03 (padeltournament AB#56, AB#57)
- **Goal:** a work item is written back as Deployed only after its change is
  proven live.
- **Problem:** drain §2g writes the final state once the PR merges. Nothing
  checks that the post-merge deploy ran. The drain's own write-back text
  assumed it ("deploy runs on the main push").
- **Evidence:**
  - Run `36765228696` (2026-09-30 19:22) sat in `waiting` on the `github-pages`
    environment for 3 days. It held concurrency group `deploy-gh-pages`
    (`cancel-in-progress: false`), so 7 later deploy jobs queued and were
    cancelled.
  - AB#52–57 and AB#61 were marked Deployed while the live site was still at
    the 2026-09-30 18:34 build.
  - The problem was found by the retro, not by the drain. It cleared once that
    run was cancelled; Pages deployment `6825791067` for `1879f03` then
    succeeded.
- **Mechanism (verification-step):** add a post-land step to drain §2g.
  1. Find the default-branch push run for the merge commit.
  2. Wait for it to conclude.
  3. Require the deploy job to report `success` and a deployment status of
     `success` for that sha. On GitHub that is
     `repos/{o}/{r}/deployments?sha=…`, then `/statuses`.
  4. Only then write Deployed.
  5. A deploy that is cancelled, errors, or sits waiting longer than a
     configured bound (default 30 minutes) is a **systemic blocker**. Write
     back "Merged — deploy unverified" and stop the batch.

  The check belongs behind the forge port (`get_deployment <sha>` or similar),
  so the drain never calls `gh` directly. The project declares whether it
  deploys at all, for example `forge.env DEPLOY_ENVIRONMENT=github-pages`. With
  nothing declared, it records "no deploy declared" instead of guessing.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2g,
  `home/skills/drain/references/board-ops.md` § Write-back, the forge port and
  its github adapter, `docs/forge-port.md`.
- **Verify:** a bats or fixture test in which a mock forge reports the
  deployment as `cancelled` or `waiting`. The drain write-back must then refuse
  Deployed. The test must go red with the check removed (falsify.sh).
- **More evidence (drain-491-closeout, 2026-10-04..07):** this drain ran the check
  by hand for all four items (AB#68, #58, #62, #59). For each one it watched the
  main-push run to `success` and read the `github-pages` deployment status for
  the merge sha before writing Deployed. The deploy succeeded every time, so the
  check worked, but it lives only in the operator's head until the drain does it.
- **Downstream:** padeltournament AB#65 adds an independent hourly freshness
  monitor in this repo. The two are complementary: the drain check covers its
  own landings, and the monitor covers everything else.

## DF-2: Worktree teardown fails after a squash merge, so worktrees accumulate

- **Status:** open
- **Source:** drain-491-closeout teardown, 2026-10-03
- **Goal:** every drained item's worktree is removed once its content is on the
  default branch, and so is every reviewer's worktree.
- **Problem:** after a squash merge, the item branch's commits are not on main
  by hash. So `ExitWorktree remove` refuses ("Worktree has 2 commits … will
  discard this work permanently"), and teardown needs a human every time. The
  reviewer and security-reviewer worktrees created by §2e
  (`isolation: worktree`) end on a detached HEAD and are never torn down.
- **Evidence:** `git worktree list` in padeltournament on 2026-10-03 shows 17
  leftover worktrees from earlier drains:
  - `wt-ab19` … `wt-ab35`, the `chore+…` and `feat+…` drain worktrees;
  - `agent-ab9aa0cd…` and `agent-ae05b8b7…`, the two reviewer worktrees.
- **Mechanism (process-step):** in drain §2g teardown:
  1. Compare the item's content against the default branch, for example with
     `git fetch origin && git diff --quiet HEAD origin/<default>` (empty means
     the content landed).
  2. On exit 0, `ExitWorktree remove` with `discard_changes: true` is
     authorized by the drain. The content is proven landed, so no human
     confirmation is needed.
  3. Otherwise keep the worktree and report it.
  4. Also tear down each review agent's worktree once its verdict is recorded.
     Those worktrees are read-only by contract, so they hold nothing.

  A `/new-wi` or drain preflight check that lists stale worktrees (branch
  merged or content on the default branch) and offers cleanup closes the
  backlog.
- **More evidence (drain-491-closeout):** all four item worktrees came down
  cleanly with the content-on-main comparison proposed above. Each time,
  `git diff --quiet HEAD origin/main` was run (or limited to the item's own files
  when an unrelated commit, the Dependabot bump #32, had landed in between).
  `ExitWorktree remove` with `discard_changes: true` followed, so the proposed
  mechanism holds in practice.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2e/§2g,
  `home/skills/drain/references/change-flow.md`, `home/skills/new-wi/`.
- **Verify:** a fixture repo with a squash-merged branch: teardown removes the
  worktree without prompting. A fixture whose content differs from main:
  teardown keeps the worktree and reports it.

## DF-3: Worktree-isolation guard false-positives on paths containing `git`

- **Status:** open (confirm first whether the guard is dotfiles-claude's or
  built into Claude Code; if built in, send it as Claude Code feedback)
- **Source:** drain-491-closeout session, 2026-10-03
- **Goal:** the worktree-isolation guard blocks real git operations aimed
  outside the worktree, and nothing else.
- **Problem:** this checkout lives under `/Users/<user>/git/padeltournament`.
  The guard refuses ordinary commands whose text contains `git` only inside a
  path, as in these examples:
  - `node -e 'require("/Users/…/git/padeltournament/.claude/mock-board.json")'`
  - `gh run view … --jq '.[1].databaseId'`
  - `jq … | grep padeltournament`
  - multi-line `export MOCK_BOARD_STATE=/Users/…/git/…; bash port.sh …`

  The refusals say "names git in a form too complex to verify". Every one had
  to be rewritten, and some work moved to a scratchpad copy of the board.
- **Evidence:** at least 8 refused Bash calls in this session. None of them ran
  git.
- **More evidence (drain-491-closeout, 2026-10-04..07):** at least 6 more refusals,
  in two new shapes:
  - Any `$(...)` command substitution, for example
    `--description-html "$(cat <file>)"` or `D=$(mktemp -d) && …`, was refused as
    "too complex to verify", even when no git was involved.
  - A multi-line `export MOCK_BOARD_STATE=<path containing /git/>` followed by a
    port call was refused, while the same command on one line with an inline env
    prefix passed.

  Effect: creating a board item (AB#69) from inside an item worktree was
  impossible, so it waited until the worktree was gone. Review agents also lost
  the ability to run scratch mutation checks.
- **Mechanism (gate fix):** match `git` as a command token (argv[0], or after
  `;`, `&&`, `|` or `$(`), not as a substring of a path argument. Keep the
  refusal for `git -C <outside>`, `--git-dir` and `--work-tree`.
- **Target:** the worktree-isolation hook (dotfiles-claude `home/hooks/…`, if
  it is the harness's).
- **Verify:** hook tests:
  - commands with `/x/git/y` path arguments, and a `--jq` filter containing
    `[1]`, are allowed;
  - `git -C /outside status` and `cd /outside && git commit` are still refused.

## DF-4: Drain requires `scripts/forge/queue.sh`, which onboarding never provisioned

- **Status:** open, with the operator fixing it in dotfiles-claude.
  `/onboard-project` now describes provisioning "the delivery path a drain
  publishes through (forge.env plus a recorded landing route)". Confirm this
  covers repos that were already onboarded.
- **Source:** drain-491-closeout, 2026-10-03
- **Goal:** a drained change can land on the default branch only through the
  route the drain prescribes, and that route exists in every onboarded repo.
- **Problem:** drain §2f says `bash scripts/forge/queue.sh integrate` is the
  only route onto the default branch. This repo has no `scripts/forge/`. AB#56
  (PR #29) and AB#57 (PR #30) landed through the forge port's
  `land_proposal --strategy squash`, which the operator authorized each time.
  So the "only route" rule is unenforced here.
- **Mechanism (process-step + preflight gate):** have `/onboard-project`
  provision the queue, or record a declared alternative landing route, for
  example `forge.env LANDING_ROUTE=forge-port-squash`. Make drain preflight §0
  check that the declared route exists. A missing route is a systemic blocker
  at preflight, not a surprise at §2f.
- **Target (dotfiles-claude):** `home/skills/onboard-project/`,
  `home/skills/drain/SKILL.md` §0 and §2f,
  `home/skills/drain/references/change-flow.md`.
- **Verify:** a fixture repo without the queue and without a declared route:
  drain preflight stops before claiming anything.

## DF-5: Mock board adapter forks the board when run from a worktree

- **Status:** open (already noted in this repo's `.claude/CLAUDE.md` Gotchas)
- **Goal:** board operations from any worktree read and write the one board.
- **Problem:** the mock adapter resolves `.claude/mock-board.json` at the
  current git toplevel. In a worktree that is the worktree, which forks the
  board. The workaround is to pin `MOCK_BOARD_STATE=<main checkout>/…` on every
  call. That workaround also collides with DF-3: the pinned path contains
  `git`, which triggers refusals.
- **Mechanism (gate fix):** resolve the state path from
  `git rev-parse --git-common-dir`, which is the main checkout's `.git` from
  every linked worktree.
- **Target (dotfiles-claude):** `home/boards/mock.sh` (installed as
  `~/.claude/boards/mock.sh`).
- **Verify:** an adapter test that runs a claim from a linked worktree. The
  claim must appear in the main checkout's state file, and no state file may be
  created in the worktree.

## DF-6: Mock board `create_item` leaves a new item's state null

- **Status:** open
- **Source:** drain-491-closeout, 2026-10-04 (padeltournament AB#68)
- **Goal:** a newly created delivery item is claimable at once, in the profile's
  ready state.
- **Problem:** `_adapter_create_item` writes `state: $s.state`, which is null
  unless the caller passes `--field System.State=…`. The next `claim_item` then
  exits 1 ("not claimable (state=none, owner=none)"). That reads as "another
  runner won", the skip signal, not as a broken item.
- **Evidence:** AB#68 was created without State, and its claim returned 1 with
  `state=none`. It needed a manual `update_item 68 --state New`. Confirmed on
  dotfiles-claude `origin/main` (`scripts/boards/mock.sh`, the create path's
  `state: $s.state`).
- **Mechanism (gate, adapter fix):** default a created item's state to the
  process profile's initial state for its type (`New` for stories). Reject a
  create that would store a null state.
- **Target (dotfiles-claude):** `scripts/boards/mock.sh` `_adapter_create_item`.
- **Verify:** an adapter test where `create_item` with no State field stores
  `New`, and `claim_item` on it exits 0.

## DF-7: Review re-checks resumed by message lose their isolated worktree

- **Status:** open (confirm whether the cleanup is Claude Code's own behaviour.
  If so, also send it as Claude Code feedback.)
- **Source:** drain-491-closeout, AB#58 and AB#59 fix rounds, 2026-10-05..06
- **Goal:** every review pass, including a re-check after a fix round, reads from
  its own worktree and never from the writer's.
- **Problem:** drain §2e dispatches reviewers with `isolation: worktree`. An
  unchanged worktree is cleaned up when the agent finishes. When the drain
  resumed the same reviewer by message for a fix-round re-check, that worktree
  was gone. The agent's shell then sat in the writer's worktree, which breaks the
  one-writer rule in `parallel.md`. The work stayed read-only, using only
  `git show`, `diff` and `log`, but nothing enforced that.
- **Evidence:** this happened three times. The AB#58 security re-check said
  "the environment moved me to … feat+mexicano-pairing-module…", and the AB#59
  reviewer and security re-checks both said their own worktree had been removed
  mid-task.
- **Mechanism (process-step):** in drain §2e, a re-review after a fix round is
  always a **fresh** dispatch with `isolation: worktree`, carrying the prior
  verdict as context. It is never a message-resume of the earlier agent. A
  validate-config rule can check that the skill text sets this.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2e,
  `home/skills/drain/references/parallel.md` § The reviewer reads.
- **Verify:** a skill-text conformance assertion that §2e names "fresh dispatch"
  for re-reviews.

## DF-8: `/code-review` given a branch name reviews nothing and reports nothing

- **Status:** open (built into Claude Code, so it is also queued as product
  feedback)
- **Source:** drain-491-closeout, AB#68 and AB#58, 2026-10-05
- **Goal:** the native code-review pass in drain §2e reviews the item's real diff,
  every time.
- **Problem:** `/code-review low <branch-name>` finished in about 4–6 s with one
  tool call and output `(none)`, on a 12-line diff and on a 310-line diff. That is
  indistinguishable from "no findings". The same skill given the PR number
  (`/code-review medium 34`, `35`, `36`) did real reviews in 40–120 s.
- **Mechanism (process-step):** run drain §2e's `/code-review` **after** the
  proposal exists, against the PR number. Alternatively, keep it before the
  proposal but treat a result with no review text as "not run", never as "no
  findings".
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2e (ordering) and
  §2f.
- **Verify:** a skill-text assertion that §2e names the PR-number form.

## DF-9: `install.sh --check` fails on every `/model` switch, tripping drain preflight

- **Status:** open
- **Source:** drain-491-closeout preflight, 2026-10-04
- **Goal:** the runtime-currency check fails on real drift (stale hooks, agents
  or permissions), not on the operator's own model choice.
- **Problem:** `/model` rewrites `~/.claude/settings.json`, which `install.sh`
  generates. `--check` then reports "differs from what install.sh would
  generate", and drain §0 treats that as a systemic blocker. The only fixes are
  editing `settings.machine.json` or re-running the installer. The installer
  silently reverts the model choice, and the classifier blocked the agent from
  investigating its own config.
- **Evidence:** the only difference was the `model` key. Clearing it took the
  operator re-running `install.sh` by hand.
- **Mechanism (gate fix):** in `--check`, compare settings with the
  machine-overlay keys (`model`, `effortLevel`, `tui`) excluded, or report their
  drift as a warning. Policy-bearing keys (hooks, permissions, sandbox) stay hard
  failures.
- **Target (dotfiles-claude):** `scripts/install.sh` `check` (settings
  comparison).
- **Verify:** a bats test where a settings.json differing only in `model` passes
  `--check` with a warning, and one differing in `permissions.ask` fails.

## DF-10: Drain parent roll-up names states the mock board doesn't have

- **Status:** open
- **Source:** drain-491-closeout end-of-drain roll-up, 2026-10-07
- **Goal:** the parent roll-up writes states the active board accepts.
- **Problem:** `board-ops.md` § Parent state roll-up maps to
  `Closed`/`Resolved`/`Active`/`New`, but the mock board's states are
  `New`/`InDevelopment`/`Deployed`/`Released`/`Review`/`Approved`. The drain had
  to invent a mapping (all children Deployed → `Deployed`; some children past New
  → `InDevelopment`) for Features #49–#51 and Epic #48.
- **Mechanism (process-step):** read the roll-up targets from the process
  profile (`states.featureDone`, `states.featureActive`, …). Make the board's
  `validate-board-structure.sh` fail when a profile lacks them.
- **Target (dotfiles-claude):** `home/skills/drain/references/board-ops.md`
  § Parent state roll-up; `scripts/boards/default-process.json` and the mock
  profile.
- **Verify:** a fixture board with a mock profile where the roll-up writes only
  states from that profile.

## DF-11: Specialists start overlapping full-suite runs

- **Status:** open
- **Source:** drain-491-closeout, AB#62 test-writer, 2026-10-05
- **Goal:** each item's bar is one clean, unshared run.
- **Problem:** the test-writer's `npm test` hit its 600 s tool timeout and was
  relaunched in the background while earlier runs may still have been alive. Its
  reported runs took 11–17 min with 9 failed-then-passed tests. The drain's own
  solo run of the same commit took 2.7 min with 0 retries. Concurrent runs can't
  share Playwright's fixed port 8199, so overlap shows up as noise or as a
  confusing red.
- **Mechanism (verification-step):** the drain's specialist handoff runs the bar
  only through a wrapper that takes an exclusive lock, either a lockfile in the
  worktree or `verification-bar.sh`. It runs in the background by default and
  reports the result of one complete run. The drain also requires the bar it
  records to be its **own** solo run, which this drain did by hand.
- **Target (dotfiles-claude):** `home/skills/drain/references/handoff.md`
  (Verify), `scripts/drain/verification-bar.sh`.
- **Verify:** start two bars on one worktree; the second waits or refuses, and
  never runs concurrently.
