# IR migration strategy review (2026-11-19)

Independent review of the approach, asked for by the project lead. The reviewer had no part in the current plan.
Evidence (in `plan/log/ir-migration-strategy-review-2026-11-19-evidence/`) was gathered on 2026-11-19 between
14:30 and 16:00 UTC by four fresh-context agents (git/PR/CI timeline,
review census, proof-machinery cost, route costing) on main `89e47482`, plus the plan files named below. Each number
names its artifact. "Estimate" and "opinion" are labelled.

Terms used:

- **Ordinary pipeline**: the normal compile. A selector hands single functions ("units") to the IR; the legacy
  compiler does the rest. Example: in a test file with 9 units the IR may take 3 and legacy 6.
- **Zero-legacy file**: a file where the selector handed every unit to the IR.
- **Prepared path**: the second pipeline (`TEST262_COMPILER_PATH=ir`). It has no legacy fallback: the first thing it
  cannot lower fails the whole file. This is the declared goal since 2026-11-16.
- **Prelude**: the harness code compiled in front of every test (`scripts/test262-fyi-runtime.js`, `assert.js`,
  `sta.js`, 323 lines).
- **Stand-in harness**: a simplified prelude used only for measuring what test bodies need
  (`scripts/ir-census/stand-in-harness.mjs`, PR #7308).
- **First gap**: the first construct at which the Prepared path refuses a file. Example: a file that needs object
  literals, `String` and `eval` is listed only under object literals.
- **Self-authentication**: code in the Prepared path that re-proves its own in-memory plan was not altered
  (receipts, provider census, layout audits, hash pins). Example: before each use of the string resources the
  backend re-runs the whole plan and compares it to a frozen snapshot.
- **Claim-then-withdraw**: the IR selects a unit, fails later, and legacy compiles it after all.

## Gist

1. **Keep the Prepared path as the goal.** The ordinary pipeline's count does not measure legacy leaving: in 8 of 8
   probed zero-legacy files legacy still emitted 8 of 9 unit bodies and about 720 of 768 Wasm functions.
2. **The plan aims at the wrong wall.** The prelude and the function/object mechanisms the 13 lanes build free at
   most 9 % of ES5. 77.6 % of files need a built-in (`Object`, `String`, `Error`, `Math`, …), and the Prepared
   runtime has almost none of them. The built-in library is the program.
3. **Do not move that library by hand first.** Spend one week testing whether Prepared code can call the runtime
   helpers legacy already emits. If it works, ES5's library arrives at once.
4. **The prelude wall is partly self-made.** Our own shim reads 28 globals (`Proxy`, `Map`, `Promise`, …) for
   `$262`, which 21 of 8,717 files use. Emit it only for those files.
5. **Remove the Prepared path's self-authentication.** One compile takes 13 s with it and 0.6 s without, same
   output. It is 38 % of that path's code, only 15 % of the last 10 PRs' lines were mechanism, and it has caught
   none of the eight defects found there. A validator pass, Wasm validation and a differential run
   against node give the assurance for a fraction of the cost.
6. **Three days on the Prepared path have not moved its figure** (415 of 9,029 in all 15 CI runs, all negative
   tests). Publish a figure that moves: stand-in pass count, crash count, and a census of all gaps per file.
7. **Review: keep the hunt for wrong answers, drop the rest as blockers.** One PR in three had a real defect found
   by review; but about 69 % of review rounds found none, at about 220 PR-hours in two weeks (estimate).
8. **CI: a code PR waits 102 minutes for one test job that runs into its timeout.** Run affected tests on PRs.
9. **Thirteen lanes are too many** for the shared files and the CI. Four or five with disjoint files, one
   coordinator.
10. **Decide `eval` now.** 12 % of ES5 files need it on every route.
11. **Timing (estimates):** the milestone "one positive test passes with the real prelude" is 1 to 3 weeks away as
    planned, days sooner with point 4. 50 % of ES5 is weeks away only if point 3 works; otherwise it is on the
    scale of a quarter. 90 % needs accessors, RegExp, `with` and `eval`.

## 1. Where did the time go?

Source: `git log --first-parent origin/main` 2026-11-01 to 11-19 with `git diff --numstat` per merge, the GitHub API
for all 168 agent/human PRs, CI job logs. Weeks: W1 = 11-01..07, W2 = 11-08..14, W3 = 11-15..19.

| | W1 | W2 | W3 | total |
| --- | ---: | ---: | ---: | ---: |
| agent/human PRs merged | 97 | 43 | 28 | 168 |
| ordinary-pipeline slices and fixes | 48 | 25 | 6 | 79 |
| ordinary-pipeline mechanisms | 4 | 5 | 0 | 9 |
| Prepared path | 0 | 0 | 10 | 10 |
| plan/docs only | 26 | 5 | 8 | 39 |
| CI and tooling | 5 | 3 | 4 | 12 |
| non-IR compiler | 14 | 5 | 0 | 19 |
| `src/ir` lines added / removed | 6,932 / 2,972 | 6,767 / 2,967 | 2,665 / 783 | 16,364 / 6,722 |
| plan and docs lines added | 20,484 | 16,607 | 5,881 | 42,972 |
| open-to-merge time, IR PRs, median | 5.2 h | 28.8 h | 4.3 h | |

- **Plan lines added (42,972) exceed `src` lines added (36,804).** Tests added: 30,258.
- **Share of non-doc work that serves the current goal:** 10 of 129 PRs (8 %) and 11 % of `src` churn over the
  window; 67 % of PRs and 90 % of churn since 11-16.
- **How much of the ordinary-pipeline work carries over:** 14 % of its `src` churn is in `from-ast.ts`, the one
  entry both pipelines share. 16 % is selector code and 20 % legacy-codegen seams, which the Prepared path does not
  run. The rest (39 %, other `src/ir`) was not split.
- **Yield on the ordinary measure.** Two series were mixed in the brief:
  - CI, all editions (`summary.ir_only_pass` in `benchmarks/results/test262-standalone-current.json`, of 48,232):
    703 (10-31) → 1,088 (11-05) → 1,591 (11-07) → 2,383 (11-14) → 2,518 (11-16, flat since).
  - ES5 census (files with zero legacy units, of 8,591): 1,505 (11-11) → 1,601 (11-14) → 1,767 (11-19, PR #7308).
  - Per PR, from the 26 CI intervals that hold one code PR: median about +28; 8 delivered 10 or fewer; six intervals
    carry 47 % of the gain. 33 of the 88 ordinary-pipeline PRs moved nothing. 16 plan-only PRs on 11-05..07 record a
    slice that was measured and stopped at a yield of 0 or 1.
- **Yield on the Prepared path: none.** ES5 415 pass / 9,029, 0 fail, 8,614 compile errors in all 15 per-merge CI
  runs from 11-16 07:22 to 11-19 10:33 (job "merge complete IR standalone measurement"), before and after the 10
  merged #7354 PRs. All 415 are `negative:` tests (a compile failure is their expected outcome). The census of
  PR #7308 says the same: 0 of 8,717 positive ES5 files with the real prelude.
- **Rework:** 0 reverts; 14 fix or replacement PRs; 11 bot parks (4 real regressions, 2 not caused by the PR,
  5 unverified); 48 merge-queue re-entries on 26 PRs; 369 merges of main into PR branches.
- **Not obtained:** why nothing merged on 11-03, 11-09, 11-10 and for 33 hours on 11-18/19; token cost per PR.

Reading: weeks 1 and 2 bought about +1,800 on a figure that is not the goal (question 2). Week 3 turned to the goal
and has not yet produced a number.

## 2. Is the target right?

Source: import-graph and hook counts on main `89e47482`; a TypeScript parse of all 8,717 positive ES5 files for the
mechanisms each needs (syntax only, so an upper bound on what compiles); the census lists of PR #7308 (main
`ee3fcdd610`); probes through both front doors.

### What the two pipelines share

- Shared: `lowerFunctionAstToIr`, the IR passes, the IR verifier, `lowerIrFunctionBody`, the binary emitter and the
  module finalizer. So "shares only `lowerFunctionAstToIr`" (#7354, `CLAUDE.md`) is too narrow: by V8 coverage on 12
  programs, 61 % of the bytes a Prepared compile executes also run in the ordinary pipeline.
- Not shared: the runtime. The ordinary pipeline's IR side imports 215 symbols from legacy `src/codegen` (about 55
  runtime-helper emitters); the Prepared path imports 20, two of them functions.
- The Prepared path answers 7 of the 66 resolver hooks `from-ast` asks, and 11 of 36 lowering hooks (name match).
- The Prepared path has its own runtime ("native realm"). Its catalog
  (`src/runtime/contracts/native-realm-catalog.ts`) lists 45 intrinsics; 42 are `unavailable`. It has no String,
  Array, Number, Math, JSON, RegExp, Date or Error family. Runtime builders used by both pipelines: 6,094 lines.
  Legacy's runtime emitters: about 203,000 lines (heuristic), every probed one importing all of `src/codegen`.
- 37 one-line ES5 programs through the Prepared entry: 6 run, 29 are refused, 2 crash the compiler. Refused
  examples: `function f(a){return a+1}`, `Math.abs(-1)`, `[1,2,3]`, `new Error`, a closure, `for-in`.

### Cost of each route for the same files

| | Prepared path | ordinary pipeline to 100 % zero-legacy | IR-owned files (#7348) | hybrid: Prepared driver, legacy runtime borrowed |
| --- | --- | --- | --- | --- |
| today | 0 of 8,717 real; 148 with the stand-in | 1,767 of 8,591, 1,759 pass | parked: about 200 files projected | not built |
| ends with legacy deletable | yes | no: legacy still emits bodies, runtime and module | no | front end yes; runtime later |
| ceiling by named work | 100 % only with `eval` | 70.6 % with all 17 named levers; 2,526 files carry a reason no lever covers | small | as Prepared |
| what is left (estimate) | 59 resolver hooks, 25 lowering hooks, 50 to 80 thousand lines of runtime to move under "legacy bytes identical", `eval` | 20 to 40 thousand lines of lowering, selector and resolver, then the Prepared work anyway | ordinary work plus one storage authority | Prepared front-end work plus one adapter |
| main risk | the library is the long pole | stalls; the figure cannot show legacy leaving | measured small | the adapter may not fit the two type spaces (not verified) |

- **A zero-legacy file is not legacy-free.** In 8 of 8 probed files, 8 of 9 units report `legacyBodyEmitted: true`
  (the IR body is patched over it). One trivial zero-legacy test compiles to 349,861 bytes and 768 functions, about
  720 of them legacy helpers. The same test on the Prepared path with the stand-in is about 6 KB.
- 290 of 300 sampled zero-legacy files are tests whose body is one top-level block. The per-function selector buys
  little on this corpus.
- Of the 1,767 zero-legacy files about 143 pass on the Prepared path with the stand-in, none with the real prelude.

**Verdict: the Prepared path is the right target.** It is the only route whose figure cannot rise while legacy still
does the work. A hybrid is the cheapest way to get there (recommendation R4).

### But the first-gap lists mislead the plan

The Prepared census lists each file under its first gap only. By what each file's syntax needs:

| first-gap family | first-gap files | freed by that family alone |
| --- | ---: | ---: |
| object and array literals | 1,862 | 39 (2 %) |
| function values | 614 | 25 (4 %) |
| call through a value | 1,285 | 20 (2 %) |
| `new F()` / `this` / `instanceof` | 982 | 285 (29 %) |
| built-ins | 2,560 | 854 (33 %) |
| script-scope shapes | 659 | 106 (16 %) |
| eval | 292 | 162 (55 %) |
| all | 8,254 | 1,491 (18 %) |

Cumulative, in the plan's order (upper bound on files that could compile):

| after | files | share |
| --- | ---: | ---: |
| the prelude's own mechanisms | 514 | 5.9 % |
| + literals, function values, call through a value, function objects | 787 | 9.0 % |
| + `Object` statics and prototype methods | 1,313 | 15.1 % |
| + Error family | 1,661 | 19.1 % |
| + `String` | 2,261 | 25.9 % |
| + `Number`, `Boolean`, `Math`, global functions | 3,126 | 35.9 % |
| + `Array`, `call`/`apply`/`bind` | 3,681 | 42.2 % |
| + script-scope shapes | 4,452 | 51.1 % |
| + `delete`, `for-in`, `arguments` | 5,061 | 58.1 % |
| + accessors | 6,506 | 74.6 % |
| + RegExp, JSON, URI, `Date` | 7,531 | 86.4 % |
| + `with` | 7,667 | 88.0 % |
| + `eval` / `Function()` | 8,713 | 100 % |

- Files need a median of 3 mechanism groups. No single step frees more than 454 files in a greedy order.
- Eleven of today's thirteen lanes work on the rows that end at 9 %.
- This is the error `plan/log/ir-behind-the-selector-2026-11-13.md` already found on the ordinary pipeline (a lever
  credited with 631 files freed 12), repeated on the new path.

### The prelude

- 7,654 of 8,717 files (87.8 %) include nothing beyond `assert.js` and `sta.js`.
- Every file also compiles the project's 111-line shim, which reads 28 globals to build `$262`. 21 files name
  `$262`; none calls `print`.
- The prelude's mechanisms (function values, function objects, `new`/`this`, member access) are needed by a third
  or more of the bodies, so the work is not wasted. As a measure it is poor: it reads zero until every slice lands.
- The repository's linked harness (prelude compiled once, bodies linked) is built on the ordinary pipeline for the
  host lane. On the Prepared path it would measure at most the stand-in's 148 today. Not built, not recommended
  first.

## 3. Is the Prepared path's own architecture the bottleneck?

**Yes. The proof layer, not the mechanism, is the bottleneck, and it is the largest avoidable cost in the
program.** Source: the project's own measurements in #7354, plus a separate measurement on main `89e47482` and
`claude/7354-o` (profiles, a stub experiment, a hand classification of code; full evidence in `plan/log/ir-migration-strategy-review-2026-11-19-evidence/`).

What it does. Inherited from #3518 (the native realm, September and October), each stage re-proves that the plan it
was handed is the plan that was accepted: support receipts, a provider census at presentation, "complete source"
SHA-256 pins on whole files, re-planning before each use, and a layout audit of every reserved record on each
`physicalIndex()` call. The reviews then attack it with hand-altered plan objects ("forged setups").

What it costs, measured:

- **Compile time** (#7354 "Perf result", 2026-11-17, strict Prepared entry; one line = string literal + concat +
  length + `===`):

  | lines | before the perf slice | after |
  | ---: | ---: | ---: |
  | 5 | 8.6 s | 5.8 s |
  | 20 | 71.9 s | 16.5 s |
  | 50 | 436.0 s | 49.9 s |
  | 200 | not measured | 428.2 s |

  Before: 43.0 of 66.8 profiled seconds in `ownerFor`, the re-authentication. After: still quadratic; one literal
  emit runs `PhysicalModuleReservations#verifyLayout` 63 times.
- With the native realm, one small proving program compiles in about 18 s, 16.0 s of it in `#verifyLayout` (#7354
  "Realm join", 2026-11-19, `node --cpu-prof`). Programs that never reach emission are refused in 2 to 12 ms, which
  is why today's census runs in 5 minutes. **Once files compile, a full ES5 run at 18 s per file is about 45
  CPU-hours** (estimate: 9,029 × 18 s). The audit blocks the measurement the plan depends on.
- **The audit is pure overhead, measured.** One object-literal program on `claude/7354-o`: 13.0 s warm. With
  `#verifyLayout` returning at once: 0.60 s, and the emitted bytes are identical (4 programs tried). 80 % of the
  profile is under proof functions; lowering and emit take under 0.05 s. On main, 200 string lines take 27 s on the
  Prepared path and 1.1 s on the ordinary pipeline. `claude/7354-perf2` does not touch the realm audit (still
  13.0 s); `perf3-reservations` brings one literal to 3.0 s, but 20 literals still take 28.7 s.
- **Share of the code.** The Prepared-only family is 182 files, 45,600 lines, with 232 test files, 97,600 lines.
  A hand classification of 40 functions, weighted by size: 56 % mechanism, 6 % validation, 38 % proof (±15).
  Legacy codegen by the same keyword test: about 1 % proof. Of the tests that import Prepared modules 13 % check
  behaviour (compile, run, compare), against 67 % in the rest of the suite (regex estimate).
- **Share of the work.** The last 10 merged Prepared PRs (#7278 to #7300) added 8,023 lines: 1,183 mechanism
  (15 %), 1,986 plan text, the rest tests and proof. 66 older test blocks were edited only to keep up. Two of the
  ten PRs only repaired red pin tests.
- **A new intrinsic** (`js.value.to_boolean`, #7300) touched 17 files. Seven source files enumerate every intrinsic
  id; tests pin the list length and a SHA-256 of the table text. Two of the seven tables are already
  `Record<Id, …>`, where TypeScript enforces completeness for free.
- **The pins choose the design.** For the audit fix (#7365) the simple change fails 216 pinned tests; an option
  measured twice as fast fails 186 and was not built; the one chosen moved 65.
- **The pins are not watched.** `tests/issue-3518-runtime-program-relocation.test.ts` fails 298 of 298 on main
  and nobody noticed, because CI runs such files only when a PR touches them.
- **Pins, earlier.** Slice D1's first cut ran one pass in a different stage and broke 150 receipt tests (#7354, "D1
  result"). Slice T (one intrinsic, ToBoolean) edited seven closed lists and re-derived two pinned hashes. The lead's
  brief reports 66 to 216 pinned tests moved by one change today. Main carried 10 failing pin tests for days
  ("complete source SHA256/length mismatch", #7354 "T and X result"); PRs #7278 and #7281 exist only to re-pin
  hashes that 16 reviewed commits had invalidated.
- **Review rounds.** PR #7268 took five rounds on forged plan objects ("The code refused every attack (about 20 …),
  but seven checks could each be deleted without a test failing"); round 4 found a crash the round-3 fix had
  introduced in the refusal path. 9 of the 10 merged Prepared PRs record a NOT MET round. A program that passes
  no test has no behaviour to review, so the reviews attack the certificate.

What it buys. The threat is that one compiler module hands another a plan that differs from the accepted one. No
user input can do that; it is a compiler bug, and a compiler bug shows as a wrong answer, a crash or an invalid
module. The defects found on this path in the window were of that kind and were found by running programs: a `var`
reset in a loop (#7286, fixed by #7290), an effectful `&&` arm dropped by dead-code elimination (#7294), invariant
errors escaping `compile()` (#7277, #7305). The #7354 review records hold eight wrong answers, crashes or unsound analyses;
all eight were found by running programs or reading code, none by a census, receipt or audit. Three review rounds
fixed forgery holes that only a test mock can reach.

What is essential and what is not (opinion):

| keep | replace |
| --- | --- |
| refuse at the front what cannot be lowered, by name | re-planning and snapshot comparison on every use |
| one IR verifier after lowering and after legalization (types, operands) | support receipts and the provider census as a second bookkeeping of what the plan already says |
| one physical-plan check before emission (every index reserved once, every provider present) | a layout audit on every index read |
| `WebAssembly.validate` on every emitted module | "complete source" SHA pins on files |
| differential run against node (R6) | forged-plan tests and counted pins (`INTRINSIC_IDS` 41 → 42) |
| exhaustive tables by a TypeScript `never` check | hand-synchronised closed lists |

## 4. Is one fresh reviewer per PR, every finding fixed, paying for itself?

Source: 157 non-bot PRs created 11-05 to 11-19; 85 with a recorded verdict; 22 threads read in full, 17 more for
every blocking finding, the rest from verdict text. Counts of rounds are estimates (±10).

Half of it pays.

| first review (85 PRs) | PRs |
| --- | ---: |
| passes | 32 |
| blocks on a behaviour defect the PR introduced (wrong answer, trap, crash, verdict regression) | 29 |
| blocks on a defect already on main | 1 |
| blocks on claim-then-withdraw only | 10 |
| blocks on design only | 7 |
| blocks on proof or ceremony only | 6 |

- About 196 rounds, 2.3 per PR, maximum 7 (#7212). About 69 % of rounds found no real defect. At least 19
  re-reviews of merge resolutions found nothing.
- In 14 reviews read in full (about 94 findings): 7 % real defects from the PR, 18 % real defects already on main,
  18 % design, 32 % proof or ceremony, 23 % nits.
- Delay: median 62 minutes per blocking round; about 220 PR-hours in 14 days (estimate; upper bound 574 hold-hours).
- Reviewer findings that were wrong: under 5 %.
- Escapes: the merge queue caught 3 real regressions on 4 approved PRs (#7146/#7163, #7226, #7231); 2 defects
  reached main (#7136, #7286).
- Could a machine have found the 29? About 4 were already red in CI. About 17 need only a generated differential
  run against node and the base, which reviewers do by hand and discard. About 4 need a crash or compile-error
  ratchet. About 4 need a human. All claim-then-withdraw findings need a ratchet on `irPostClaimErrors`, which is
  recorded and not gated.
- Best finding: #7307, "A number on the left of `??` is lost when the right side is not a number", gates green,
  found in 16 minutes. Most ceremonial: #7315, BLOCKER on a data table nothing imports, where the review says "The
  rows themselves are right".

Keep the behaviour hunt. Stop blocking on the rest, cap the rounds, and commit the probes (R6, R7).

## 5. Process frictions

| friction | measured cost | fix |
| --- | --- | --- |
| PR CI | 102 min per code PR: `issue-tests-shard` (4,958 files, 8 shards) ends at its 100-minute timeout in every sampled run, in seed mode with no baseline, so it cannot fail. About 600 job-minutes per push. Required checks need about 15 min. | R8 |
| CI saturation | 11-19 14:53 UTC: 120 runs queued, oldest CI run waiting 54 min. 11-07 (283 CI runs): PR median 127 min, p90 239. Each PR push starts about 12 workflows. | R8, R9 |
| lanes in the same files | 16 PRs opened in 2.3 hours; 13 of 19 open PRs behind main; two lanes built the same realm join; kind tables, `program-physical-plan.ts`, `program-consumer.ts`, the provider census are edited by most lanes | R9 |
| stacked work | 369 merges of main into PR branches in the window; #7354 records "after the merge onto H / Str / main" re-reviews for most slices | R9: one integration branch per mechanism |
| two lead sessions | not measurable from git; the 11-07 handoff routes coordination through comments on one PR (#6583) | R9: one coordinator |
| narrow slices | 33 of 88 ordinary-pipeline PRs moved nothing; 16 plan-only PRs for slices stopped at 0 or 1 | R10; already decided on 11-15 |
| planning overhead | #7354 is 2,063 lines on main and 2,586 on `claude/7354-o`; #7106 is 10,246; plan lines exceed `src` lines | R9: results and review rounds go in the PR, not the issue |
| metric that cannot move | Prepared CI figure identical in 15 runs | R2 |

## 6. Shortest credible path

All durations are estimates. Basis: 10 Prepared PRs and about 3,900 `src` lines merged in the 4 days since 11-16
with 3 to 5 active lanes, and the cover table in question 2.

| step | what | estimate | evidence |
| --- | --- | --- | --- |
| 1 | Shim only where named (R1); stand-in pass, crash count and need cover per merge (R2) | 1 to 2 days | 21 files name `$262`; the census scripts exist on PR #7308 |
| 2 | Take the layout audit and re-authentication out of the hot path (R3, first part) | 2 to 4 days | an uncommitted experiment in #7354 "Perf result" brought 20 lines from 16.5 s to 5.7 s by bracketing audits |
| 3 | Finish the prelude mechanisms with 4 to 5 lanes: objects O2 to O4, function values, call through a value, function objects, `String()`/`JSON`/`typeof` | 1 to 2 weeks | open PRs #7305 to #7321 hold about 5,800 lines of it; reaches **milestone M** |
| 4 | In parallel from day 1: the borrow spike (R4) and the `eval` decision (R5) | 1 week | none; it is a spike |
| 5a | If the spike works: wire the families by need (`Object`, Error, `String`, `Number`/`Math`, `Array`), then script-scope shapes | 3 to 5 weeks to about 50 % | cover table: 51.1 % after those rows |
| 5b | If it does not: move the library family by family | a quarter or more to 50 % | 6,094 shared lines today against an estimated 50 to 80 thousand needed |
| 6 | `delete`, `for-in`, `arguments`, accessors, RegExp, JSON, `Date`, `with` | further weeks to months, to 88 % | cover table |
| 7 | `eval` | per the decision | 1,050 files |

Plainly: **under the current approach milestone M is one to three weeks away, and M itself moves the figure to at
most about 6 % of ES5.** 50 % is not in sight under the current approach, because no lane works on the library and
each addition carries the proof cost of question 3.

## Recommendations, ranked

| # | recommendation | expected gain | cost | risk | how to verify |
| --- | --- | --- | --- | --- | --- |
| R4 | One-week spike: Prepared code calls legacy-emitted runtime helpers | the ES5 library at once; decides 5a against 5b | 1 lane, 1 week | may not fit the type spaces; then we have a measured cost for one family | `Object.keys({a:1}).length` runs through the Prepared entry; stand-in pass re-measured |
| R3 | Replace self-authentication with a validator; linear compile time | compile from 13 s to 0.6 s (measured with the audit off); a new intrinsic stops touching 7 lists and hash pins; fewer review rounds | 1 lane, 1 to 2 weeks; deletes code and tests | a real invariant is dropped with the ceremony | 200-line program under 5 s; seeded invalid plans rejected; output bytes unchanged |
| R2 | Publish stand-in pass, crashes and an all-gaps need cover per merge | lanes are ordered by real yield; regressions on the path become visible | 2 to 3 days | the syntactic cover is an upper bound | the figure changes when a slice lands |
| R1 | `$262` shim only where named | milestone M shrinks by 28 globals | 1 day | ordinary-lane output must not change | first-gap tally before and after |
| R6 | Differential gate against node plus crash and post-claim ratchets | covers about 21 of 29 review-found defects mechanically | 1 lane, 1 week | generator upkeep | reproduces 12 of the 17 listed findings on pre-fix commits |
| R7 | Review blocks only on behaviour; two rounds; no re-review of clean merges | removes about 13 of 53 blocking first reviews and most third-plus rounds | a rule change | a design defect lands; mitigated by one design review per mechanism | rounds per PR and escapes re-measured after two weeks |
| R8 | PR CI runs affected tests; full set in the merge group | PR wait from 102 to about 20 min; about 500 job-minutes saved per push | 2 to 3 days | a test outside the affected set breaks; the merge group catches it | median PR CI under 25 min |
| R9 | 4 to 5 lanes with disjoint files, one table owner, one coordinator, short plans | fewer collisions and re-merges; CI stops queueing | a decision | less parallelism on paper | PRs behind main, queue length, merges per day after a week |
| R5 | Decide `eval` on the IR-only path | sets the ceiling (88 % or 100 %) and the scope model before more is built on it | 2 to 3 days of measurement and design | none in deciding | decision record with the constant/computed split |
| R10 | Ordinary pipeline is a regression guard; publish "units with no legacy body" | frees 7 open PRs' worth of lanes and CI; an honest figure | a decision | `from-ast` improvements slow down | open ordinary PRs closed or re-scoped |

Issue drafts for R1 to R10 are in `plan/log/ir-migration-strategy-review-2026-11-19-issue-drafts/`. They carry no
ids: the reviewer's session was not permitted to run the id allocator. The lead allocates ids and moves them to
`plan/issues/`.

## Open items and limits

- The mechanism/proof splits in question 3 are sample and regex estimates; the timings are single runs; the
  audit-off experiment covers 4 programs.
- The need cover is syntactic: an upper bound on what compiles, silent on what passes.
- Round counts in question 4 are estimates from verdict text; 22 threads were read in full, not the 30 asked for.
- Legacy and runtime line splits are heuristics.
- The borrow route (R4) and the linked harness were read from code, not built.
- The ES5 census figures are the project's own (PR #7308); they were not re-run.
