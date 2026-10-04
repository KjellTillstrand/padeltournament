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
