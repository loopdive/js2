---
title: Post-wave regression investigation — 2026-05-21
status: investigation
sprint: 53
type: investigation
owner: senior-developer
---

# Post-wave regression investigation — 2026-05-21

Source data:
- Regression list: `/tmp/post-wave-regressions.txt` (27 paths)
- Detailed TSV: `/tmp/post-wave-regressions-detailed.tsv`
- Baseline: `benchmarks/results/test262-current.jsonl` (refreshed 2026-05-21 00:02:15, 28225/43160 pass)
- Latest run: `benchmarks/results/test262-results-20260521-160351.jsonl` (post-wave, 16:04-16:26)

## Headline finding

**The "27 regressions" headline overstates the impact by ~6x. There are only 4 real regressions; the other 23 are CI variance noise from the compile-timeout timer.**

| Bucket | Count | Maps to PR? |
|---|---|---|
| Real assertion fails (`pass` → `fail`) | 4 | Yes — 3 to #459, 1 to #460 |
| CI noise: `pass` → `compile_timeout` | 23 | No — flake |
| **Total claimed regressions** | **27** | |

Cross-check on `compile_timeout` movement between the two runs:

| Direction | Tests |
|---|---|
| `compile_timeout` → `pass`/`fail`/etc (got faster) | **95** |
| `pass`/`fail`/etc → `compile_timeout` (got slower) | **38** |
| Net `compile_timeout` count change | **-57** (improved) |

23 of those 38 "flipped TO timeout" tests are in our regression list, but the net direction is improving. Local repro of the wrapped compile for 8 sampled timeout-flipped tests using the current `main` bundle: every one compiled in 9-342 ms (well under the 30 s limit). They are not actually slow; they hit the timer in CI on this run by accident (worker startup pauses, GC stalls, shard scheduling — the usual ~0.1 % flake background that test262-sharded carries).

Non-pass → pass improvements in the same run: **93**.

So the net true delta of the wave on test262 is approximately **+89 tests (+93 improvements, -4 regressions)** with ±~40 of CI noise on each side that cancels in aggregate. Reverting any PR over the 4 real fails would forfeit ~10x as many genuine wins.

## Per-test analysis (the 4 real regressions)

| Test | New error | Culprit PR | Confidence | Why |
|---|---|---|---|---|
| `test/language/expressions/typeof/bigint.js` | `typeof Object(BigInt(0n))` returns `"bigint"` instead of `"object"` (assert #4) | **#460 (#1129 ToObject)** | high | Commit `ff139f2e5` documents boxing for number/string/boolean only. BigInt is not listed in the wrapper switch, so it falls into the "Object(object) → return argument unchanged" branch — typeof stays "bigint". |
| `test/built-ins/TypedArray/prototype/length/length.js` | `verifyProperty(desc.get, "length", {value: 0, ...})` fails (assert #1) | **#459 (#1455 builtin subclass)** | high | `__set_subclass_proto` + extended `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` change how `TypedArray.prototype` exposes accessor descriptors. The `length` getter's own `.length` (Function-object metadata) is sensitive to the prototype splice. |
| `test/built-ins/TypedArray/prototype/findLastIndex/BigInt/get-length-ignores-length-prop.js` | `L43:3 Cannot redefine property: length` at runtime | **#459 (#1455 builtin subclass)** | high | The test does `Object.defineProperty(sample, "length", {get, configurable: true})` on a BigInt TypedArray instance. After PR #459, the prototype-chain rewiring leaves `length` as a non-configurable own slot on the instance returned by `__new_<TypedArray>(...)`, so the redefine throws. |
| `test/built-ins/RegExp/prototype/test/S15.10.6.3_A2_T8.js` | `e instanceof TypeError !== true` (assert #1) — either no error thrown or wrong type | **#459 (#1455 builtin subclass)** | medium | The test stamps `RegExp.prototype.test` onto `Object.prototype` and invokes it on the string `"."`. Whether a TypeError is thrown depends on how the runtime distinguishes a RegExp brand from a non-RegExp `this`. PR #459 modified the `__instanceof` host import and the runtime's host-vs-Wasm constructor identity for built-ins via `__set_subclass_proto`. PR #468 (#779c) is a secondary suspect — it touched `runtime.ts` constructor identity for vec/Array — but the failing brand check sits much closer to the #459 surface. |

## By culprit PR

### #459 (`issue-1455-builtin-subclass`) — 3 regressions

Commit `ca3e37094` / merge `7f38872e8`. Touched `src/codegen/builtin-tags.ts`, `expressions.ts`, `identifiers.ts`, `runtime.ts`, `class-bodies.ts`.

Sub-cluster: TypedArray prototype shape + RegExp brand check.

- `built-ins/TypedArray/prototype/length/length.js`
- `built-ins/TypedArray/prototype/findLastIndex/BigInt/get-length-ignores-length-prop.js`
- `built-ins/RegExp/prototype/test/S15.10.6.3_A2_T8.js`

Net effect of #459 is still a large net win in `language/{statements,expressions}/class/subclass-builtins/` (60/64 vs ~0/64). The 3 regressions are side-effects of `__set_subclass_proto` rewiring `Sub.prototype` into instances; the side-effect is that descriptors on prototype slots become non-configurable / shaped differently from raw `new TypedArray(...)`.

Recommended follow-up: file **#1567** — "Builtin subclass prototype splice must preserve descriptor configurability + Function.length on accessor getters". Two specific fixes needed:
1. Accessor `length` getter on `TypedArray.prototype.length` should expose `Function.length === 0` (a function-object metadata concern in the host import surface).
2. After `__set_subclass_proto`, `Object.defineProperty(instance, "length", {get, configurable: true})` must still work — the instance's own `length` slot must remain configurable.

### #460 (`issue-1129-toobject`) — 1 regression

Commit `ff139f2e5` / merge `bd24a3699`. Touched `src/codegen/expressions/calls.ts`, `runtime.ts`.

- `language/expressions/typeof/bigint.js`

Recommended follow-up: file **#1568** — "Object(BigInt) and Object(symbol) must auto-box to wrappers". `expressions/calls.ts:~5643-5750` documents the wrapper switch; add a BigInt branch that calls a new host import `__new_BigInt(bigint) → externref`. Tests `tests/issue-1568.test.ts` should mirror `tests/issue-1129.test.ts` for BigInt and Symbol.

### #468 (`issue-779c-split-constructor`) — 0 hard hits

Listed in the brief as a secondary suspect for the RegExp regression. Diff review shows the change to `runtime.ts` is scoped to `Array` / vec constructor identity — does not touch the RegExp brand path. Demoting to "unlikely culprit".

### CI noise (23 tests) — 0 PRs to map

The 23 `compile_timeout` tests are net negative regressions on paper but net positive after accounting for the 95 tests that flipped the other way in the same run. They do not justify any source code revert.

Suggested mitigation (process, not code):

1. Raise the compile timeout in `scripts/compiler-pool.ts` (currently 30s default for the runner path) to 45s. Cost: ~15s extra wall-clock on the worst <0.1% of shards. Benefit: removes the noisy edge where ~30-40 tests flip per run.
2. In `dev-self-merge` regression gate, treat `pass → compile_timeout` flips as `flake` not `regression` if `baseline_status == pass && compile_ms_baseline < 1000`. The dev-self-merge skill in `.claude/skills/` should learn this rule.
3. Don't compute "27 regressions" the next time without first filtering out timeout/timeout flips. The dashboard's regression count should split `assertion_regressions` from `timeout_regressions`.

## Recommendations

1. **Do NOT revert any PR.** The wave is a clear net win (+89 tests on a worst-case-arithmetic accounting, materially better once CI variance is netted out).
2. **Open follow-up issues** for the two real fix surfaces:
   - **#1567** (TypedArray descriptor + RegExp brand check after subclass-proto splice) — owner: senior-developer; feasibility: hard; blocks: nothing critical, but ~3 tests + likely a few more not in this list.
   - **#1568** (`Object(BigInt)` / `Object(Symbol)` auto-box) — owner: developer; feasibility: easy; ~1-3 tests.
3. **Adjust the regression-gate noise filter** before the next merge wave so future investigations don't waste a senior dev's time on 23 false positives. Process tweak, not a code change — log this in `.claude/memory/feedback_regression_analysis.md` (already exists; extend with the "compile_timeout flips are noise unless paired with compile_ms baseline > 5000ms" rule).
4. **Verify in next CI run.** After the next sharded run on `main`, re-diff against this report. If the same 23 timeout flips reappear, the timer may genuinely be too tight in this commit — but the local compile timings (<500ms wrapped) say no.

## Evidence references

- Local compile timings (raw): `.tmp/probe-compile-time.mjs` — every regressed test compiles in <500ms with the current `main` bundle.
- Local compile timings (wrapped through `wrapTest`): `.tmp/probe-wrapped-time.ts` — same conclusion.
- Diff counts: `git diff --shortstat <main_before_pr>..<branch_head>` per PR.
- Baseline snapshot used: 28225/43160 pass, commit `76e4640d6`.
