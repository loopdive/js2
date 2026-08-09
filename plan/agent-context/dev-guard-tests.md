# dev-guard-tests — session context (2026-07-24 → 2026-07-25)

Developer (Opus 5). Three tasks: #5 stale-vs-real test triage, #7 auto-park step
awareness, #8 standalone statusline source.

## PRs opened

| PR        | issue | branch                            | state at hand-off                                                                              |
| --------- | ----- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| **#3579** | #3591 | `issue-guard-gen-fnexpr-dispatch` | **MERGED** — all required checks green, `CLEAN`                                                |
| **#3585** | #3597 | `auto-park-step-aware`            | open; `quality` failed on a duplicate-id gate, **fixed + pushed** (`d8f26cb`), awaiting re-run |
| **#3590** | #3598 | `statusline-standalone-current`   | open, just created                                                                             |

## Task #5 — four failing tests: (B) PRODUCT WRONG ×4, nothing re-pinned

Handed four failures said to reproduce on unmodified `main`. **Verified
independently first**, and the verification mattered:

- `tests/issue-3164.test.ts` 3 failed / `tests/issue-3386.test.ts` 1 failed — **real**.
- `tests/issue-2961.test.ts` "×4" — **did not reproduce at all**: 11/11 green,
  _and_ already in the guard suite via #3561. A **stale flag, not a stale test**.
  It came from a prior session's wind-down and was passed on uncritically.

**Attribution (bisect, 2,937 commits, 12 steps):**

```
last good  8bc6e1c3ccea74   both suites 30/30 PASS
first bad  1fbb1810bd0713   both suites 26/30 — THE SAME 4 FAIL
           feat(#3032): W6 … GenState brands … (#3356), merged 2026-07-19
```

Both suites **predate** the culprit, so the expectations were never
"never-pinned" — they were broken.

**Root cause (instrumented, not inferred).** `compileDeclarations` compiles the
module-init body **twice** — `declarations.ts:2312` (discovery) and `:2438`
(final) — with top-level function bodies compiled **between** them. A
module-scope generator **function expression** is lifted afresh on each pass, so
one AST node registers twice with two state-struct types:

```
closureName=__closure_0 selfTypeIdx=57  nodePos=7  -> stateTypeIdx=61
  .next() dispatch emitted here, registered=[["__closure_0",61]]
closureName=__closure_1 selfTypeIdx=108 nodePos=7  -> stateTypeIdx=111
```

`buildNativeGeneratorDispatch` emits an **inline `ref.test` ladder** frozen at
function-compile time, so it tests only pass 1's dead type `61`; the surviving
pass-2 closure builds `struct.new 111` and falls through to the #1344
`emitBrandCheckTypeError` arm.

**`for-of` survives** because its GENSTATE arm is filled at **finalize**
(`fillNativeIteratorLateArms`), when all registrations are visible. That
asymmetry is the proof the mechanism is real rather than a correlation.

**Why a naive fix is wrong:** pass 2's lifted _self_ struct type also differs
(57 vs 108) and the state struct's `__self` field is typed
`ref_null <selfTypeIdx>` — reusing pass 1's info emits **invalid Wasm**.

Filed as **#3591** with an 8-shape measured table and two fix candidates
(late-fill the resume dispatch like `for-of`, or memoize the lifted closure per
AST node — the #3164 gate already guarantees these fn-exprs are capture-free).
The four cases are `it.skip` **with inline pointers**, never silently re-pinned.

**Durable half:** `tests/issue-3164.test.ts` + `tests/issue-3386.test.ts` folded
into `tests/guard-suite.json` (#3552). They rotted invisibly for 5 days because
the #3008 per-PR gate runs only PR-**touched** root tests and #3356 touched
neither.

**Residual sweep:** ran 6 more closure/standalone suites in the same blast
radius (3468, 3472, 3436, 3534, 3546, 3501) — all green, 47 passed. No further
rot found there.

## Task #7 — auto-park step awareness (#3597, PR #3585)

The bot threw away `steps[]` (`--jq '.jobs[] | {name, conclusion}'`), so
job-level `failure` was identical for "artifact download died" and "verdict
fired". On 2026-07-24 that produced three parks, two textually identical for
opposite causes (#3566 bogus infra 403, #3563 genuine trap regression, #3581
duplicate id).

- Comment now names the failing **step** + job log + `Run:` URL.
- `classifyRun` gains `infraOnly` / `unclassifiable` / `shouldPark`.
- **Conservative by construction**: park is the DEFAULT; skip only on positive
  evidence that every failed step is infra. Unidentifiable step ⇒ park.
- `--self-check` 10 → 23; `tests/issue-3597-auto-park-step-aware.test.ts` 48
  cases; added to the guard suite.

**Advisor review caught that my patterns were written from prose, not data.**
Grounding them in the real step inventory found two live gaps: `Upload merged
reports` / `Download merged reports (full-matrix path)` / `Upload regressions
report` carry **no "artifact" token**, and `Retry shard artifact upload…` puts
the noun **first**. Both are now covered and the **real** step names — infra
_and_ verdict — are pinned in the test so a workflow rename surfaces there.
Also verified end-to-end that the list endpoint really returns `steps[]` through
that exact `--paginate --jq` (one compact object per line), so `fetchJobs` is
not a silent no-op.

Deferred (recorded in the issue): retry the artifact download in
`test262-sharded.yml` — removes the #3566 failure at source, but workflow-level
with its own validation needs.

## Task #8 — standalone statusline source (#3598, PR #3590)

Semantic bug, not staleness. `promote-baseline` **already writes**
`benchmarks/results/test262-standalone-current.json`, but `stage_files()` never
staged it, so it was produced on every push to `main` and discarded. The only
committed standalone file was the **high-water mark** (a #2097 best-ever floor,
never a current rate) → 56.1 % vs ~63 %. One-line `git add -f`; `PROMOTE_FILES`
derives from `git diff --cached`, so the snapshot/re-apply path follows.

**End-to-end proof is pending**: the first `promote-baseline` run on `main`
after PR #3590 merges should show the file in that `[skip ci]` commit. CI cannot
exercise the promote path, so this is worth one glance then.

The statusline consumer side is wired separately (not in my PR). Preserve: the
`[ -f … ]` stat guard before any `git show` — **`git show` costs ~13 s here**;
unguarded it blew the statusline timeout (exit 124, blank bars).

## Process findings worth keeping

1. **`claim-issue.mjs --allocate --no-pr-scan` is not safe under concurrent
   lanes.** Both of my collisions (3584, 3590) came from `--no-pr-scan`; every
   full-scan allocation held. The collisions only surface in the `quality`
   gate after CI runs, costing a full round-trip each. Consider making the PR
   scan the default.
2. **Another session is writing to the same fork.** A "PR-queue shepherd" pushed
   a renumber commit to my `issue-guard-gen-fnexpr-dispatch` branch (its message
   says the authoring session was unreachable). Their fix was correct and
   complete — I adopted it and dropped my duplicate — but the tech lead did not
   dispatch that shepherd, so concurrent writers to the same branches exist.
3. **The #3008 per-PR gate does not cover script-only edits.** It runs changed
   `tests/*.test.ts`, not tests _related to_ changed scripts — which is why the
   auto-park test needed a `guard-suite.json` entry to be guarded at all.
4. **`TaskList`/`TaskUpdate` were genuinely unavailable** in this session (not
   deferred tools — they are absent from the tool set). Task state was managed
   by the tech lead via SendMessage throughout.

## If someone picks up #3591 (the real fix)

Start from the two candidates in the issue. Candidate 1 (late-fill the
resume-method dispatch, mirroring `fillNativeIteratorLateArms`) is the more
general one — it also covers any future late registration, not just the
two-pass module-init case. The four `it.skip`s in `tests/issue-3164.test.ts` /
`tests/issue-3386.test.ts` are the acceptance test; search `#3591`.
