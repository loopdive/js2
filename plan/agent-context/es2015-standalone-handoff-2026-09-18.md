# ES2015 standalone close-out — session handoff, 2026-09-18

Goal: `100% es2015 test262 standalone pass rate` (umbrella
[#4444](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4444-es6-standalone-edition-closeout-umbrella)).
Session ran as the plan lane (Fable role) with Opus implementation subagents.

## TL;DR for whoever picks this up

1. **Read the ranking in #4444 first** (landed via PR #5973). It splits the
   remaining 1,401 ES2015 standalone non-pass rows into **559 mirrorable**
   (host already passes — the fix is a port) and **842 dual-lane** (host fails
   too — new engineering in both lanes). Those had been planned as one pile.
   Dispatch from that table, not from raw standalone counts.
2. **`claude/es6-5198-regexp-exec-protocol` carries measured but UNREVIEWED
   work** — +7 rows / 0 lost on the 190-row cluster, no PR opened. Its base run
   independently reproduces this session's own measurement, which is a real
   check; the open items are listed in §Unfinished below. Do not merge it
   without them.
3. **Measure the host side before sizing any standalone slice.** Doing that
   once cut #5198's first slice from a projected 43 rows to an honest 9.

## Landed this session

| PR | issue | what |
| --- | --- | --- |
| #5968 | #6493 | first-class `Function.prototype.call/apply`, `[object Error]` tag |
| #5969 | #6494 | six standalone Proxy/Reflect paths that must throw now throw |
| #5970 | #6500, #6501 | packed TypedArray `reverse()` compiles; four helper-routed mutators validate a detached view |

Open at hand-off:

| PR | state | note |
| --- | --- | --- |
| #5971 | in merge queue | #2864 generator carrier — **ZERO measured rows, capability only**; the PR body says so first |
| #5973 | `blocked` (awaiting checks) | docs-only, the #4444 ranking |

## The measurement that should drive the next session

Standalone side: 2026-09-17 full standalone run. Host side: the **authoritative
PR-gate baseline** (`scripts/fetch-baseline-jsonl.mjs` →
`.test262-cache/test262-current.jsonl`, internal timestamp 2026-09-17 11:17,
`oracle_lane: linked-harness`, `oracle_version: 14`).

**Do NOT use `benchmarks/results/test262-current.jsonl`** — it reads
**2026-05-21** internally, four months stale, and ranking work on it is exactly
the "stale artifact restated as a measurement" failure this repo has been bitten
by before.

Both counts predate this session's three merges, so they are a low-water mark
by roughly a dozen rows. Re-derive rather than quoting them forward.

Top clusters by mirrorable rows: `built-ins/RegExp/prototype` 86/24,
`built-ins/TypedArray/prototype` 38/41, `language/statements/class` 32/79,
`language/expressions/generators` 26/24, `annexB/built-ins/RegExp` 9/0,
`built-ins/{Set,Map}IteratorPrototype/next` 5/0 each. Full table in #4444.

The three zero-dual clusters (`annexB/built-ins/RegExp`,
`SetIteratorPrototype/next`, `MapIteratorPrototype/next`) are pure ports with
no dual-lane residue — the cheapest untouched work on the board.

## Unfinished: #5198 RegExp `exec` protocol — measured, no PR

Branch `claude/es6-5198-regexp-exec-protocol`. Commit `0b107a88d0` carries the
**plan only** (a new dated section in `plan/issues/5198-es2015-standalone-regexp-r2.md`). An Opus lane was
implementing slice 1 when the session ended.

**State at hand-off — measured, but NOT yet reviewed or merged:**

The lane finished its measurement before the session closed. Commits on the
branch, newest last:

| commit | what |
| --- | --- |
| `0b107a88d0` | the plan (docs only) |
| `80c35d9d69` | `wip(#5198): RegExpExec slice-1 in progress — NOT fully validated` |
| `3b41aeec28` | `docs(#5198): record slice-1 measurement — +7 rows, 0 lost, byte-inert` |

Claimed result: 190-row cluster, two frozen trees, per-path diff — base
86/95/9, branch **93/88/9**; **+7 gained, 0 lost**; byte-inertness proved over
30 binaries (15 non-escaping RegExp programs x {standalone, gc}) sha256-identical.

**Why that is worth some trust and still not a free pass:** the lane's BASE run
(86 pass / 95 fail / 9 compile_error) reproduces an independent measurement of
the same cluster made earlier in the session, on a different tree — so the two
sides agree on the starting point. +7 against a projected 9 is also the honest
direction: it declined 2 global-`@@match` rows deliberately.

**Before opening or merging a PR from this branch, get from the lane (or
re-derive):** the 7 gained rows by path, the 2 declined rows and why, the
prescan-shape deviation from the plan, the list of what the lane itself flagged
as still unproven, and which gates were run bare with their exit codes —
specifically `LOC_GATE_BASE=$(git rev-parse origin/main) node
scripts/check-loc-budget.mjs` and `npm run -s test:equivalence:gate`. No PR was
opened for this branch during the session.

**The diagnosis is solid and does not need redoing** (probe-verified, with
controls, on `origin/main` `a8b8dfc180`):

For a receiver the compiler types as `RegExp`, the standalone
`@@match`/`@@replace`/`@@search`/`@@split` lowering runs the native regex
engine directly and performs **no observable spec step at all** — no
`Get(R,"exec")`, no `Call`, no `Get(result,"0"/"index"/"length"/"groups")`, no
`Get`/`Set` of `lastIndex`, no `@@species` lookup.

190 rows in that cluster: standalone 86 pass / 104 non-pass; host 149 / 41. The
104 break down as exec-override 43, `lastIndex` 22, `@@species` 21, flag getters
11, coercion 8, other 7 — all one root cause.

**Slice 1's honest target is 9 rows, not 43.** Only 17 of the 43 exec-override
rows pass in host; the other 26 fail there too and are not portable. The 9 are
`Symbol.match/{builtin-success-g-set-lastindex-err, exec-err, exec-invocation,
exec-return-type-invalid, exec-return-type-valid, g-get-result-err,
get-exec-err}` plus `Symbol.search/{set-lastindex-init-samevalue,
set-lastindex-restore-samevalue}`. The other 8 host-passing exec-override rows
are `@@replace` — slice 2.

**Substrate already works** (probed, `imports: []`): assigning and calling
`r.exec`, reading it back, generic `Get` on an arbitrary result object, and a
poisoned accessor throwing. This is wiring, not new runtime. Host already
implements the protocol correctly — **mirror the host path** rather than
deriving the spec from scratch; the prescan/slow-path design in the plan (after
#802 `dynamic-proto.ts`: prescan → mark → conditional slow path →
byte-identical when unmarked → kill switch) is the fallback if mirroring proves
impossible.

## Traps this session actually hit — worth not repeating

- **RegExp probe spelling is load-bearing.** `const r: any = /./` takes a
  *different* dispatch path than test262's `var r = /./` (inferred `RegExp`) and
  answers differently — on the `any` path `exec` returns `null` where Node
  returns a match. Measuring the cluster through the `any` spelling produces a
  wrong diagnosis. Always probe with `var r = /./`.
- **`body.unshift` onto a shared native is hazardous.** #6494's first cut
  prepended a guard to `__extern_length`, colliding with the TypedArray dyn-view
  arm `ta-dyn-mop.ts` already unshifts there; −439 rows in the merge_group while
  every PR-level signal was green. Same hazard had already been found for
  `__extern_get_idx` in the same PR and the second instance was missed.
  Follow-up: #6506.
- **A green PR-level `check for test262 regressions` is a designed no-op.** The
  real gates run in the `merge_group` on the merged state. That is why
  auto-park exists.
- **`BEHIND` alone → do nothing.** `auto-refresh-prs` owns refreshes; merging
  main in yourself restarts ~10 min of CI and is the documented livelock (repo
  steward skill).
- **`node scripts/fetch-baseline-jsonl.mjs` exiting 0 does not mean the cache is
  current.** Check the file's internal timestamp yourself.
- **Never pipe a gate whose status you need** (`gate | tail` reports `tail`'s
  status). Run bare.

## Separate defects found while measuring, deliberately left out of scope

- **`exec` through an `any`-typed receiver returns `null`** in standalone where
  Node returns a match; `test` on the same receiver is correct, and a typed
  receiver is correct. Narrow, real, and **0 ES2015 rows behind it** (test262
  writes `var r = /./`, which infers `RegExp`) — a correctness gap, not a
  conformance lever. Needs its own id.
- **#6506** — the revoked-proxy `__extern_length` guard, filed `ready`, not
  started. Any fix must be validated against `%TypedArray%.prototype.set`; a
  probe that merely reads a length stays green while the arm-spliced paths
  break, which is exactly how the −439 shipped.
- **#4444 cross-realm is a dead end.** 103 rows, of which 12 need cross-realm
  `eval` and only 5 are winnable by an honest shim. Aliasing realms makes tests
  pass vacuously *and* fails the distinctness rows. Do not spend on it.

## Codex-lane takeover

The user directed taking over the codex lane (generators, regexp, promise,
destructuring). Its open PRs are stale checkpoints — notably **#5393**
(`codex/5198-regexp-exec-slice-b-checkpoint`), a draft, dirty, tests-only
checkpoint whose own description says "production source remains unchanged",
pins "intentionally red", "incomplete and non-mergeable". Its 11-row hand-picked
custom-`exec` matrix is a subset of the 43 measured here.

**Do not delete or "fix" #5393's red pins** — they are a legitimate record of
the gap. Whether it is superseded or rebased is a call for whoever owns it once
slice 1 lands.

Its #5198 plan (the 2026-09-13 section) is row-by-row: 5 named rows across 3
PRs. Nothing in it is retracted — the sticky-cursor and `lastIndex` identity
analyses stand, and its **measured** finding that `ctx.nonWritableExternKeys` is
compile-time rather than branch-aware and unsound for the `lastIndex` rows
should not be re-derived.

## Open PR hygiene

`auto-enqueue.yml` is the single enqueuer. **Never enqueue or re-enqueue from an
agent.** `UNSTABLE` is never auto-enqueued — a red *non-required* check strands
a PR whose required checks are all green; re-run the failed job to get back to
`CLEAN`. A bot `hold` means a real merged-baseline regression: diagnose the
cited run before touching the label.
