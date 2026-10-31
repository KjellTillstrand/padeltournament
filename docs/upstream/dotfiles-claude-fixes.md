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
| DF-3 | Worktree-isolation guard false-positives on paths containing `git` | Claude Code feedback (matcher fix); accepted risk on the harness side | open |
| DF-4 | Drain requires `scripts/forge/queue.sh`, which onboarding never provisioned | process-step + preflight gate | open (operator in progress) |
| DF-5 | Mock board adapter forks the board when run from a worktree | gate (adapter fix) | open |
| DF-6 | Mock board `create_item` leaves a new item's state null | gate (adapter fix) | open |
| DF-7 | Review re-checks resumed by message lose their isolated worktree | process-step | open |
| DF-8 | `/code-review` given a branch name reviews nothing and reports nothing | process-step | open |
| DF-9 | `install.sh --check` fails on every `/model` switch, tripping drain preflight | gate (check fix) | open |
| DF-10 | Drain parent roll-up names states the mock board doesn't have | process-step + gate | open |
| DF-11 | A specialist's self-reported bar isn't the bar the drain records | verification-step | open |
| DF-12 | `check-batch-belongs.sh` passes an empty batch | gate (script fix) | open |
| DF-13 | The forge port can't update a proposal's description | gate (port op) | open |
| DF-14 | Refinement doesn't assess impact on persisted data | process-step | open |
| DF-15 | Parallel tracks: the session still moves per track, and shared local resources have no lock | process-step | open |
| DF-16 | A local test bar run under heavy machine load fails spuriously | verification-step | open |
| DF-17 | A review pass detached the writer's worktree | gate + process-step | open |
| DF-18 | A long drain keeps running a skill the harness has since changed | process-step | open |
| DF-19 | Item target files miss the tests a rename or refactor must touch | verification-step | open |
| DF-20 | Nothing lists the tagged tests a diff touches, so the annotation audit input is hand-made | gate (script) | open |
| DF-21 | Drain working state lives in a session scratchpad that can disappear | process-step | open |
| DF-22 | Comments and docs claim more than the code does, in most items | process-step + gate (AB#709) | open |
| DF-23 | Port scripts are committed non-executable, so direct-exec `ask` spellings never match | gate (mode + install check) | filed as AB#773 |
| DF-24 | The mock board has no way to clear an item's owner, so a released item can't be claimed | gate (port op) | open |
| DF-25 | `--check-batch-id` checks the format of the id, not that it is this batch's | verification-step | open |
| DF-26 | A Claude Code runtime directory inside a harness skill fails `install.sh --check` | gate (check fix) | open |
| DF-27 | The implementer's `git commit` is denied every round, so the operator commits by hand | process-step | open |
| DF-28 | The resume note goes stale between sessions and outgrows a single read | process-step | open |
| DF-29 | Later review rounds reopen trade-offs an earlier round settled | process-step | open |

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
- **Downstream:** padeltournament AB#65 (in development) will add an independent hourly freshness
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
  1. Compare the item's **own paths** against the default branch. A whole-tree
     diff fails as soon as an unrelated commit lands on the default branch.
     First, `git status --porcelain` must be empty: a commit-to-commit diff
     can't see uncommitted or untracked files, and step 2 discards them.
     Then `git fetch origin`, take
     `paths = git diff --name-only --no-renames <merge-base HEAD origin/<default>> HEAD`
     (without `--no-renames` a rename's old path is never compared), and run
     `git diff --quiet HEAD origin/<default> -- <paths>`. Empty means the item's
     content landed.
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
  cleanly with a content-on-main comparison followed by `ExitWorktree remove`
  with `discard_changes: true`. A whole-tree `git diff --quiet HEAD origin/main`
  was **not** enough. For AB#68 it exited 1 because the Dependabot bump #32 had
  landed on main in the meantime, and the comparison had to be narrowed to the
  item's own files by hand. That is why step 1 above compares only the item's
  own paths.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2e/§2g,
  `home/skills/drain/references/change-flow.md`, `home/skills/new-wi/`.
- **Verify:** a fixture repo with a squash-merged branch: teardown removes the
  worktree without prompting. A fixture whose content differs from main:
  teardown keeps the worktree and reports it.

## DF-3: Worktree-isolation guard false-positives on paths containing `git`

- **Status:** open. Answered 2026-10-17: the guard is built into Claude Code
  (no dotfiles-claude file produces its message), so the matcher fix below is
  Claude Code feedback, not a harness change. On the harness side this is an
  accepted risk (see **Harness side**).
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
- **Mechanism (Claude Code feedback, matcher fix):** match `git` as a command
  token (argv[0], or after `;`, `&&`, `|` or `$(`), not as a substring of a path
  argument. Keep the refusal for `git -C <outside>`, `--git-dir` and
  `--work-tree`.
- **Target:** Claude Code feedback. The guard is built into Claude Code, not a
  dotfiles-claude hook.
- **Harness side (accepted risk):** dotfiles-claude has no reliable workaround.
  - `scripts/drain/*` is not projected under `~/.claude`.
  - A projected path was refused too, under the `.`-in-a-construct rule.

  The drain lives with the refusals by doing board, scope and teardown steps
  from the main checkout after `ExitWorktree`, whenever no writer is live, as
  this batch did. Reason for accepting rather than building a harness
  mechanism: the defect is in Claude Code, and the cost seen here was minutes
  per refusal. Revisit if the matcher fix is declined.
- **More evidence (batch 2, 2026-10-08..10):** the guard refused agents' inline
  Playwright lock loop (`until mkdir "$L" …; do sleep 20; done; …`), with no git
  involved, because the lock path contains `/git/`. Agents moved the identical
  loop into a `/tmp` script.
- **Verify (acceptance cases for the Claude Code feedback):**
  - commands with `/x/git/y` path arguments, and a `--jq` filter containing
    `[1]`, are allowed;
  - `D=$(mktemp -d) && …` and `--description-html "$(cat f)"`, with no git in
    the substitution, are allowed;
  - a multi-line `export MOCK_BOARD_STATE=/x/git/y/state.json` followed by a
    non-git command is allowed;
  - `git -C /outside status`, `cd /outside && git commit`, and `$(git -C
    /outside rev-parse HEAD)` are still refused.

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
- **Mechanism (gate, adapter fix):** default a created item's state to its
  type's initial state. For stories that is `states.storyReady`. The profile
  has no initial-state key for Feature or Epic (the same gap as DF-10), so
  until it does, fall back to the first entry of the board's `.board.states`
  (`New`). Reject a create that would store a null state.
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
  `gate-tracked-edit.sh` denies an edit-tool write on a gated path only when
  the actor's runner id differs from the marker's. A subagent in the drain's
  own session derives the **same** runner id (from `RUNNER_ID`, the session, or
  `~/.claude/runner-id`), so it would be admitted. The gate separates parallel
  drains, not a writer from its own reviewers, and it never covers Bash writes
  or ungated paths.
- **Evidence:** this happened three times. The AB#58 security re-check said
  "the environment moved me to … feat+mexicano-pairing-module…", and the AB#59
  reviewer and security re-checks both said their own worktree had been removed
  mid-task.
- **Mechanism (process-step):** in drain §2e, a re-review after a fix round is
  always a **fresh** dispatch with `isolation: worktree`, carrying the prior
  verdict as context. It is never a message-resume of the earlier agent.
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
- **Problem:** given a local branch name, `/code-review` returns an empty
  result within seconds. That is indistinguishable from "no findings", so drain
  §2e can record a review that never happened.
- **Evidence:** `/code-review low <branch-name>` finished in 3.8 s and 5.7 s,
  with one tool call each and output `(none)`. The AB#68 diff was 12 inserted
  lines and the AB#58 diff 310, both pre-squash `git diff --stat`. The same skill
  given the PR number (`/code-review medium 34`, `35`, `36`) did real reviews in
  40–122 s, and its PR #36 run raised a real finding.
- **Mechanism (process-step):** run drain §2e's `/code-review` **after** the
  proposal exists, against the PR number. Alternatively, keep it before the
  proposal but treat a result with no review text as "not run", never as "no
  findings".
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2e (ordering) and
  §2f.
- **More evidence (batch 2, 2026-10-08..10):** run against the PR number,
  `/code-review` escalated real defects:
  - **AB#64 (PR #41):** the reviewer had flagged a partly circular oracle as
    non-blocking and approved. `/code-review` showed it could never fail, which
    led to the "independent oracles, no silent skips" fix round.
  - **AB#69 (PR #44, first revision):** `/code-review` found the mixed-legacy
    data loss and the `+5`/`1e` message gap after both agent reviewers had
    approved.

  The record for AB#69 is PR #44's description. For AB#64 it is the board's
  write-back comment, since PR #41's description doesn't mention
  `/code-review`. There are no GitHub review comments. It is a distinct,
  load-bearing pass.
- **Verify:** a skill-text assertion that §2e names the PR-number form, plus an
  assertion that §2e says a code-review result with no review text is recorded
  as "not run".

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
- **Problem:** `board-ops.md` § Parent state roll-up says its state names are
  "read from the active process profile via the `states.*` keys, never
  hard-coded". But the profile defines no Feature or Epic states, so the table's
  `Closed`/`Resolved`/`Active` are hard-coded in practice, and the mock board
  rejects them.
- **Evidence:** the mock board's states are
  `New`/`InDevelopment`/`Deployed`/`Released`/`Review`/`Approved`.
  `default-process.json` has story, requirement and RD state keys only. At the
  end of the drain, the roll-up for Features #49–#51 and Epic #48 needed a
  mapping invented on the spot: all children Deployed → `Deployed`, some
  children past New → `InDevelopment`.
- **Mechanism (process-step + gate):** add Feature and Epic roll-up keys to the
  profile (`states.featureDone`, `states.featureActive`, …) and read the roll-up
  targets from them. `load-process.sh`'s required-key check fails when a
  profile lacks them.
- **Target (dotfiles-claude):** `home/skills/drain/references/board-ops.md`
  § Parent state roll-up; `scripts/boards/default-process.json`,
  `scripts/boards/load-process.sh` (`_missing_keys`),
  `scripts/boards/board-structure.schema.json`, and the mock profile.
- **Verify:** a fixture board with a mock profile where the roll-up writes only
  states from that profile.

## DF-11: A specialist's self-reported bar isn't the bar the drain records

- **Status:** open
- **Source:** drain-491-closeout, AB#62 test-writer, 2026-10-05
- **Goal:** the bar recorded for an item is one complete run in a declared
  environment, made by the drain, not the specialist's own report.
- **Problem:** a specialist runs `verify_command` however it likes: with or
  without `CI` set, and relaunched after hitting its own tool timeout. Its pass
  or fail report then stands in for the item's bar. In this repo `CI` changes the
  run itself: `retries: 2` and `workers: 1` with `CI`, `retries: 0` and parallel
  workers without it. So a specialist's "green" can include failed-then-passed
  tests that a local run would show as red.
- **Evidence:**
  - The AB#62 test-writer reported a run with 9 failed-then-passed tests. That
    needs retries, which means `CI` set or an explicit `--retries` flag, since
    local retries are 0. Its runs took 11–17 min, consistent with serial
    (`workers: 1`) runs; real CI on main took about 7–10 min.
  - Its first foreground `npm test` hit the 600 s tool timeout and was
    relaunched in the background.
  - The drain's own solo run of the same commit, without `CI`, took 2.7 min with
    0 retries.
  - Overlapping runs were suspected at first but are **not** shown. This repo's
    `reuseExistingServer: false` makes a second concurrent run fail loudly on
    port 8199 rather than run slowly.
- **Mechanism (verification-step):** drain §2d/§2f records only a bar it ran
  itself: the item's `verify_command`, in the environment the project declares
  (here `CI` unset), backgrounded and polled to completion. A specialist's
  report is input, never the recorded bar. This drain did that by hand for every
  item. Making it a step means a project-declared bar wrapper: today
  `scripts/drain/verification-bar.sh` is dotfiles-claude's own bats bar, and
  there is no per-project equivalent yet.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2d/§2f,
  `home/skills/drain/references/handoff.md` (Verify); a proposed per-project bar
  declaration (for example `gate.json` `verify_env`).
- **Verify:** a skill-text assertion that §2f records the drain's own run. A
  fixture where a completion report says `pass` but the drain's run is red: the
  item does not proceed to propose.
- **Related:** padeltournament AB#71 (Deployed 2026-10-09, PR #43) makes the CI
  test step fail on any flaky test, which closes most of the CI-side half. Two
  Low residuals are accepted in PR #43:
  - the coverage gate still counts a pass on retry;
  - re-running a failed `main` run can deploy if the flake then passes.
- **Mitigation evidence (the drain applied this by hand; not a new defect)**
  from drain-491-closeout batch 2, 2026-10-07..10: the drain
  recorded only its own solo runs of `npm test` for every item, with `CI` unset,
  serialised behind a shared lock (see DF-15). Specialists ran targeted specs
  only. No item's recorded bar was a specialist's report.

## DF-12: `check-batch-belongs.sh` passes an empty batch

- **Status:** open
- **Source:** drain-491-closeout batch 2 preflight, 2026-10-08
- **Goal:** the belongs check can't report "every item belongs" about a batch
  it never saw.
- **Problem:** given `[]`, the script prints "0 item(s), all carry …" and exits
  0. A caller that builds the item-document array wrongly therefore gets a
  vacuous pass. The preflight then reads as satisfied while proving nothing.
- **Evidence:**
  - A zsh `for i in $ids` loop didn't word-split the ready ids. The script got
    0 documents and exited 0. The corrected run over 16 documents exited 3, with
    all 16 fields unset.
  - Re-checked on dotfiles-claude `origin/main`:
    `check-batch-belongs.sh --items <[]> …` exits 0.
- **Mechanism (gate, script fix):** SKILL.md §0 step 6 already says, as an
  instruction, that an array whose length differs from the number of ids is a
  systemic STOP. This mechanises that rule.
  - Add `--expect-count N`, where the drain passes the number of ids
    `query_ready` returned.
  - If the document count differs from N, exit 65.
  - An empty set passes only as `--expect-count 0`: a legitimately empty ready
    queue, where the drain has nothing to drain anyway.
  - An empty set without the flag exits 65.
- **Target (dotfiles-claude):** `scripts/drain/check-batch-belongs.sh`;
  `home/skills/drain/SKILL.md` §0 step 6, to pass `--expect-count`.
- **Verify:** bats cases:
  - `[]` without the flag exits 65;
  - `[]` with `--expect-count 0` exits 0;
  - a count mismatch exits 65.
- **Related:** batch 1 of the same drain skipped §0 step 6 entirely, and nothing
  noticed. That is the "instructed step, not a hook" gap tracked upstream as
  AB#684. Add this as evidence there; it isn't a separate entry.

## DF-13: The forge port can't update a proposal's description

- **Status:** open
- **Source:** drain-491-closeout batch 2, AB#69 (PR #44), 2026-10-09
- **Goal:** after a fix round, the PR description (the human-facing record of
  what ships and why) can be brought up to date without leaving the port.
- **Problem:** the port's public ops are `create_branch propose_change
  get_proposal get_checks get_reviews land_proposal …`. None updates a
  proposal. AB#69 went through 4 review rounds that changed its design, so its
  description had to be rewritten before landing, and the only route was raw
  `gh pr edit`. That steps outside the port's identity guard (`_fgh_guard`) and
  capability resolution, its no-write mode, and the drain skill's rule never to
  substitute a raw code-host CLI.
- **Evidence:**
  - PR #44's description was updated with `gh pr edit --body-file`.
  - The drain also waited for CI with raw `gh run watch` and `gh pr checks`
    loops. One `gh run watch` exited 0 while its run was still in progress;
    `get_checks`, the prescribed route, caught it.
- **Related finding, the squash commit message:** `land_proposal` runs
  `gh pr merge --squash` without `--subject` or `--body`. On this repo, where
  `squash_merge_commit_message` is `COMMIT_MESSAGES`, the squash commit
  therefore carries the concatenated commit messages, not the PR description.
  On `main`, 0bac161 (#44) still contains the first commit's superseded line
  "restore as empty, re-enterable". So after a design change, the commit
  message on `main` goes stale too.
- **Mechanism (gate, port op):**
  - Add `update_proposal <id> --title <t> --body-file <f>`, behind the same
    guard and no-write handling as `propose_change`.
  - Add `land_proposal … --body-from-proposal`, so the squash message is the
    final description.
  - Optionally add `wait_checks <id> --timeout <s>`, which wraps the bounded
    `get_checks` poll.
  - `validate-config.sh` flags `gh pr edit` and `gh run watch` call sites in
    the drain skill.
- **Target (dotfiles-claude):** `scripts/forge/port.sh`, the github and mock
  adapters, `docs/forge-port.md`, `home/skills/drain/SKILL.md` §2f.
- **Verify:** adapter tests on the mock forge:
  - `update_proposal` changes the body, honours no-write mode, and refuses
    under a failed identity guard;
  - `land_proposal --body-from-proposal` produces a squash message equal to the
    current description.

## DF-14: Refinement doesn't assess impact on persisted data

- **Status:** open
- **Source:** drain-491-closeout batch 2, AB#69 (PR #44), 2026-10-09..10
- **Goal:** a story that changes how stored state is read or validated arrives
  at the drain with its legacy-data behaviour already decided.
- **Problem:** AB#69's story body said to range-check stored results on restore.
  It said nothing about data that older versions legitimately wrote. Reviewers
  then found data loss twice:
  - legacy totals never stored;
  - saves the live AB#62 code had already re-saved with `totalPoints: 24`.

  It took 4 review rounds and 3 operator decisions to converge on "never blank
  stored results".
- **Evidence:**
  - PR #44's description, which records 4 review rounds and the operator's 3
    restore decisions.
  - Its commits: d3bd1e2 (original), then fix rounds ee9afb4, 75e4c59, 7dd27b3
    and b4126a6.
- **Mechanism (process-step):** `/refine` adds a required **Persisted data**
  section to any story whose target files read or write stored state. The
  project declares which paths those are, for example a `gate.json`
  `persisted_state` list. The section must:
  - list which stored shapes older versions wrote;
  - state what happens to each on restore;
  - name the operator decision when data could be lost.

  The drain's §1 batch gate refuses such a story while the section is missing.
- **Target (dotfiles-claude):** `home/skills/refine/SKILL.md`,
  `docs/work-item-schema.md`, `home/skills/drain/SKILL.md` §1.
- **Verify:** a refine fixture where a story touching a declared persisted-state
  path without the section is flagged.

## DF-15: Parallel tracks: the session still moves per track, and shared local resources have no lock

- **Status:** open. Evidence for upstream AB#713 (explicit-path track
  worktrees), plus one new gap.
- **Source:** drain-491-closeout batch 2, 2026-10-08..10
- **Goal:** parallel tracks run without moving the session's worktree under a
  live writer, and without colliding on shared local resources.
- **Already in the drain:**
  - §2c dispatches with `isolation: worktree`.
  - `parallel.md` gives per-item worktrees and markers, plus a hook-enforced
    one-writer rule.
  - §2b forbids switching while a writer is live.
- **Residual gaps:**
  1. **The session still moves per item.** §2b has the session `EnterWorktree`
     per item, and the isolation guard is session-global. The part that would
     remove the need to switch is deferred as AB#713.
  2. **No exclusive-resource locking.** Only prose covers resources two tracks'
     bars would share (`parallel.md` § Staggering verification). There is no
     declared resource and no lock. Here that resource is the project's fixed
     Playwright port, 8199, so concurrent test runs collide.

  On gap 1, §2b also explicitly allows entering a new track's worktree while
  another writer is live, which is exactly the hazard the guard's session-global
  scope creates.
- **Evidence:** batch 2 worked around both by hand.
  - Writers were dispatched with `isolation: worktree` and wrote their own
    markers, so the session never left the main checkout.
  - Every Playwright run, the drain's included, took a shared `mkdir` lock.
  - The earlier 2026-09-30 switch incident was an inline side task, not a
    parallel track. It shows the guard's session-global scope, not a track
    failure.
- **Mechanism (process-step):**
  - (1) is AB#713: add this batch as evidence.
  - (2) is new. A project declares exclusive local resources, for example
    `gate.json` `exclusive: ["playwright:8199"]`, and the drain's bar wrapper
    takes the matching lock. The inline lock loop trips DF-3, so the lock must
    live in a script.
- **Target (dotfiles-claude):** `home/skills/drain/references/parallel.md`,
  `home/skills/drain/SKILL.md` §2d, `scripts/drain/` (a lock helper), and
  AB#713.
- **Verify:** a lock-helper bats test where two concurrent holders serialise,
  and a declared resource is locked by the bar wrapper.

## DF-16: A local test bar run under heavy machine load fails spuriously

- **Status:** open
- **Source:** drain-491-closeout batch 2, AB#64 and AB#76, 2026-10-08..10
- **Goal:** a red local bar means the change is wrong, not that the machine is
  saturated.
- **Problem:** the machine's load average reached 100 to 275, and under that
  load browser tests time out. The cause is inferred, not proven: `ps` showed
  self-hosted Azure DevOps agent processes (`azdo-agent-1..4`) among the top CPU
  users at the time.
- **Evidence:**
  - AB#64: one `tournament_store` timeout at load ~100. It didn't reproduce in
    150 repeats.
  - AB#76: 5 Firefox `newPage`/`click` timeouts in untouched specs at load
    224–275. The suite took 47 min, against a normal 2–5. The same commit re-ran
    green (816/816) once load fell below 30.
  - The drain added a load-gated re-run by hand both times.
- **Mechanism (verification-step):**
  - The bar wrapper records `uptime` before and after each run.
  - It refuses to start, and waits, while load is above a project-declared
    ceiling.
  - A red result recorded above that ceiling is marked "environmental,
    re-run", never "pass". The re-run must be green at normal load before
    publish.
- **Target (dotfiles-claude):** the per-project bar wrapper (see DF-11),
  `home/skills/drain/SKILL.md` §2d.
- **Verify:** wrapper tests with a stubbed load average, covering a wait above
  the ceiling and a red-under-load result recorded as non-final.

## DF-17: A review pass detached the writer's worktree

- **Status:** open
- **Source:** drain 2026-10-10..17, AB#63 review round 1 (2026-10-15)
- **Goal:** no review or audit pass can change the writer's worktree, including
  its HEAD.
- **Problem:** the writer's worktree ended review round 1 on a detached HEAD at
  the reviewed commit. Its reflog reads `checkout: moving from
  worktree-chore+scoreboard-polish-follow-ups to c69e864`. The review prompts
  said "in your own isolated worktree run `git checkout --detach <sha>`", and
  `/code-review` (a forked skill, not an isolated agent) was handed the
  writer's worktree path. Which pass ran the checkout is not proven. The
  `reviewer` and `security-reviewer` were dispatched with `isolation:
  worktree`; the `/code-review` fork was not.
- **Evidence:**
  - Only a HEAD move: the tree was clean, nothing was lost.
  - It was caught only because the next fix-round writer's isolation check
    found `git branch --show-current` empty and stopped. The drain re-attached
    the branch with `git switch` and re-dispatched.
  - From then on every review prompt began with a self-check (`git rev-parse
    --show-toplevel` must not be the writer's path, else STOP), and
    `/code-review` was told not to change HEAD. No recurrence in any later
    review pass (AB#63 round 2, AB#70, AB#66, AB#60). Every agent reviewer
    reported its own worktree.
- **Mechanism (gate + process-step):**
  - The `reviewer` and `security-reviewer` agent definitions open with that
    isolation self-check as a hard STOP, so it doesn't depend on the prompt.
  - The drain passes `/code-review` a commit range checked out in a throwaway
    detached worktree it creates, never the writer's path.
  - Before every fix-round dispatch and before publish, the drain asserts
    `git -C "$WS" symbolic-ref -q HEAD` names the item branch. A detached or
    foreign HEAD is a STOP, not a fix-up.
- **Related:** DF-7 (reviewers landing in the writer's worktree) and DF-8
  (`/code-review` behaviour). Both AB#63 round-1 agent reviewers reported their
  own worktrees, which points at the unisolated `/code-review` fork. The
  agent-definition STOP alone is prompt guidance. The `symbolic-ref` assertion
  and the throwaway worktree for `/code-review` are the mechanical parts.
- **Target (dotfiles-claude):** `home/agents/reviewer.md`,
  `home/agents/security-reviewer.md`, `home/skills/drain/SKILL.md` §2e/§2f.
- **Verify:** a fixture where a review stub checks out a commit in the writer's
  path: the drain stops before the next dispatch.

## DF-18: A long drain keeps running a skill the harness has since changed

- **Status:** open
- **Source:** drain 2026-10-10..17 retro
- **Goal:** a drain notices when the harness it runs on changes under it.
- **Problem:** the batch ran for 7 days. After preflight, the harness shipped
  2 changes touching `home/skills/drain`, `home/hooks` or `home/agents`:
  e05ad28 (2026-10-14, `home/hooks`) and 63bc6a6 (2026-10-15 06:38Z;
  `home/skills/drain`, `retro`, `audit-board`, `scripts`). Two more
  (bffeb26, cf8e8e6) touched none of `home/skills/drain`, `home/hooks` or
  `home/agents`.
  An earlier commit, 54940b8, landed before preflight and passed the currency
  check. 63bc6a6 added the `[drain-batch] $BATCH_ID claimed` / outcome markers
  to SKILL.md. The drain kept following the skill text it loaded at the start,
  so the two items claimed after 63bc6a6 (AB#66 on 10-16, AB#60 on 10-17) were
  never stamped. The other five were claimed before the rule, though AB#70's
  outcome write-back came after it. None of the 7 carries a marker, so the
  board alone can't name the batch.
- **Evidence:** `git log -S'[drain-batch]' origin/main -- home/skills/drain/SKILL.md`
  in dotfiles-claude gives only 63bc6a6. `get_comments` on AB#40, 41, 75, 63,
  70, 66, 60 finds no `[drain-batch]` comment. `install.sh --check` and the
  runtime-currency check ran once, at preflight (2026-10-10 10:37Z). The
  existing §0 "Resuming is not exempt" re-check runs on resume only, not
  before each claim.
- **Mechanism (process-step):**
  - The drain records the harness `HEAD` sha at the §1 batch gate.
  - Before each §2a claim it runs `git -C "$HARNESS" fetch` and compares.
    `hook_runtime_currency` alone is not enough: it is offline, compares `HEAD`
    to the local `origin/<default>` ref, and still returns 0 after the
    operator pulls a new commit into a symlink-projected checkout.
  - If `git diff --name-only <recorded>..HEAD -- home/skills/drain home/hooks
    home/agents` (or the same against `origin/<default>`) is non-empty, it
    STOPs and reloads the skill before claiming.
  - No back-filling: a batch that never minted a `BATCH_ID` gets no markers
    after the fact. Markers feed the clean-drain promotion count and must not
    be self-asserted. The gap is recorded in the retro instead.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §1/§2a, plus a
  small helper `scripts/drain/harness-moved.sh <recorded-sha>`. It fetches,
  diffs the three paths and exits 3 when they changed.
- **Verify:**
  - a bats case: in a fixture harness repo, a commit touching
    `home/skills/drain` after the recorded sha makes `harness-moved.sh` exit 3,
    and a commit touching only `scripts/boards` exits 0;
  - a skill-text assertion that §2a calls it before every claim.

## DF-19: Item target files miss the tests a rename or refactor must touch

- **Status:** open
- **Source:** drain 2026-10-10..17, AB#40, AB#41, AB#66, AB#70
- **Goal:** an item's declared surface includes every file its approach forces
  it to change.
- **Problem:** 4 of 7 items needed a surface delta for test files
  their own approach made unavoidable:
  - AB#40 renamed the localStorage keys; 7 other specs planted or read them.
  - AB#41 needed the shared key helper AB#40 had just created.
  - AB#66's own board comment named `mexicano_pairing.spec.js`, which its
    Target files omitted.
  - AB#70 changed the Generate button from `disabled` to `aria-disabled`; 3
    assertions in `state-handling.spec.js` checked `toBeDisabled()`.
- **Evidence:** `.claude/worktrees/.drain-state/deltas.log` in this repo holds
  4 surface-delta entries. AB#40 and AB#70 were approved by the operator at the
  batch gate; AB#41 and AB#66 were derived by the drain. A fifth entry is a
  deferral, not a delta. `check-scope.sh` exited 3 on AB#40 (8 excess files: 7
  specs plus the new helper). AB#70's implementer stopped before editing and
  reported the 3 assertions.
- **Mechanism (verification-step):**
  - At refinement, `/refine` greps `tests/**` for every identifier, storage
    key, selector and attribute the Approach says it renames, removes or
    changes, and lists the hits under Target files, or records why each one is
    unaffected.
  - Files named in the item's own comments are added to Target files.
  - At the batch gate the drain re-runs the grep against the current tree
    (later items change the code) and shows any new hits as a surface delta for
    approval, before dispatch rather than after review.
- **Target (dotfiles-claude):** `home/skills/refine/SKILL.md` (Target files),
  `home/skills/drain/SKILL.md` §1, `scripts/drain/plan-tracks.sh`.
- **Verify:** a fixture item whose Approach renames a key used in two specs:
  `/refine` lists both, and the batch gate reports a new third use as a delta.

## DF-20: Nothing lists the tagged tests a diff touches, so the annotation audit input is hand-made

- **Status:** open
- **Source:** drain 2026-10-10..17 (every item)
- **Goal:** the §2e annotation audit's list of tags is computed, complete and
  repeatable.
- **Problem:** §2e makes the orchestrator list every tag whose line or test
  body changed, and AB#731 (the gate) is deferred. This drain wrote its own
  lister (`.claude/worktrees/.drain-state/tagged-hunks.mjs`). Reviewers found
  that it missed:
  - multi-tag titles (`R-A, R-B: …`), in round 1 of AB#40;
  - tagged tests changed only through a helper they call (AB#40, AB#70);
  - a data row added to a parametrized test (AB#40 round 3, the 17-court-name
    case).
  It also over-listed tests next to a hunk. The drain added these to prompts
  by hand.
- **Relation:** this is evidence and a spec for the existing upstream AB#731
  (the annotation-audit gate, deferred in SKILL.md §2e), not a new item.
- **Mechanism (gate, script):** `scripts/drain/list-tagged-changes.sh --base
  <sha> --head <sha>`. It parses test titles (single and multi-tag, template
  literals), maps changed lines to the enclosing test, follows changed
  top-level helpers to their callers, and emits `file: title → tags`. The
  drain passes its output verbatim to the reviewer, and the reviewer's
  classified set is diffed against it (AB#731).
- **Target (dotfiles-claude):** `scripts/drain/`, `home/skills/drain/SKILL.md`
  §2e, AB#731.
- **Verify:** bats fixtures covering a multi-tag title, a helper-only change, a
  parametrized-row change, and a hunk adjacent to an unchanged test.

## DF-21: Drain working state lives in a session scratchpad that can disappear

- **Status:** open
- **Source:** drain 2026-10-10..17, during AB#40 (2026-10-10 11:17Z, after
  the writer's first report and before the first review dispatch)
- **Goal:** a drain's working state (batch file, conflict map, surface deltas,
  bar logs, retro notes) survives the session.
- **Problem:** the drain kept `batch.json`, `map.json` and bar logs in Claude
  Code's session scratchpad. Claude Code's runtime withdrew that directory
  mid-batch ("The scratchpad directory announced earlier is no longer
  available"), so the drain moved its state to `.claude/worktrees/.drain-state/`,
  a git-ignored path in the target repo. The resume note and this retro both
  depend on it. dotfiles-claude itself never names a scratchpad, so the drain
  skill leaves the location to chance.
- **Mechanism (process-step):** the drain declares one state directory at §0,
  git-ignored in the target repo (for example `.claude/drain/<batch-id>/`),
  checks it is ignored, writes every working file there, and names it in the
  resume note. `/retro` reads it as an evidence source.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §0/§1,
  `home/skills/retro/SKILL.md` §1, `home/skills/onboard-project` (gitignore
  entry).
- **Verify:** skill-text assertion; onboarding adds the ignore entry.

## DF-22: Comments and docs claim more than the code does, in most items

- **Status:** open
- **Source:** drain 2026-10-10..17, AB#40, AB#75, AB#63, AB#66, AB#60
- **Goal:** a comment or doc sentence a change adds is true of the code when it
  ships.
- **Problem:** in 5 of 7 items a reviewer or `/code-review` found an added or
  changed comment, message or doc sentence that claimed more than the code did:
  - AB#40: "migrated once", "kept for the next load", "never read again".
  - AB#75: "will be saved automatically", with no retry.
  - AB#63: a test titled "never reorders" while it did.
  - AB#66: a comment said `__proto__` was planted as an own key; it was not.
  - AB#60: navigation buttons called "large, bold".
  Each cost a fix round or a comment-only commit. None was raised by the
  specialist that wrote it; each was found by a review pass.
- **Mechanism (process-step + gate):**
  - A script lists every comment, user-facing string, test title and doc line
    the diff adds or changes, in the same family as DF-20's lister.
  - The completion report's `claims_changed:` gives, for each listed line,
    the code location that makes it true.
  - The orchestrator diffs the two lists and re-dispatches when a listed line
    has no entry. That diff is mechanical, so it belongs in the AB#709
    `check-completion-report.sh` gate.
  - The writer's entries are self-reported (DF-11's objection). The
    independent check is the reviewer, who verifies each entry against the
    code instead of hunting for the lines.
- **Target (dotfiles-claude):** `home/skills/drain/references/handoff.md`
  (completion-report), `home/agents/reviewer.md`, `scripts/drain/`, AB#709.
- **Verify:** bats cases:
  - the lister emits an added comment, an added or changed user-facing string,
    a renamed test title and a changed doc line, and does not emit unchanged
    lines;
  - `check-completion-report.sh` rejects a report with no `claims_changed`
    entry for a listed line;
  - it rejects an entry whose cited `file:line` does not exist at the head
    commit. Whether the claim is true stays the reviewer's judgement.

## DF-23: Port scripts are committed non-executable, so direct-exec `ask` spellings never match

- **Status:** filed as AB#773 (from the harness session, 2026-10-18)
- **Source:** drain 2026-10-17..31, AB#88 (posted to AB#88 as a write-back
  comment 2026-10-18)
- **Goal:** every permission spelling in `settings.base.json` can match a call
  that actually works.
- **Problem:** `scripts/forge/port.sh` and `scripts/feedback/port.sh` are
  committed 100644 (`scripts/boards/port.sh` is 100755). The direct-exec
  spellings `~/.claude/forge/port.sh land_proposal` and `$HOME/...` in the
  `ask` list can never match a working call: exec gives 126. Approval is not
  skipped. `bash ~/.claude/forge/port.sh land_proposal:*` is also in `ask`,
  `gate-forge-landing.sh` matches the basename of any spelling, and
  `land_proposal`'s only sanctioned caller is the queue's integrate step,
  itself ask-gated. This is a consistency defect, not an approval bypass.
- **Mechanism (gate):** commit every `scripts/*/port.sh` 100755, and make
  `install.sh --check` fail on a linked script that is not executable.
- **Target (dotfiles-claude):** `scripts/forge/port.sh`,
  `scripts/feedback/port.sh` (mode), `scripts/install.sh` (check).
- **Verify:** bats: `--check` fails on a linked port script with mode 100644
  and passes once it is 100755. No drain-preflight check needed.

## DF-24: The mock board has no way to clear an item's owner, so a released item can't be claimed

- **Status:** open
- **Source:** drain 2026-10-17..31, AB#65 claim (2026-10-26T06:44Z)
- **Goal:** an item released by `/refine` or a drain can be claimed again
  without editing the board's state file.
- **Problem:** a 2026-10-07 `/refine` release put AB#65 back to the ready
  state but left `assignedTo: kjell`. The mock adapter's `claim_item` requires
  `assignedTo == null`, so the drain's claim was refused ("not claimable …
  owner=kjell"). The adapter has no op that clears the owner: `update_item`
  does not take one, and there is no `release`/`unassign`. The operator
  cleared it by hand with `jq` on `.claude/mock-board.json`, outside the port
  and its audit trail.
- **Mechanism (gate):** an `unassign <id>` op (or `update_item --owner ""`)
  on every adapter, and the release step in `/refine` and in the drain's
  stale-claim reset calls it, so a release always ends with no owner.
- **Target (dotfiles-claude):** `scripts/boards/mock.sh`, the other adapters,
  `scripts/boards/port.sh`, `home/skills/refine`, drain stale-claim reset.
- **Verify:** bats: claim → release → claim succeeds on the mock adapter;
  release leaves `assignedTo` null.

## DF-25: `--check-batch-id` checks the format of the id, not that it is this batch's

- **Status:** open
- **Source:** drain 2026-10-17..31, AB#91–93 preflight (noted 2026-10-22T09:18Z)
- **Goal:** a drain resumed in a new session can only proceed under the batch
  id it was approved with.
- **Problem:** each item's §0 ran from a preflight script hand-copied from the
  previous one. The scripts for AB#91, AB#92 and AB#93 carried a mistyped id
  (`…T093216Z` for `…T092216Z`), and `--check-batch-id` passed it, because it
  checks only the shape. The board stamps happened to use the right id. A
  stamp under the wrong id would have split the batch, and `/retro` and §4
  would have missed items.
- **Mechanism (verification-step):** `--check-batch-id` also takes the
  resume note's recorded id (or the batch's existing `[drain-batch] … claimed`
  markers on the board) and fails when they differ. The drain ships one
  preflight script that reads the id from the note, replacing per-item copies.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §0,
  `scripts/drain/` (batch-id check).
- **Verify:** bats: a well-formed id that differs from the recorded one fails;
  the recorded id passes.

## DF-26: A Claude Code runtime directory inside a harness skill fails `install.sh --check`

- **Status:** open
- **Source:** drain 2026-10-17..31, §4 close (2026-10-31)
- **Goal:** drain §0 doesn't stop on files the harness doesn't own.
- **Problem:** an empty `.claude/.cc-writes` directory appeared under the
  harness checkout's `home/skills/drain/` on 2026-10-31 16:07, created by
  Claude Code's own tooling during the session, not by the drain. `install.sh
  --check` then failed and §0 stopped. The operator removed the directory by
  hand. A real stray in a skill directory should still fail. The problem is
  that the check doesn't say this one is a runtime artifact.
- **Mechanism (gate):** `install.sh --check` reports a `.claude/` runtime
  directory inside a skill by name and cause ("Claude Code runtime directory,
  safe to delete"), and the harness's `.gitignore` covers `**/.claude/.cc-*`
  so it can never be committed.
- **Target (dotfiles-claude):** `scripts/install.sh`, `.gitignore`.
- **Verify:** bats: a `.claude/.cc-writes` directory under a linked skill
  produces the named diagnostic.

## DF-27: The implementer's `git commit` is denied every round, so the operator commits by hand

- **Status:** open
- **Source:** drain 2026-10-17..31, every item (AB#88–97, AB#65, AB#77)
- **Goal:** the commit step of a drained item has one defined owner and a
  check, not an ad-hoc fallback.
- **Problem:** in auto mode the classifier refused the implementer's `git
  commit` in every round of every item. Each writer handed back uncommitted
  work plus a message file. The operator committed it by hand, about 30 times
  in this batch. Then the drain checked the message for a CI-skip marker and
  ran the bar on the new commit. The skill still describes the writer
  committing, so each round improvises the handover.
- **Mechanism (process-step):** make operator-commit the declared path when
  the writer can't commit. The completion report carries `commit_message_file:`
  and `files:`. The drain runs `check-scope` and the skip-marker check on them
  before asking the operator to commit, then confirms the new HEAD's file list
  equals `files:`. Alternatively, scope an allow rule for `git commit` to item
  worktrees and keep the same checks.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2c/§2d,
  `home/skills/drain/references/handoff.md` (completion report),
  `home/agents/implementer.md`.
- **Verify:** skill-text assertion; a bats case for the file-list comparison.

## DF-28: The resume note goes stale between sessions and outgrows a single read

- **Status:** open
- **Source:** drain 2026-10-17..31 (operator retro item 2026-10-22T14:31Z;
  resume reconnaissance 2026-10-30)
- **Goal:** any session can resume a batch from a short, current state block,
  and no item step happens without a record.
- **Problem:**
  - The note had no entry between 2026-10-26 and 2026-10-30. In that time
    AB#65 had a third review round, two more commits and its merge (PR #71).
    That round's review record was never written, so §4 needed an after-the-fact
    waiver. AB#65's marker was still live on 2026-10-30.
  - AB#77's round-2 bar log was lost and the bar had to be re-run.
  - The note grew to 189 lines and 53 KB, an append-only log with a current
    state block on top, and no longer fits one read.
  - Subagent reports came back into the session's context in full. The
    operator asked for the batch to be made context-efficient (items 1–4
    below).
- **Mechanism (process-step):**
  1. The drain checkpoints at each item boundary. It rewrites the current-state
     block and stops with "safe to /clear; resume with: …". Skills can't run
     `/clear`. Optionally it stops itself past about 60% context.
  2. A SessionStart hook prints the in-flight batch's current-state block, so
     a fresh session starts from it.
  3. The note is a bounded state block. The log moves to the DF-21 state
     directory.
  4. Subagents write full reports to a file in that directory and return only
     a terse summary (a `handoff.md` change).
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md`,
  `home/skills/drain/references/handoff.md`, `home/hooks/` (SessionStart).
  Builds on DF-21.
- **Verify:** skill-text assertion; a bats case that the SessionStart hook
  prints the state block when a batch is in flight and nothing otherwise.

## DF-29: Later review rounds reopen trade-offs an earlier round settled

- **Status:** open
- **Source:** drain 2026-10-17..31, AB#95, AB#96, AB#97, AB#65, AB#77
- **Goal:** the round cap ends review on schedule, and each round's findings
  are new.
- **Problem:** every item with a review record reached the third round, and
  AB#95 needed four. Part of the cause: `/code-review` and the reviewer got
  no record of earlier dispositions, so they raised findings again that the
  operator had already accepted or deferred. Examples are AB#77 round 3 C1
  (same class as AB#134) and C2 (same class as round-2 C3). The 12 items
  produced 31 follow-up items (AB#101–123, AB#130–135), several of them
  re-raised classes.
- **Mechanism (process-step):** §2e passes every earlier round's dispositions
  (`<id> <class> → <disposition>`, from the local review record) into each
  review prompt as settled. A finding whose class matches a settled one is
  recorded as `seen-class`, not a new finding, so the existing round-cap rule
  applies to it mechanically.
- **Target (dotfiles-claude):** `home/skills/drain/SKILL.md` §2e,
  `home/skills/drain/references/board-ops.md` (review-round record).
- **Verify:** skill-text assertion; a bats case that the prompt builder
  includes the earlier rounds' dispositions.

## Evidence added by the 2026-10-17 retro (existing entries)

- **DF-1 (deploy not verified):** the merge of AB#75 (PR #53, 7f11e79) produced
  no workflow run at all: `actions/runs?head_sha=…` total 0, no skip directive,
  Actions enabled, GitHub status operational. The drain's by-hand deploy check
  caught it, kept AB#75 out of Deployed, and verified it live with the next
  push (c42d90c, Pages 7085639169). A "no run within N minutes of landing"
  check belongs in the DF-1 post-land step. In-repo, AB#65 (deploy-freshness
  monitor) would also have flagged it and is still not delivered.
- **DF-3 (worktree guard false positives):** while the session was in a
  worktree, the guard refused 6 commands:
  - Two sourced or ran a harness script by its absolute checkout path
    (`/Users/…/git/dotfiles-mui/…`) with no real git: `resolve-runner-id.sh`
    once and `check-scope.sh` once. DF-3's matcher fix would allow these.
  - One also ran `git -C "$WS" …` with a variable path. That is the form the
    guard says it cannot verify, so it was arguably a fair refusal, not a
    false positive.
  - One sourced `~/.claude/boards/resolve-runner-id.sh` and was refused under
    a different rule ("runs `.` inside a construct too complex"). The matcher
    fix would not change it.
  - The AB#40 board write-back named a main-checkout path
    (`/Users/…/git/padeltournament/.claude/mock-board.json`). The matcher fix
    would allow it.
  - A heredoc append with a relative path, refused as too complex. The matcher
    fix would not change it.

  Other commands naming the same paths ran fine. The drain worked round the
  refusals with `ExitWorktree` whenever no writer was live, and AB#40's
  write-back went through about 8 minutes later.

  None of these refusals comes from a dotfiles-claude hook: no harness file
  produces the message, so they never reach `~/.claude/gate-log.jsonl`. This
  answers DF-3's open question (see its Status).
- **DF-6 (create_item leaves state null):** recurred. AB#88 came back with
  `state: null` (seen directly). The drain then set every later item it created
  (AB#89–98) to New with `update_item --state New` as a matter of routine, so
  their raw create state was not checked.
- **DF-16 (load):** the machine hibernated at 4% battery during the AB#75
  fix-round-3 implementer's own full run, not the drain's bar. Firefox tests
  in flight across the sleep failed with 5.4 h durations. The implementer
  voided the run and re-ran cold; this is also DF-11 evidence. The DF-16 bar
  wrapper should also void a run that spans a system sleep (`pmset -g log` on
  macOS).

## Evidence added by the 2026-10-31 retro (existing entries)

- **DF-2 (worktree teardown):** recurred. On 2026-10-30, before AB#77, 15
  leftover worktrees were removed by hand with the operator's approval. At
  AB#77's teardown, two isolation review worktrees still couldn't be removed:
  the reviewer's Playwright run had left git-ignored `playwright-report/`
  files in them. Step 4 of the mechanism has to cover a review worktree that
  holds only ignored files. Remove it with `--force` once a
  `git status --porcelain --ignored` listing shows nothing but ignored paths.
- **DF-6 (create_item leaves state null):** recurred, and at scale. The
  2026-10-17 batch had worked round it with `update_item --state New`. This
  batch dropped that workaround. 29 follow-ups the drain filed (AB#101–123,
  AB#130–135) have `state: null`, so they are invisible to every
  state-filtered query. The resume note listed them as "New". Still open on
  the harness's main: `scripts/boards/mock.sh` `_adapter_create_item` stores
  `state: $s.state` with no default.
- **DF-21 (working state location):** the review records under
  `drain-reviews/<batch>/` survived the whole 14-day batch, but the bar logs
  kept in session scratchpads did not (AB#77 round 2). See DF-28.
