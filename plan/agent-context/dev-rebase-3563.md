# Agent context — `dev-rebase-3563` (Opus 5, 2026-07-24 → 2026-07-25)

Spawned to rescue the DIRTY PR #3563. Ended up landing four PRs and filing
three issues. This is the handoff.

## Outcome

| PR        | what                                                                                          | state at stand-down                                           |
| --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **#3563** | #3024 iterator `next`/`return` dispatcher arity pad (8 CE-eliminations) — adopted, un-DIRTY'd | held; unblocks when #3586 lands. **Do not touch its `hold`.** |
| **#3581** | #3024 static-super call arity (`selfOffset`)                                                  | green, hold cleared, in queue                                 |
| **#3584** | files #3593 (zip null_deref, senior-dev)                                                      | docs-only                                                     |
| **#3586** | #3595 trap-ratchet `compile_error` exclusion + `ORACLE_VERSION` 11                            | the unblocker for #3563                                       |

Issues filed: **#3593** (zip null_deref, `feasibility: hard`, senior-dev),
**#3594** (static-super property reads — class-as-receiver), **#3595** (the
ratchet exclusion).

## The most reusable lesson: concurrent writers on one fork

**Two lanes are live on the `ttraenkler` fork simultaneously.** I hit this three
times in one window, and it is not theoretical:

1. **Id-allocation races (twice).** `claim-issue.mjs --allocate` reserves
   atomically against `origin/main` ∪ open PRs ∪ the `issue-assignments` ref —
   but it **cannot see an id a concurrent branch is about to take**, nor one
   that lands on `main` between two of your own reservations. I collided on 3589
   (cross-actor) and then again on 3594 (my reserved id taken by a parallel
   renumber of _the branch I was fixing_). When filing several issues in one
   sitting, allocate **one at a time and confirm each id differs** before
   writing files.
2. **The duplicate-id gate is merge_group-only in practice.**
   `check:issue-ids:against-main` is PR-level and passes when neither file is on
   `main` yet. The duplicate then surfaces in the `merge_group` re-validation
   (`quality` → "Issue integrity + link gate (#1616)") and parks the PR. So a
   green PR is **not** evidence of no id collision.
3. **ANCESTRY-CHECK BEFORE ADOPTING — the rule to keep.** My push was rejected
   because a parallel actor had pushed a renumber to _my_ branch. Before doing
   anything I ran:
   ```
   git merge-base --is-ancestor <my-head> <fork-head>   # exit 0 ⇒ my work is contained
   ```
   Only then `git reset --hard <fork-head>` to adopt their version. **A
   force-push would have silently destroyed their work.** Adoption is safe only
   _after_ the ancestry check; otherwise it is luck.

**Convention on an id collision: `main` always wins**, the branch-only file
renumbers. Verify which file is actually on main with
`git ls-tree -r --name-only origin/main plan/issues/` — do not take anyone's
word for which is the incumbent (I was handed the incumbent backwards once and
only caught it by checking the tree).

**A rename is not a rename until every reference moves.** Filename, `id:`
frontmatter, heading, and any prose/test/code references. Then `grep` for the
old number to confirm none survive. I also shipped a commit where `git mv`
staged the rename but the in-file `id:` edit was left **unstaged** — the gate
reads frontmatter, not filenames, so the PR still carried the colliding id.
Caught only by reading gh's `Warning: 1 uncommitted change` instead of ignoring
it. **Read that warning.**

## CI / gate lessons

- **`check-verdict-oracle-bump.mjs` has a blind spot.** Its `VERDICT_SIGNAL_RE`
  matches only `status:` verdict-literal assignments, so **ratchet/gate-policy
  changes in `scripts/diff-test262.ts` are invisible to it** — it reported "no
  verdict-logic files changed" for #3586, which _is_ a verdict-logic change.
  **Decide the `ORACLE_VERSION` bump from what the change does, never from
  whether the gate complains.** Missing it wedges the merge queue (#3003).
- **A job named "Cancel Test262 after quality failure" showing `skipping` is
  HEALTHY** — it is a guard that only runs _if_ quality fails. I nearly misread
  it. The authoritative check is filtering `statusCheckRollup` for
  FAIL/ERROR/CANCEL.
- **The trap ratchet punished CE-elimination work.** A `compile_error` baseline
  never instantiated, so `__module_init` never ran and never had the chance to
  trap; charging a later trap to the PR that merely made the module _compile_ is
  backwards. #3586 fixes it. Accepted risk recorded there: the corpus keeps one
  genuinely-trapping test until #3593 is fixed.

## Method lessons (the ones that actually changed outcomes)

- **Valid Wasm is NOT evidence of correctness.** My first static-super cut also
  padded the getter path; it made the module _validate_, and I nearly shipped on
  that. Checking the **return value** showed the pad emitted
  `ref.null; ref.as_non_null` — a **guaranteed runtime trap**. I backed it out:
  trading a loud compile-time error for a silent trap is strictly worse. (Main
  has since filed `3590-padmissingarg-ref-unconditional-trap-landmine.md` on the
  same hazard.)
- **Verify a control passes for the RIGHT reason.** `static super.<plain field>`
  was handed to me as a passing control. It produces valid Wasm that returns
  **0** instead of 13 — broken on `main`, and it would have "passed" regardless
  of what my fix did. Pin values, and pick values that also pin **order**
  (`super.g(3,4) → 34`, not a count-only assertion).
- **A/B against stock `main` rather than asserting attribution.** For both the
  static-super fix (main 5/11 → 11/11) and the #3563 park (identical trap with
  the dispatcher change absent) I restored the file from `origin/main`, re-ran,
  and restored mine — verifying `diff` IDENTICAL afterwards. That converts
  "probably" into a measured fact and is what let the lead act.
- **Verify your tests are load-bearing.** Revert the fix and confirm the new
  tests _fail_. For #3586 two exclusion tests fail without the fix and two
  guards pass either way — which is the point. A test that passes with and
  without the fix is decoration.
- **Union-merge hand-written planning prose; never `--theirs`.** Merging `main`
  _into_ a branch makes `--theirs` mean _main's_ version, which **deletes your
  own PR's section**. The "planning artifacts → `--theirs` + regenerate" rule is
  for _generated_ artifacts only.
- **A clean auto-merge says nothing about semantics.** `src/codegen/index.ts`
  auto-merged across 54 commits on #3563; I re-ran the dispatcher tests (3/3)
  and adjacent suites (45/45) rather than trusting textual cleanliness.

## Open work / where to pick up

- **#3593** (senior-dev): `Iterator.zip` over object-literal iterators
  null-derefs in `__module_init`. Proven pre-existing. The issue carries the
  minimized repro (keep its `includes:` line — load-bearing), an 8-variant
  discrimination table, the ruled-out `_getFlattenable` lead, and the next step
  nobody has taken: **dump the WAT** of the real file (it compiles on #3563's
  branch) and diff it against the repro's to confirm the same trap site.
  Source-level minimization stopped converging — go to WAT.
- **#3594**: static-super property reads need the **class modelled as the
  receiver**. Do NOT "pad the getter" — that is the rejected fix above. Two
  KNOWN-OPEN assertions in `tests/issue-3024-static-super-arity.test.ts` pin
  today's broken behaviour and **must flip** when it is fixed.
- **Flapping ratchet row**, unaddressed:
  `TypedArray/prototype/set/array-arg-offset-tointeger.js` (`oob`) — excluded on
  #3563's run via the _missing-row_ path but hard-failed a main-push promote on
  the same `+1 oob`. Different exclusion path; wants its own measurement.

## Environment note

This spawn had **no `TaskList`/`TaskUpdate`/`TaskCreate` and no `ToolSearch`** —
`"TaskList exists but is not enabled in this context"`. Not a deferred-tool
case. It also ran in a harness _agent-id_ worktree
(`/workspace/.claude/worktrees/agent-<id>`) rather than an `issue-*` one, with a
guard refusing any `cd /workspace && git …`. Task state was managed by the lead
over SendMessage throughout, which worked fine.
