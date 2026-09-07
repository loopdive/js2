---
id: 4444
title: "UMBRELLA: ES6 (ES2015) standalone authoritative 11,704-row close-out → 100%"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-09-01
assignee: codex/es6-test262-closeout
priority: high
horizon: xl
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [2860, 2864, 2865, 2867, 2906, 3032, 3178, 2161, 2175, 2158, 2159, 4445, 4446, 4447, 4449, 4450]
---

# #4444 — UMBRELLA: ES6 (ES2015) standalone edition close-out

## Handover (2026-09-06, session claude/es6-test262-standalone-g10c7u, wave 5)

ES2015 standalone stood at **10,188 / 11,704 (87.0 %)** after wave 4 (#5604)
landed on 2026-09-05. Wave 5 ran six lanes from Fable-written plans (Opus
medium, Opus high for the Proxy lane, Sonnet high for the mechanical lib.dom
fix), each followed by an adversarial review (one reviewer, two skeptics per
finding) and as many reviewed fix rounds as the reviewer kept finding real
defects. PR-1 integrates five lanes; #5349 (species / byte-vec brand) is still
in its round-3 audit and ships as PR-2.

| lane | shipped | owned rows (base → lane) | control | review rounds |
| --- | --- | --- | --- | --- |
| #5316 Proxy r5 (Opus high) | integrity bag learns the instance carrier; gopd fold asks the native on a guard miss; `in` stops folding over a Proxy; §10.5 clauses restored; false PreventExtensions/SetPrototypeOf status; `Reflect.set` with receiver (§10.1.9.2), receiver-Proxy define route, target-Proxy set trap with receiver, non-Object TypeError | +16 (Proxy+Reflect 350 → 366) +1 (integrity) | 464 + 317 rows, 0 lost | review → fix round → clean |
| #5350 super property r1 | class [[HomeObject]] read, base-before-key element read, `extends null` TypeError, uninitialised-`this` guard (lexical + runtime flag), object-literal `super.m()` incl. accessor bodies, `__proto__:` literal links its prototype, callable check | +8 on the 53-row super control (18 → 26; 2 of them main drift), 6 / 13 target rows | 53 rows, 0 lost; 1,089-row class/super control run on the integrated tree (see PR) | review + 5 fix rounds (rounds 3–5 on the loop guard; round 5 by Fable) |
| #5318 class r4 round 2 | tri-state static-accessor gate with a hardened syntactic walker; object-literal evaluated-key accessors; later same-key members DEFINE; host `__proto__:` after a dynamic accessor; spread after a same-key accessor copies via define | +2 (`computed-property-names/object/accessor/{getter,setter}`) | 61 rows identical; 783-row class sweep 0 lost | review + 3 fix rounds |
| #3371 Reflect.construct r2 | nested-function `new.target` stop, symbol-resolved binding count, dynamic in-file targets gated on their whole value set, JSDoc/annotation refusals, `neverConstructed` for named function expressions, destructuring-assignment writes | +10 (218-row control 156 → 166); fix rounds 0 net, ~14 wrong-answer admissions turned back into refusals | 218 + 24 rows, 0 lost; 89-file probe corpus 0 base drift | review + 3 fix rounds |
| #5351 lib.dom shadow (Sonnet high) | a user top-level binding excludes the same-named lib.dom ambient from the import set, scoped per source file | +6 (24 leak rows: 24/24 import-free, 6 pass, 18 now fail on unrelated gaps) | 40-name sweep, 24 rows, byte identity | review → fix round (multi-file scoping) → clean |
| #5349 species r5 (PR-2) | Array ctor null TypeError, defineProperty arming, `ArrayBuffer.prototype.slice` SpeciesConstructor; round 2 brands `$__vec_i8_byte` (`final`) vs the open `$__vec_i32_byte` so step 16 discriminates; round 3 audits every cast/test site that relied on the old identity | +19 measured on the lane (57-row target set 6 → 25), 3,147-row TA/AB/DV control 0 lost on round 2 | in round 3 (Opus high) | review + 2 fix rounds so far |

Expected ES2015 delta from PR-1: roughly +43 owned rows plus collateral; take
the real figure from the promoted baseline. Every number above was measured
with `scripts/run-test262-paths.mts --isolate --standalone` against a
`git archive` base tree with its own compiler bundle and quickjs adapter.

**Residuals carried forward, each with its mechanism in the issue file.**
#5350: a `super.x` read that is genuinely reached before a nested function's
`super()` answers a value instead of throwing (only a flag the nested function
could store would decide it; the r4/r5 records explain why the
never-invent-a-throw direction was chosen); reads inside an arrow inside a
loop (xa8); `super.missing?.()`; `Math.max` as a super member; the 7 rows
blocked by the block-scoped-class captured-`var` write defect. #5318: standalone
`__proto__:` after a dynamic accessor (1010 on every tree); `u: undefined`
member after an accessor traps on every tree. #3371: three conservative
refusals of shapes base also refused (g1h/g2h/g2i); `let T = (function(){…})`
answers 4 on base too; x1/x2 plain-`new` new.target misreads. #5316: the
TypedArray integer-index arm for `Reflect.set` (six rows), `with(proxy)`
re-entrancy (2 rows), `instanceof` fold. #5351: hoisted `var` in a top-level
block / destructuring still leaks (pre-existing). New issues filed: #5359
(for-in + spread over a TypedArray emits invalid wasm).

**Next, in order.** (1) Land PR-2 (#5349 round 3) — the brand split is
architecturally right and unblocks `ArrayBuffer.isView` /
`Object.prototype.toString` precision, but every `ref.cast`/`ref.test` on the
two byte vecs must dispatch on both types; its 3,147-row control is the gate.
(2) #5350's block-scoped-class captured-`var` defect (7 target rows) and the
`u8.buffer` snapshot-copy family found by the #5349 probes (t1/t2/t11/t17). (3)
The TypedArray cluster (187 non-pass rows) once #5349 lands. The sibling
issues #2864 / #2867 / #2175 stay with the other team.

**Lessons this wave added** (the wave-4 list below still holds):

- **Static predicates over dynamic facts converge only by review.** #3371 took
  three rounds and #5350 five because each rule admitted a shape the previous
  reviewer had not probed; each round's reviewer found the next hole in under an
  hour. Budget the review loop, not the first implementation.
- **A representation identity is load-bearing wherever a `ref.cast` never
  trapped.** Splitting `$__vec_i8_byte` from `$__vec_i32_byte` (#5349 round 2)
  was one line and correct, and it exposed three emitters that cast a typed
  array to a buffer "because it always worked". Grep every cast site before
  changing a canonical type, not after the review.
- **Compare a fix tree against the tree it was cut from, never against the
  lane snapshot.** Integration-branch drift (a new import, a new module)
  produces false host-byte positives; two reviewers lost time to it.
- **Host-target probes need `importObject.__setInstance(instance)`.** Without
  it the open-object model is dead and every host answer is wrong on base too;
  one review round's host findings were re-measured after this was found.
- **A finisher agent beats a rerun after a container restart.** Fix commits
  survive; a finisher prompt that names them, resumes the chunked driver (skip
  `.done`, delete the partial chunk) and writes the record saved ~5 h of
  control runs.

## Handover (2026-09-05, session claude/es6-test262-standalone-g10c7u, wave 4)

ES2015 standalone stood at **10,131 / 11,704 (86.6 %)** after #5576 landed
(2026-09-04). Wave 4 ran four Opus-medium lanes from Fable-written r4 plans,
each followed by an adversarial review (one reviewer, two skeptics per finding)
and a reviewed fix round; this PR integrates all four:

| lane | shipped | owned rows (base → lane) | control | review outcome |
| --- | --- | --- | --- | --- |
| #5317 TypedArray | `join` separator arming, `fill`/`copyWithin` end argument | +11 | 259 rows, 0 lost | one inert-fix finding, fixed and re-reviewed |
| #5316 Proxy | §10.5 descriptor-model invariants (step 1) | +19 (0 → 19) | 464 rows, 348 vs 312, 0 lost | wasi false positives → wasi gate, re-reviewed clean |
| #5318 class | computed accessor names, §15.7.14 sidecar order, compiled-body receiver gate | +24 | 783 rows, 246 non-pass vs 271, 0 lost | order + trap fixed; one over-decline left for round 2 (recorded in the issue) |
| #3371 Reflect.construct | runtime `Get(NT,"prototype")`, bound-function `[[Construct]]`, ordinary-construct driver, refusal gate | +11 (+9 collateral in `Function/prototype/bind`) | 218 rows, 166 vs 156, 0 lost | five refusal→wrong-answer findings, all closed by restoring base's refusal |

Expected ES2015 delta on the merge-group report: roughly +65 owned rows plus
collateral; take the real figure from the promoted baseline, not from this
table. Every lane's numbers were measured with
`scripts/run-test262-paths.mts --isolate --standalone` against a
`git archive` base tree, never inferred.

**Next, in order.** (1) #5316 item 1 — the standalone attribute model through a
proxy dispatch — unblocks the most rows per fix (gopd rows, the declined
`IsExtensible` clause, and step 2's `Reflect.set` receiver). (2) #5318 round 2
(nested-class static accessors, plan in the issue) and its dstr slice (16 rows).
(3) #3371 r1 residuals — the 12 rows each need a named mechanism the issue
lists; `new.target` as a runtime value (2 rows) is the largest. (4) #5317's
163 residual rows by family, 14 of them gated on builtin-method reflection
(#2175, other team). The three sibling issues #2864 / #2867 / #2175 stay with
the other team.

**Lessons this wave added** (the 2026-09-04 list below still holds):

- **A container restart kills every running Workflow agent and leaves its
  journal without a result.** Worktrees, commits and the pushed branch survive;
  relaunch with `Workflow({scriptPath, resumeFromRunId})` — an empty journal
  simply re-runs the agent. Two agents were lost this way on 2026-09-05.
- **The quickjs eval adapter is keyed on the compiler-bundle hash.** Rebuild
  `scripts/build-quickjs-eval-provider.mjs` AFTER the last `src/` edit, or
  every runtime-eval row fails with "provider is not built" and reads as a
  regression. Two lanes lost a measurement cycle to this independently.
- **Under load ≥ 6 on this 4-core box, rows time out at compile** (the pool's
  15 s budget), and a control corpus reports phantom losses. Re-run any
  compile_timeout alone at `COMPILER_POOL_SIZE=1` before it counts; the
  120 s per-row budget in `run-test262-paths.mts` does not cover the pool's
  own budget.
- **"Refusal → wrong answer" is the review class that matters for a runtime
  arm.** #3371's r4 lane bought 11 rows with seven silent wrong answers on
  programs base had refused; the fix round restored the refusal for each. A
  reviewer prompt must ask for programs base REFUSED, not only programs base
  ran correctly.
- **Merge-queue shepherding in parallel is cheap and worth it:** four stuck
  PRs (#5578 needing a manual enqueue, #5585 with no CI run, #5594's plain-node
  import fix for the npm-compat refresh, #5593) all landed while the lanes ran.

## Handover (2026-09-04, session claude/es6-test262-standalone-g10c7u)

### Where the goal stands

ES2015 standalone: **10,079 / 11,704 (86.1%)** on the baseline promoted after
PR #5561 (02:45 UTC). Day 2026-09-03 → 09-04 landed seven PRs (#5505, #5526,
#5527, #5534, #5550, #5558, #5561): 9,905 → 10,079, **+174 rows**. The
compile_error count did not move (380) — every wave was `fail` work.

### What is in flight (this PR and the lanes behind it)

| lane | issue | worktree / branch | state at handover |
| --- | --- | --- | --- |
| class | #5195 | `.claude/worktrees/wf_16f0b7f5-bf0-5` / `worktree-wf_16f0b7f5-bf0-5` | **in this PR** — r3-2/4/5/7 kept, r3-3 reverted; three review rounds; 19 rows |
| proxy + reflect | #5196 | `.claude/worktrees/wf_16f0b7f5-bf0-3` / `worktree-wf_16f0b7f5-bf0-3` | **in this PR** — R3-0/2/4/3-E2 + review fixes F1–F6; +20 rows; F9 (WASI-only trap where main compile-failed) recorded, not fixed |
| for-of + collections | #5267 | `.claude/worktrees/wf_9d1e6808-4e2-1` / `worktree-wf_9d1e6808-4e2-1` | **in this PR** — five steps kept, R3-6 reverted after review; 15 rows |

### What the next session should do first

1. **Watch the open PR** from `claude/es6-test262-standalone-g10c7u` until the
   merge queue lands it; a `github-actions[bot]` `hold` is a real merged-baseline
   regression — diagnose the cited run, fix on the branch, re-enqueue once.
2. **Refetch the standalone baseline and re-run the census**
   (`node scripts/fetch-baseline-jsonl.mjs --standalone --force`, then
   `.tmp/census0903/census.mjs` — the script is not committed; it is a 40-line
   reader of `test262-file-editions.json` + the baseline JSONL, easy to recreate).
3. **The CE mass is the next frontier**: expressions 96, class 56, promise 50,
   generators 46, for-of 36 compile_errors. A compile_error is a refusal to emit,
   so these need features, not fixes — plan them as such. #2864 (native
   generator carrier) gates 233 rows across seven clusters and is claimed and
   live in another lane: never start a parallel implementation.
4. Lanes handed over unshipped (if any, per the table) resume from their
   worktree branch: merge `origin/main` first, then the issue's Handover steps.

### Process lessons from this session (load-bearing)

- **A random 1,200-row sample of baseline-passing standalone rows through the
  CI harness** (`TEST262_PATH_FILTER_FILE` with `test/`-prefixed paths,
  `run-test262-vitest.sh`, quickjs oracle) **before every wave PR** caught the
  #5534 merge-queue park that three review rounds and all gates missed. Every
  flagged row is A/B'd against a `git archive` of `origin/main`; local artifacts
  to expect: `RegExp/regexp-modifiers/*` compile errors (fail on main too), a
  `compile_timeout` under load (re-run alone), and a "quickjs provider is not
  built" failure in a worktree missing the `.test262-cache/quickjs*` links.
- **Adversarial review with skeptics, repeated on each fix round.** Of ten
  waves reviewed this way, nine shipped-or-would-have-shipped a confirmed
  regression the lane's own row list, controls, five gates and 8-shard
  equivalence run all missed. Fix rounds are new code: review them too (the
  class lane needed three rounds; a typedarray fix's "single struct.new site"
  claim missed a second site and every module on that path failed Wasm
  validation — grep, do not trust).
- **The failure family to hunt for is "a working program now throws"**: every
  confirmed regression across the class and proxy lanes was a "provable"
  predicate (heritage is not a constructor, chain is all classes, alias is the
  Proxy constructor, revoker is non-constructable) that resolved by NAME or by
  declaration shape without a single-assignment / shadowing proof. Decline to
  base unless the proof holds under reassignment, destructuring, loop heads,
  parameters, `eval`/`with`, and shadowing.
- **Environment**: worktree `node_modules` / `test262` were symlink CHAINS
  through sibling worktrees — removing a shipped worktree broke the others.
  Link them directly to `/home/user/js2/node_modules` and
  `$(readlink -f /home/user/js2/test262)` before removing any worktree. The
  vitest fork heap must be 4 GB for suites that link the runtime-eval provider
  (`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, single fork) — including the pre-push
  hook, so push in the background with that variable set. `--target wasi` does
  NOT set `ctx.standalone`; measure each arm on the targets its gate reaches.
- **CI is node 25, the container is node 22.** A node-oracle assertion
  (`new Function` in a test) can hold on one and not the other: V8 in node 25
  no longer gives sloppy functions own `caller`/`arguments`, so a pin that
  asserted node's answer for `G.caller` (class extending a plain function)
  failed only in CI. Probe the running engine instead of asserting a fixed
  answer, and run the changed test files under node 25 before pushing
  (`npx -p node@25` fetches one; `PATH=<its bin>:$PATH` puts the vitest
  forks and the compiler pool on it).
- **A merge-group shard that hits its 40-minute cap with no bot hold is a
  runtime wedge, not a slow family — and the PR-level checks cannot see it.**
  Fixture-graph rows (`language/module-code/**` self-imports and
  `_FIXTURE` graphs, ~200 rows) execute IN-PROCESS in the vitest fork
  (`tests/test262-shared.ts`), outside the compiler pool's 30 s kill, so one
  infinite loop caps the whole shard; the pattern is bimodal (13-18 min or
  40 min) and deterministic per shard set. The 2026-09-04 instance: the
  widened `identifierIsWrittenTo` counted `X.prop = v` as a write to X, which
  made `Test262Error` (sta.js assigns its prototype's `toString`) read as
  reassigned in EVERY row, declined the `new` fold everywhere, and the dynamic
  fallback looped on `namespace/internals/is-extensible.js`. Diagnose by
  reproducing one hung shard locally with CI's env (`TEST262_CHUNK_INDEX` /
  `TEST262_CHUNK_TOTAL` on `tests/test262-chunk-dynamic.test.ts`, the quickjs
  adapter built for the current bundle — without it eval-dependent rows fail
  fast and the wedge is invisible), then `node --prof` the single row through
  `runTest262File`. Artifact downloads from `blob.core.windows.net` are blocked
  by the container proxy, so the partial shard JSONL is not reachable.
- **Model attribution**: workflow agents inherit the session model unless the
  script pins `model`; after the `/model` switch, unpinned "Opus" agents ran on
  Fable 5.1 — two `Model:` trailers had to be rewritten (unpublished commits
  only). Pin `model: 'opus'` explicitly when the directive says Opus.
- **Operational**: never `pkill`/`pgrep` a pattern that appears in your own
  command line (it killed the integrator shell twice); kill by PID after a
  cwd check, and only when your own cwd is not that worktree. A test262 batch
  silent for 15 minutes is a pre-existing compile hang (labelled
  continue/break over nested for-of with closures) — kill and split it.

## 2026-09-04 census — 10,079 / 11,704 (86.1%) after #5561

Baseline refetched 2026-09-04 02:45 UTC (`oracle_lane: "honest"`, promoted
from the merge of PR #5561 — typedarray r3, #5194), same script and edition
map as the censuses below.

**10,079 pass / 11,704 (86.1%) — 1,625 non-pass** (1,244 fail · 380
compile_error · 1 compile_timeout): **+41 rows** over the post-#5558 census.
The rows sum to 1,625.

| Cluster | rows | fail | CE |
| --- | ---: | ---: | ---: |
| expressions | 228 | 131 | 96 |
| typedarray | 201 | 183 | 18 |
| class | 191 | 135 | 56 |
| other built-ins | 168 | 160 | 8 |
| proxy + reflect | 155 | 131 | 24 |
| regexp | 139 | 129 | 10 |
| generators | 121 | 75 | 46 |
| array + object | 121 | 111 | 10 |
| promise | 101 | 51 | 50 |
| for-of + collections | 98 | 62 | 36 |
| statements + lang | 75 | 55 | 20 |
| module-code | 25 | 19 | 6 |
| rest | 2 | 2 | 0 |

Day total since the 2026-09-02 census (9,905): **+174 rows** across seven
PRs. The compile_error count is unchanged at 380 across all of them — every
wave was `fail` work; the CE mass (expressions 96, class 56, promise 50,
generators 46, for-of 36) is what the next plans must open.

## 2026-09-04 census — 10,038 / 11,704 (85.8%) after #5558

Baseline refetched 2026-09-04 01:17 UTC (`oracle_lane: "honest"`, promoted
from the merge of PR #5558 — promise r3, #5197), same script and edition map.

**10,038 pass / 11,704 (85.8%) — 1,666 non-pass** (1,285 fail · 380
compile_error · 1 compile_timeout): **+17 rows** over the post-#5550 census.
The rows sum to 1,666.

| Cluster | rows | fail | CE |
| --- | ---: | ---: | ---: |
| typedarray | 242 | 224 | 18 |
| expressions | 228 | 131 | 96 |
| class | 191 | 135 | 56 |
| other built-ins | 168 | 160 | 8 |
| proxy + reflect | 155 | 131 | 24 |
| regexp | 139 | 129 | 10 |
| generators | 121 | 75 | 46 |
| array + object | 121 | 111 | 10 |
| promise | 101 | 51 | 50 |
| for-of + collections | 98 | 62 | 36 |
| statements + lang | 75 | 55 | 20 |
| module-code | 25 | 19 | 6 |
| rest | 2 | 2 | 0 |

Day total since the 2026-09-02 census (9,905): **+133 rows** across #5505,
#5526, #5527, #5534, #5550 and #5558. The compile_error count has not moved
(380) — every wave so far was `fail` work; the CE mass is the next frontier.

## 2026-09-03 late census — 10,021 / 11,704 (85.6%) after #5550

Baseline refetched 2026-09-03 23:31 UTC (`oracle_lane: "honest"`, promoted
from the merge of PR #5550 — array + object r3, #5268), same script and
edition map as the two censuses below.

**10,021 pass / 11,704 (85.6%) — 1,683 non-pass** (1,302 fail · 380
compile_error · 1 compile_timeout): **+15 rows** over the evening census.
Array + object went 135 → 121 (−14), typedarray 243 → 242 (−1); every other
cluster is unchanged, and the rows still sum to 1,683.

| Cluster | rows | fail | CE |
| --- | ---: | ---: | ---: |
| typedarray | 242 | 224 | 18 |
| expressions | 228 | 131 | 96 |
| class | 191 | 135 | 56 |
| other built-ins | 168 | 160 | 8 |
| proxy + reflect | 155 | 131 | 24 |
| regexp | 139 | 129 | 10 |
| generators | 121 | 75 | 46 |
| array + object | 121 | 111 | 10 |
| promise | 118 | 68 | 50 |
| for-of + collections | 98 | 62 | 36 |
| statements + lang | 75 | 55 | 20 |
| module-code | 25 | 19 | 6 |
| rest | 2 | 2 | 0 |

The lane had measured +21 directory rows on `Array/{from,of}` + `concat` +
`hasOwnProperty`; the census counts only ES2015-edition rows, which is where
the difference comes from — no row was lost in the queue (the merge-group
shards passed and the standalone floor held).

## 2026-09-03 evening census — 10,006 / 11,704 (85.5%), +58 from the day's second wave

Source: the standalone baseline refetched 2026-09-03 20:11 UTC (`node
scripts/fetch-baseline-jsonl.mjs --standalone --force`, `oracle_lane:
"honest"`), after PR #5534 (expressions r2, #5270) merged at 19:54; same
script (`.tmp/census0903/census.mjs`) and edition map as the morning census
below, so the cluster sizes are comparable with that table only.

**ES2015 standalone: 10,006 pass / 11,704 (85.5%) — 1,698 non-pass**
(1,317 fail · 380 compile_error · 1 compile_timeout), up from **9,948
(85.0%)** in the morning: **+58 rows**, from #5527 (built-ins r2, #5269:
other built-ins 197 → 168) and #5534 (expressions r2, #5270: expressions
244 → 228). #5534 parked once in the merge queue — a 325-row standalone
drop from a mint-time `return_call` against placeholder async function
types, invisible at PR level; the localisation method and fix are recorded
in #5270 and the lesson is now part of the wave pipeline: a random ~1,200-row
sample of baseline-passing rows, every flagged row A/B'd against a git
archive of `origin/main`, runs before each wave PR.

| Cluster | rows | fail | CE | owner / state (evening) |
| --- | ---: | ---: | ---: | --- |
| typedarray | 243 | 225 | 18 | #5194 r3 — implemented, round-3 review fixes in flight |
| expressions | 228 | 131 | 96 | #5270 r2 landed (#5534); residual is mostly CE |
| class | 191 | 135 | 56 | #5195 r3 — implementer suspended (WIP patch kept), re-dispatch |
| other built-ins | 168 | 160 | 8 | #5269 r2 landed (#5527); no r3 planned yet |
| proxy + reflect | 155 | 131 | 24 | #5196 r3 — implementer suspended (WIP patch kept), re-dispatch |
| regexp | 139 | 129 | 10 | #5198 codex lane (checkpoint PR #5393) |
| array + object | 135 | 125 | 10 | #5268 r3 — validated, shipping in this PR |
| generators | 121 | 75 | 46 | #2864 claimed and live; 233 rows across clusters gate on it |
| promise | 118 | 68 | 50 | #5197 r3 — validated, ships next |
| for-of + collections | 98 | 62 | 36 | #5267 r3 planned, not yet dispatched |
| statements + lang | 75 | 55 | 20 | residual unowned |
| module-code | 25 | 19 | 6 | #4759 codex closeout lane |
| rest | 2 | 2 | 0 | unowned |

The rows sum to 1,698, so coverage is still complete. The compile_error
share barely moved (391 → 380): the day's two waves were `fail` work, and the
CE mass sits in `expressions` (96), `class` (56), `promise` (50),
`generators` (46) and `for-of + collections` (36) exactly as in the morning.

## 2026-09-03 census — 9,948 / 11,704 (85.0%), full residual coverage

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` fetched
2026-09-03 08:13 UTC (row timestamps 09:07 UTC, `oracle_lane: "honest"`, i.e.
post-#5461 so every number is leak-checked), edition map
`website/public/benchmarks/results/test262-file-editions.json` (`ES2015`).
Reproduce with `.tmp/census0903/census.mjs`; per-cluster TSVs (path, status,
truncated error) land in `.tmp/census0903/`.

**ES2015 standalone: 9,948 pass / 11,704 (85.0%) — 1,756 non-pass**
(1,364 fail · 391 compile_error · 1 compile_timeout), up from **9,905 / 11,704
(84.6%)** at the 2026-09-02 census: **+43 rows**, from PR #5505 (statements +
language semantics r2, #5271) and the other lanes that landed overnight.

Note the clustering here is the one in `.tmp/census0903/census.mjs`, which
differs from the 09-02 census: `class` and `generators` are pulled out of
`language/expressions` and `language/statements` first, so `expressions` here
collects what is left of `language/expressions/*`. Compare cluster *sizes*
across censuses only via that script, not against the 09-02 table.

| Cluster | rows | fail | CE | owner / state |
| --- | ---: | ---: | ---: | --- |
| expressions | 244 | 147 | 96 | #5270 — lane complete, in validation |
| typedarray | 244 | 226 | 18 | #5194 — r2 landed (#5479), r3 planned 09-03 |
| other built-ins | 197 | 178 | 19 | #5269 — lane complete, in round-3 review |
| class | 191 | 135 | 56 | #5195 — r2 landed (#5489), r3 planned 09-03 |
| proxy + reflect | 157 | 133 | 24 | #5196 — **never dispatched**, r3 planned 09-03 |
| regexp | 140 | 130 | 10 | #5198 codex lane (checkpoint PR #5393) |
| array + object | 137 | 127 | 10 | #5268 — r2 partial (#5494), r3 planned 09-03 |
| generators | 121 | 75 | 46 | #680 / #2864 / #1691 codex lane (PR #5063 held) |
| promise | 118 | 68 | 50 | #5197 — slices B–D landed (#5454), r3 planned 09-03 |
| for-of + collections | 101 | 65 | 36 | #5267 — r2 landed (#5458), r3 planned 09-03 |
| statements + lang | 75 | 55 | 20 | #5271 r2 landed (#5505) — residual unowned |
| module-code | 25 | 19 | 6 | #4759 codex closeout lane |
| rest | 6 | 6 | 0 | unowned |

The cluster sizes sum to exactly 1,756, so **every non-pass row is accounted
for**: 948 in the six lanes planned on 09-03, 441 in the two waves in flight,
286 in codex lanes, and 81 (statements + lang residual, rest) still unowned.

**The 391 compile_errors are the harder half.** They are not spread evenly —
`expressions` (96), `class` (56), `promise` (50), `generators` (46) and
`for-of + collections` (36) hold 71% of them, and a compile_error is a refusal
to emit rather than a wrong answer, so it needs a feature, not a fix. Any plan
that counts rows without splitting fail from CE is over-promising.

### Cross-cutting blockers — 281 rows no cluster lane can fix

Three defects are not clusters at all: they are single missing capabilities
whose rows are scattered across other lanes' residual lists. A cluster plan
that counts them is promising rows it cannot deliver.

| blocker | issue | rows | where they sit |
| --- | --- | ---: | --- |
| standalone native generator lowering | #2864 (claimed, live) | 233 | expressions 91 · generators 46 · class 45 · for-of 35 · statements 13 · module-code 2 · proxy 1 |
| `Reflect.construct` with a distinct NewTarget | #3371 (design checkpoint PR #5400) | 33 | proxy+reflect 11 · typedarray 11 · other built-ins 6 · expressions 2 · promise 2 · array+object 1 |
| `Reflect.set` with an explicit receiver | #2046 (design checkpoint PR #5397) | 15 | proxy+reflect 7 · typedarray 6 · statements 2 |

**281 rows, 16% of the residual.** Net of them, the six lanes planned today can
claim at most: typedarray 227, class 146, proxy+reflect 138, array+object 136,
promise 116, for-of+collections 66. Two caveats on that arithmetic — the 44
`env::Promise_*` leaks inside the promise cluster and the 3 RegExp-engine
refusals inside the regexp cluster are *those lanes' own scope*, so they are
not subtracted; and #3371/#2046 are the proxy+reflect lane's own subject
matter, held at design checkpoints rather than blocked elsewhere, so #5196's
plan should treat its 18 as dependent-on-design rather than out of scope.

Reproduce the split with the predicate in the commit that added this section;
the generator rows are isolated in `.tmp/census0903/_gen.tsv`.

## 2026-09-02 post-wave census — 9,905 / 11,704 (84.6%), +232 rows in one day

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` fetched
2026-09-02 21:06 UTC (row timestamps 20:27–20:41 UTC, i.e. after PR #5494
merged at 19:44 UTC, so every wave below is reflected), edition map
`website/public/benchmarks/results/test262-file-editions.json` (`ES2015`;
11,778 labelled, 11,704 in the official runner scope).

**ES2015 standalone: 9,905 pass / 11,704 (84.6%) — 1,799 non-pass**
(1,407 fail · 391 compile_error · 1 compile_timeout), up from
**9,673 / 11,704 (82.6%)** at the 2026-09-01 evening census: **+232 rows**.

Landed this day (all merged to `main`), in order:

| PR | wave | issue | rows claimed |
| --- | --- | --- | ---: |
| #5454 | Promise slices B–D | #5197 | +19 |
| #5458 | for-of / iterators / collections r2 | #5267 | +37 |
| #5224 | buffers wave 1 | #5150 | +16 |
| #5461 | runner: standalone leak check on the in-process path | #5272 | (honesty fix) |
| #5469 | post-#5224 regression fix (module-global `$__ta_view` pin) | #5150 | (restores 9 host rows) |
| #5475 | r2 implementation plans (expressions, statements) | #5270/#5271 | (docs) |
| #5479 | TypedArray r2 | #5194 | +84 |
| #5489 | class r2 (+ #5194 null-proto follow-up) | #5195 | +28 |
| #5494 | Array/Object built-ins r2 | #5268 | +21 |

Two process notes worth keeping:

- **#5461 changed what a measurement means.** Before it, the in-process runner
  (`scripts/run-test262-paths.mts`, every local before/after probe) satisfied a
  leaked `env::*` import from the JS host and scored the row on what happened
  next — so a slice could read "fixed" locally while CI scored
  `host_import_leak`. Every number above is measured with the check in place;
  the TypedArray lane re-scored its 84 claimed flips afterwards and found no
  pseudo-pass, but the class lane found one (`constructor-can-be-generator.js`
  leaks `env::__create_generator`, owned by #680/#2864, now pinned as a leak).
- **Every wave went through an independent adversarial review before shipping,
  and five of six had confirmed regressions their own row lists, controls,
  ratchet gates and equivalence runs all missed** — 13 in total, including two
  that only appeared on the JS-host lane, one that made a whole class of
  subclass declarations fail to compile, and one pre-existing defect in the
  shared carrier-bag key merge (`Reflect.defineProperty` on an existing
  closed-struct field double-listed the key on `main` too). A row list is not a
  regression test: none of these shapes were in the cluster lists the planners
  built, because the lists are drawn from *failing* rows and these broke
  *passing* behaviour outside the cluster.

Remaining non-pass by cluster (same split as the 09-01 census, so the two are
comparable):

| Cluster | 09-01 | 09-02 | Δ | Owner |
| --- | ---: | ---: | ---: | --- |
| class | 209 | 225 | +16 | #5195 r3 residuals R3-1…R3-7 recorded |
| typedarray | 300 | 208 | −92 | #5194 residuals (F3/F4 documented) |
| generators | 318 | 195 | −123 | #680 / #2864 codex lane |
| array + object | 159 | 179 | +20 | #5268 steps 4/5/7/8/9/10 not started |
| other built-ins | 150 | 165 | +15 | #5269 in flight (G/H/A/B/L/J/E/D landed) |
| expressions | 117 | 163 | +46 | #5270 in flight (steps 4–7, 9, 11 open) |
| proxy + reflect | 157 | 157 | 0 | #5196 not dispatched; #3371 / #2046 blocked |
| regexp | 148 | 140 | −8 | #5198 codex lane |
| for-of + collections | 155 | 119 | −36 | #5267 residuals |
| promise | 140 | 118 | −22 | #5197 slices E–H open |
| statements + lang | 84 | 79 | −5 | #5271 in flight (0 → 39 of 68 in scope) |
| module-code | 23 | 24 | +1 | #4759 codex closeout lane |
| rest | 18 | 27 | +9 | folded into the nearest cluster plan |

The clusters that grew did not regress — the counts move because rows leave a
cluster when they pass and because this census clusters by path prefix while
the 09-01 one clustered by the dispatch split; treat the Δ column as a
direction indicator, not as a per-cluster regression signal. The authoritative
"no row regressed" evidence is each wave's own before/after on its row list
plus the merge-group regression gate.

## 2026-09-01 evening dispatch census at d39779cb — cluster ownership + Fable/Opus fan-out

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` (baselines
repo, compiler sha `d39779cbfdd5a9b5fdb54569923fd9810637d495`, generated
2026-09-01T18:33Z — an ancestor of the session branch
`claude/es6-test262-standalone-g10c7u`, which is `origin/main` @ `0d9bfede`),
edition map `website/public/benchmarks/results/test262-file-editions.json`
(`ES2015` label; 11,778 labelled, 11,704 in the official runner scope).

**ES2015 standalone: 9,673 pass / 11,704 (82.6%) — 2,031 non-pass**
(1,644 fail · 386 compile_error · 1 compile_timeout). Status/error class:
1,122 `assertion_fail`, 367 `type_error`, 248 `host_import_leak` CE,
151 other CE, 34 runtime_error CE, 21 promise_error, 15 illegal_cast,
10 null_deref, 10 range_error.

Cluster split (path-disjoint; lists under `.tmp/es2015/<cluster>-{paths.txt,errors.tsv}`,
regenerable from the JSONL + edition map):

| Cluster | Rows | Owner / tracker | Dispatch (this session) |
| --- | ---: | --- | --- |
| generators (`language/*/generators`, `yield`, GeneratorFunction/Prototype, `__create_generator` leaks, "sequential numeric yields" refusal) | 318 | #680 / #2864 codex lane (PR #5383 merged; #5406/#5407 drafts) | **not re-dispatched** |
| typedarray (`built-ins/TypedArray*`, excl. buffers) | 300 | #5194 (Slice A merged #5300; #5385 species merged) | Fable planner → r2 plan in #5194 → Opus |
| class (`language/*/class`, `computed-property-names/class`, `super`, `new.target`) | 209 | #5195 (stub) | Fable planner → plan → Opus |
| array + object built-ins | 159 | new **#5268** | Fable planner → plan → Opus |
| proxy + Reflect | 157 | #5196 (2-row revoker slice merged #5389); #3371 (33 CE, blocked design PR #5400); #2046 (15 CE, design PR #5397) | Fable planner on the unowned trap-invariant residual → Opus |
| for-of + Iterator/*IteratorPrototype + Map/Set/Weak* | 155 | new **#5267** (wave-1 #5144/#5147/#5151; draft PR #5225 mined, not merged) | Fable planner → plan → Opus |
| function/error/symbol/string/JSON/number built-ins | 150 | new **#5269** (wave-1 #5156/#5152) | Fable planner → plan → Opus |
| regexp (`built-ins/RegExp`, annexB RegExp, `Symbol.{match,replace,search,split}`) | 148 | #5198 codex lane (Slice A merged #5296; Slice B draft #5393) | **not re-dispatched** |
| promise | 140 | #5197 (Slice A merged #5292; slices B–H planned) | Opus implementer on Slices B–D directly |
| expressions (object literal, assignment, arrow, call, template, instanceof, …) | 117 | new **#5270** (wave-1 #5149/#5146) | Fable planner → plan → Opus |
| statements + lang semantics (for-in/for/let/const/with/try, global/eval code, arguments, rest, dstr) | 84 | new **#5271** (wave-1 #5154/#5158/#5157) | Fable planner → plan → Opus |
| buffers (ArrayBuffer/DataView) | 53 | #5150 (full plan; WIP draft PR #5224 unvalidated) | Opus implementer directly (mines the WIP) |
| module-code | 23 | #4759 codex closeout lane | not re-dispatched |
| rest (misc singletons) | 18 | — | folded into the nearest cluster plan |

Ids #5267–#5271 were reserved via `claim-issue.mjs --allocate`
(`--no-pr-scan --allow-unscanned`: no `gh` in this container, so the open-PR
scan could not run; the `check:issue-ids:against-main` gate backstops).

Method (unchanged from the 08-28/29 session): Fable planners re-verify each
list on HEAD with `scripts/run-test262-paths.mts --standalone`, cluster by
root cause with file:function sites, and write the `## Implementation Plan`
into the issue; Opus implementers work each plan in an isolated worktree and
commit validated slices; this lane integrates them into the session branch,
runs the ratchet + equivalence gates, and lands batches through PRs.

## Latest forced census (2026-09-01; replaces the stale dispatch headline below)

This is the latest immutable dispatch baseline for this umbrella. It replaces
the older 2026-08-15/27/30 planning headline below, but it is not final
acceptance evidence: upstream `main` advanced after the fetch from the measured
`f841cddc` source to release head `7fffec53`. A complete maintained-runner census on the
final integrated head is still required before any current pass-rate or
completion claim.

- **Compiler source:** detached `upstream/main`
  `f841cddc0f0ea665b63700d9944a4372a34a8b57`.
- **Baseline provenance:** a forced official fetch with
  `node scripts/fetch-baseline-jsonl.mjs --standalone --force` retrieved
  `test262-standalone-current.jsonl` from immutable
  `loopdive/js2wasm-baselines` commit
  `8a39bd1d4ddf200f8db3751c878ece02aa8688fe` (GitHub Actions commit time
  `2026-09-01T00:28:18Z`).  The 22,858,445-byte cache has SHA-256
  `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf`.
  Its row timestamps span `2026-09-01T02:02:14Z` through
  `2026-09-01T02:24:30Z`. The baselines repository's `main` moved after this
  fetch; cite the immutable commit above, not the moving branch tip.
- **Schema/completeness check:** all 48,735 JSONL rows parse; every row has
  the required string/number/boolean baseline fields, one of
  `pass|fail|compile_error|compile_timeout|skip`, and a unique `(file,strict)`
  identity.  Optional timing/error fields are absent only where the maintained
  runner schema permits them.
- **Edition authority:**
  `website/public/benchmarks/results/test262-file-editions.json` maps every
  fetched row.  Selecting entries whose exact label is `ES2015` produces
  11,704 rows, all `scope_official: true` (11,536 standard and 168 Annex B).
- **Measured result at `f841cddc`:** **9,616 pass / 11,704 total** (82.16%);
  **1,644 fail, 444 compile_error, 0 compile_timeout, 0 skip** — **2,088
  non-pass**. This
  is progress, not completion; the umbrella remains `in-progress` until the
  complete exact population is 11,704 pass with all other status counts zero.

### Acceptance runner and positive control

Do not infer acceptance from this fetched baseline.  A subsequent implementation
must use the maintained runner, an exact 11,704-path filter derived from the
authoritative edition map, and the runner's completion-manifest validator.  The
shape is:

```bash
COMPILER_POOL_SIZE=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 \
TEST262_TARGET=standalone JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/absolute/prebuilt-quickjs-artifact-dir \
TEST262_PATH_FILTER_FILE=/absolute/path/to/exact-es2015-paths.txt \
TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
pnpm run test:262 -- --official-scope-only
```

As a focused positive control for the free #2046 slice, the fetched baseline
records `test/built-ins/Reflect/set/set-value-on-accessor-descriptor.js` as a
standalone **pass** (the supported three-argument native `Reflect.set` path).
Before and after any receiver implementation, it can be exercised without a
full suite via:

```bash
printf '%s\n' \
  'test/built-ins/Reflect/set/set-value-on-accessor-descriptor.js' \
  > /absolute/path/to/reflect-set-positive-control.txt
COMPILER_POOL_SIZE=1 TEST262_TARGET=standalone \
JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/absolute/prebuilt-quickjs-artifact-dir \
TEST262_PATH_FILTER_FILE=/absolute/path/to/reflect-set-positive-control.txt \
TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
pnpm run test:262 -- --official-scope-only
```

### Current handoff: owned work versus free exact slices

- **Do not duplicate:** the three ES2015 dynamic-`RegExp` `Symbol.match`
  flag-refusal paths are isolated, but a live sibling worktree owns #5198
  (`codex/5198-regexp-exec-r2-f841-20260901`).  Generator continuations are
  covered by open PR #5383; TypedArray species work by #5385; and builtin
  prototype/null-prototype work by #5384.
- **Free, bounded implementation candidate:** #2046's explicit
  `Reflect.set(target,key,value,receiver)` refusal has **15 exact
  compile-error paths**, all with the same fail-loud diagnostic.  The single
  gate is `src/codegen/expressions/call-namespace-static.ts:903-920`; #2046 is
  in progress, no current GitHub PR matches it, and its visible remote branches
  are June-era checkpoints.  The implementation must preserve the positive
  control above and add receiver plumbing rather than drop the fourth argument.
- **Unowned but not yet a safe parallel coding slice:** #3371's arbitrary
  distinct-`Reflect.construct` NewTarget refusal remains on **33 exact
  compile-error paths** at
  `src/codegen/expressions/call-namespace-static.ts:1620-1627`, despite its
  tracker being marked done.  It needs a reopened/new bounded owner before
  implementation; it is not a substitute for the #2046 slice.  The apparent
  three-row `Array.prototype.flat` refusal is already a tail of #5145's
  in-review ArraySpecies/target-property wave, so do not duplicate it.

## Historical measurement (2026-08-15, superseded as a headline)

Source: fresh `test262-standalone-current.jsonl` (baselines repo, fetched
`--force`, 48,735 entries, baseline_sha `734fab88`), classified per-test with
`scripts/generate-editions.ts` `classifyEdition` (host-free pass definition,
`host_import_leak_class` excluded). Reproduction: `.tmp/es6-standalone-clusters.ts`.

**ES2015 standalone: 7,695 pass / 11,704 total (66%) — 3,401 fail, 607
compile_error, 1 skip = 4,009 non-passing.**

## Cluster map → owning issues

Counts are non-passing ES2015-classified tests in the standalone lane; clusters
overlap paths (a generator test under `language/statements/class` counts in the
generator row).

| # | Cluster (root cause) | ~Tests | Owning issue(s) | State |
|---|---|---|---|---|
| 1 | **Native generator carrier** — standalone lowering only supports "sequential numeric yields"; everything else leaks `__create_generator`/`__gen_*` host imports (CE) or mis-executes. Spread across `language/{expressions,statements}/generators`, `yield`, `class` (gen methods), `object` (gen shorthand), for-of/dstr | ~500 | #2864 (in-progress), #2906 (in-progress), #3032, #680; umbrella #3178 | tracked — do NOT duplicate |
| 2 | **Promise/microtask carrier** — `Promise.all/race` leak `Promise_all`/`Promise_race`/`__js_array_new` (CE); `Promise.resolve` "not yet implemented"; `illegal cast [__then_fulfill_N]` in the async drive layer | ~233 | #2867 (ready), #2906, umbrella #3178 | tracked |
| 3 | **Built-in method reflection** — `length.js`/`name.js`/`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js` across every built-in: methods are not reified function objects (`Object.getOwnPropertyDescriptor` → "Cannot convert undefined or null to object", `typeof m === "undefined"`) | ~324 | #2175 (ready, arch spec written), #2158, #2159; sibling lane PR #4553 (method name/length meta) is in flight | tracked — architectural |
| 4 | **TypedArray.prototype semantics** — species-constructor protocol (`speciesctor-*`, 55), custom-ctor paths, detached-buffer TypeErrors (~41), coercion/validation order. Excludes row-3 reflection files | ~556 | **#4449** (filed this session, triage-first; reflection part stays #2159) | tracked |
| 5 | **RegExp `@@replace`/`@@match`/`@@split`/`@@search`** — function replacer refusal (CE, "#1913 follow-up"), coercion order, `lastIndex` protocol | ~161 | #2161 (blocked on #2175), F7 dynamic-receiver arch spec pending | tracked/blocked |
| 6 | **for-of destructuring residual** — iterator close/return/throw propagation, trailing-iterator state (`trlg-iter`, 23), nested patterns, fn-name inference, TDZ | ~200 (non-generator) | **#4447 — slice 1 LANDED** (standalone dstr 342→400/569, gc +51, assignment/dstr +6, 0 lost; binding form + eval-order deferred, see issue) | landed |
| 7 | **Class semantics residual** — `class/dstr` method-param destructuring dominates (112, shares #4447's machinery), subclass (46), definition (36), NamedEvaluation `NaN vs undefined` | ~321 (non-generator) | **#4450** (filed this session; re-measure after #4447 lands; overlaps #2158/#2175) | tracked |
| 8 | **annexB String HTML methods** — the direct-call lowering existed (#3069); the gap was the value-erased proto-closure shape | 79 | **#4445 — DONE** (filter 17→95/111 standalone, 13 HTML dirs 82/82, gc identical; reflection files flipped free via method-meta) | done |
| 9 | **Array.prototype extern fallback leak** — `compileArrayConcatExtern` emits `__array_concat_any`/`__js_array_new`/`__js_array_push` → standalone leak-guard CE | ~30 | **#4446 (this session)** | dispatched |
| 10 | Long tail — `Object.prototype` (38), `Function.prototype` (35), `let`/TDZ (26), `arrow-function` (25), `switch` (23), DataView (45), Iterator.prototype (55) | ~250 | untracked — file per-cluster on pickup | open |

## Strategy

1. **The two umbrella dependencies dominate**: rows 1–2 (generator + promise
   carriers, ~733 tests) are owned by the in-flight #3178 machinery retirement
   lane; row 3 (#2175 reflection, ~324 direct + unlocks rows 4/5/7 residuals)
   has an architect spec and sibling-lane momentum (PR #4553). This umbrella
   does not re-dispatch them.
2. **This session dispatches the unowned, bounded clusters** — #4445, #4446,
   #4447 — to Opus implementation agents in parallel worktrees (plans in the
   issue files).
3. **Next-wave triage issues filed**: #4449 (row 4, TypedArray) and #4450
   (row 7, class residual). Row 10's long tail gets per-cluster issues as the
   dispatched wave lands, so counts stay attributable.

## Session results (2026-08-15, wave 1)

- **#4445 landed** (`5b715e1`): annexB String filter 17→95/111 standalone, 13
  HTML dirs 4/82→82/82, gc unchanged (108/111 before/after, official wrapper —
  an earlier 92/111 figure was a fast-driver artifact). Free follow-up found:
  `trimLeft`/`trimRight` miss the same `STRING_PROTO_METHODS` CSV (6 tests;
  `reference-*` also needs alias identity `trimLeft === trimStart`).
- **#4447 slice 1 landed** (`8dcbc88`): standalone for-of/dstr 342→400/569,
  gc 344→395 (+51 — three of four fixes are lane-independent), standalone
  assignment/dstr 240→246, 0 lost anywhere. Deferred: eval-order interleaving,
  §7.4.9 refinements, fn.name, binding form (~30 tests,
  `destructureParamArray`).
- **#4446**: in flight (interim: concat 13→23 pass, 29→1 CE, 0 lost).

## Acceptance

- ES2015 standalone (host-free) reaches 100% of its 11,704-test bucket.
- Interim checkpoints: each cluster row either has an owning issue with a plan
  or a landed fix; the edition table in this file is refreshed per measurement
  (name the artifact + date per project measurement discipline).

## 2026-08-27 authoritative standalone closeout status

The active goal is the standalone ES2015 edition score. Host measurements are
retained as regression controls but are not part of the completion denominator.
The latest complete maintained-runner ES2015 measurements on the combined
closeout lineage are:

- host run `20260826-180615`: 9,435 pass / 11,704 total, 2,163 fail,
  59 compile errors, 46 compile timeouts, 1 skip;
- standalone run `20260826-194014`: 8,402 pass / 11,704 total, 2,728 fail,
  571 compile errors, 2 compile timeouts, 1 skip.

Later bounded checkpoints have fixed or classified #4758 (40 host
destructuring timeouts), #4759 (20 module-namespace self-import bindings),
#4760 (Promise poisoned-thenable slice), #4762 (mutation-safe realm cleanup),
#4763 (Set replaced-adder abrupt completion), and #3423 (11 nested-object
destructuring rows). Those bounded results do not replace a fresh full 11,704
measurement and are not added arithmetically to the headline.

The active Luna/max wave is issue-backed and isolated: #4449 owns the exact
55-row TypedArray species cohort, #4450 owns four class static `name`/`length`
precedence rows, and #2765 owns three `instanceof` getter/prototype rows. The
single integration target remains upstream draft PR #5010.

Completion requires a fresh authoritative standalone run on the final
integrated head reporting exactly 11,704 pass / 11,704 total with zero fail,
compile error, compile timeout, or skip. Host runs remain required per-slice
regression controls, not a second completion bar. Until the standalone proof
exists, this umbrella remains in progress. Individual completed fixes may be
ready and landed; draft state is reserved for an incomplete or non-mergeable
checkpoint.

## 2026-08-30 Codex resumption and implementation handoff

The 2026-08-27 reference above to a single draft integration PR #5010 is
historical and no longer governs delivery. Current delivery uses one separate
upstream PR per completed fix; only an incomplete or non-mergeable checkpoint
may be draft.

The latest complete exact-filter artifact available at resumption is the
2026-08-28 maintained standalone snapshot. Selecting the frozen 11,704-row
ES2015 map produces **8,681 pass / 2,513 fail / 509 compile_error / 1
compile_timeout / 0 skip**. The artifact SHA-256 is
`260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`; the
exact path-map SHA-256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`.
Because that artifact does not embed its source commit and predates the
current upstream tree, it is a dispatch baseline, not final acceptance
evidence. Per-slice gains are never added arithmetically to this headline.

Coordination refreshed `loopdive/js2` upstream main to
`a62aacba5ccc154f6fc378235aaaeeb4a7204231`; a fresh fetch immediately after
the diagnostic confirmed that this is still the authoritative upstream head.
The #5194/#5195/#5197/#5198 worktrees and the new #5212/#5213/#5214 lanes are
based on that exact commit. #5131 has integrated it locally but still requires
validation and a corrected commit trailer before its published draft can be
updated.

The full maintained-runner diagnostic on detached source
`1f1004f3df195cc5f9e804efcbb2896d3871ca37` finished all 16 shards of the
11,704-row map with standalone target, two workers, the QuickJS artifact, and
official-scope-only filtering. Vitest's own final summary proves it registered
and executed **11,704 tests**. The canonical JSONL is nevertheless incomplete:
it has **11,685 physical rows / 11,685 unique paths / 8,974 pass / 2,258 fail /
447 compile_error / 6 compile_timeout / 0 skip**. It contains no malformed
rows, duplicate identities, or paths outside the filter, but is missing 19
selected paths. Its SHA-256 is
`47f34c307c43b06c9c40bb0df754bc22d94435a23cccfdd6de857816e199214a`;
the generated partial report SHA-256 is
`f6255daef57aa971bf121b98ea629b53985cf591d47bfc579b54dab538babe59`.

The deficit is localized exactly: shard 10 registered 731 tests and recorded
712, while every other shard reconciled. Vitest grouped the 19 abandoned
callbacks under `Error: Test timed out in 90000ms` at
`tests/test262-shared.ts:644`; the runner then overwrote shard 10's completion
file with later shards and printed `COMPLETED: 8974 pass / 11685 total`. The
atomically allocated markdown issue #5215 records all 19 paths and the
implementation plan for bounded Test262 concurrency, durable per-shard
completion manifests, and a fail-before-publication completeness validator.
This artifact remains exact dispatch evidence for the 11,685 emitted paths,
not an authoritative edition census and not final integrated-head acceptance.

All six recorded timeouts are detached-buffer TypedArray rows: shard 16
reported `byteLength/detached-buffer.js` and
`lastIndexOf/detached-buffer.js`; shard 10 reported
`findIndex/predicate-may-detach-buffer.js` and
`every/callbackfn-detachbuffer.js`; and shard 1 reported
`indexOf/detached-buffer.js` and `buffer/detached-buffer.js`. They remain under
the active #4449 residual and require bounded solo rechecks. The shared census
test lock is now released. After #5212 and #5214 completed their bounded lanes,
#5215 and #5213 each received one compiler/test worker; the global ceiling
remains two and root does not start an overlapping compiler/test lane.

The active work is repository-issue-backed and isolated:

- #5131 owns strict iterator materialization for dynamic spread. Its published
  PR #5272 remains draft because that published checkpoint is conflicting and
  non-mergeable (the shepherd measured 2 commits ahead / 525 behind current
  main); the newer local implementation must integrate current main, pass its
  full focused matrix, and replace the stale handoff before becoming ready.
- #5194 owns the exact 25-row TypedArray `set` Slice A and its host regression
  controls.
- #5195 owns the exact 12-row faithful builtin-subclass slice, with the
  generator carrier explicitly delegated to #5199.
- #5212 is the completed atomically allocated, markdown-only Map/Set provider
  sub-slice from #5195. Its two exact rows pass host and standalone, and its
  single non-draft upstream PR is #5286 at final published head
  `cc653e1cd162ca33a95e659df15a40764d9e7c82`; the dedicated shepherd owns its
  CI/readiness/queue audit.
- #5213 is the atomically allocated, markdown-only two-row class instance
  accessor sub-slice; a separate Luna Max worktree owns the `prototype` key
  collision without touching the collection provider.
- #5214 is the completed atomically allocated, markdown-only six-row NativeError
  prototype-`name` configurability slice. Its exact host/standalone matrix is
  12/12 pass, and its single non-draft upstream PR is #5287 at final published
  head `e7fbfda3bdb6f8ea25acd59ba1cdb376a0aa0f23`; the dedicated shepherd owns
  its CI/readiness/queue audit.
- #5215 is the atomically allocated, markdown-only Test262 verdict-completeness
  repair. Its root-filed implementation plan prevents a timed-out shard from
  being overwritten and published as a complete report; a fresh Luna Max
  worktree now owns the implementation and one-worker validation.
- #5197 owns the exact three-row Promise symbol object-model Slice A.
- #5198 owns the exact nine-row RegExp `exec`/`test` observable-`lastIndex`
  Slice A.

These numbers refer only to markdown files under `plan/issues`; no GitHub
issues are to be created. Implementations use Luna Max agents in separate
provisioned worktrees. Every completed, mergeable fix gets its own non-draft
PR from `ttraenkler/js2` to `loopdive/js2`; only an incomplete or genuinely
non-mergeable checkpoint may remain draft. A separate shepherd agent verifies
the required PR body, mergeability, reviews, CI, exact tested head, and
ready/queue state before landing.

## 2026-08-30 current integrated-head census implementation plan

The numeric title no longer repeats the stale 2026-08-28 snapshot. Historical
measurements above remain useful dispatch evidence, but none is the acceptance
numerator. The next headline will be written only from a complete maintained-
runner census on one exact integrated upstream commit.

At this checkpoint, freshly fetched `loopdive/js2` main is
`01fb67624e2f645b7e92dd9f8e47478e3face9ba`. RegExp Slice A PR #5296 is merged
there. TypedArray `set` Slice A PR #5300 is non-draft at exact tested head
`a6bd6301007e37d289e9378a97891a44846e33f9` and is already in the upstream
merge queue; the census must not start until that exact change lands and this
worktree is fast-forwarded or merged to the resulting current main. The
documentation-only ES2018 tracker PR #5304 does not affect the ES2015
denominator. #5131's two fixed empty-spread rows are unclassified, and #5216's
object-spread rows classify as ES2018, so neither may be added to the ES2015
numerator.

The selection authority is the frozen 11,704-path artifact
`/private/tmp/js2-es2015-11704-pr5008.txt`, whose LF-normalized SHA-256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`.
Every entry has a leading `test/`; removing only that prefix produces 11,704
unique `test262/test`-relative paths with SHA-256
`90d5e85a13e3721c8e53734e21c01ec894f736412048cf4d8b15ca7ecc47c2cd`.
Before execution, regenerate that normalized file in this worktree's temporary
area, require exact set equality and 11,704 existing files, and record the
Test262 gitlink/checkout `b363f29d3c43c626dc852744ad64a0b48a003693`.

Execution uses the maintained `scripts/run-test262-vitest.sh` path, not a
hand-written verdict approximation: `TEST262_TARGET=standalone`,
`TEST262_PATH_FILTER_FILE=<normalized exact map>`, official scope only,
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, `VITEST_MAX_FORKS=1`, and the
pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`. Keep one compiler/test
worker for this lane and at most two globally. Disable history publication for
the scoped run. Preserve the timestamped JSONL, report, per-shard completion
manifests, source commit, filter hashes, command, and elapsed time in this
tracker before making any claim.

Completeness is a hard gate, not an inference from Vitest's console summary.
The final report must reconcile exactly 11,704 registered tests, 11,704 started
callbacks, 11,704 settled callbacks, 11,704 physical canonical rows, and
11,704 unique selected paths, with no duplicate, malformed, outside-filter, or
missing row. The acceptance result is exactly **11,704 pass / 11,704 total, 0
fail, 0 compile_error, 0 compile_timeout, 0 skip**, with every passing module
host-import free. Any other result keeps this umbrella in progress.

If non-pass rows remain, cluster only this fresh integrated-head artifact by
stable error signature and provider boundary. Root first updates or allocates
one repository-local `plan/issues/*.md` tracker per bounded cluster (new IDs
only through `node scripts/claim-issue.mjs --allocate`), records its exact path
set and implementation plan, and only then fans implementation to Luna Max
agents in separate provisioned worktrees. Each completed fix gets one
mergeable non-draft upstream PR from `ttraenkler/js2`; a genuinely incomplete
or non-mergeable checkpoint alone may remain draft. The dedicated PR shepherd
owns exact head/body/repository/readiness/check/conflict/queue verification.
No GitHub issue is created.
