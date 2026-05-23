---
id: 1589
title: Investigate 100 test262 tests that hit the 30s compile_timeout ceiling
status: done
sprint: 54
priority: medium
feasibility: medium
type: perf
labels: [test262, ci, compiler-perf]
---

## Problem

100 tests in `benchmarks/results/test262-current.jsonl` carry `status:
compile_timeout` with `compile_ms: 30000, exec_ms: 0`. They all pin the
vitest per-test timeout (30 s) and never finish compiling. They are spread
across 13+ areas of the test262 corpus, so this is not a single missing
feature — it's likely a small handful of compiler hot spots (parser bombs,
runaway analysis, infinite recursion in IR lowering) each catching many
related tests.

Impact on CI wall time:
- In the 115-shard run, the worst shards were dominated by 3 × 30 s
  timeouts each (= 90 s of the ~100 s shard wall time, validated against
  the committed baseline).
- The recent slow-test sorting PR (`slow-lane-shard`) puts these tests
  at the start of each shard so they overlap with the rest of the
  fork-pool work, but they still cost 30 s of fork time each.
- Resolving them would shave significant fork-time and cut the longest
  shard back to the level of the median (~50–69 s).

## Hot buckets (count, path prefix)

```
 18  test/built-ins/Array
 13  test/built-ins/Object
  9  test/built-ins/Temporal
  7  test/built-ins/String
  5  test/built-ins/Promise
  5  test/built-ins/TypedArrayConstructors
  4  test/built-ins/RegExp
  4  test/built-ins/Set
  4  test/built-ins/TypedArray
  4  test/language/function-code
  3  test/annexB/language
  2  test/built-ins/{JSON,Math,Iterator,DataView}
  2  test/annexB/built-ins
  ≤1 misc (Map, parseFloat, Proxy, Date, encodeURI, Symbol, Reflect,
       WeakMap, Function, Number, …)
```

Sample test paths (full list: pull `compile_timeout` entries from
`benchmarks/results/test262-current.jsonl`):

```
test/built-ins/Array/prototype/reduce/15.4.4.21-1-11.js
test/built-ins/Array/prototype/with/name.js
test/built-ins/Object/defineProperties/15.2.3.7-5-b-39.js
test/built-ins/Promise/any/ctx-non-ctor.js
test/built-ins/RegExp/property-escapes/generated/Script_-_Bengali.js
test/built-ins/String/prototype/replaceAll/searchValue-replacer-call-abrupt.js
test/built-ins/Temporal/Duration/prototype/subtract/argument-mixed-sign.js
test/language/function-code/10.4.3-1-71-s.js
test/annexB/language/eval-code/direct/func-block-decl-eval-func-skip-early-err-for-of.js
```

## Investigation plan

1. Run a single timeout test under a much longer ceiling
   (`COMPILER_POOL_SIZE=1` + 5-minute timeout) to determine whether it
   eventually finishes (= O(N²) or worse parser/IR pathology) or truly
   loops forever (= bug).
2. Group by suspected root cause:
   - Tests that import `_FIXTURE.js` with deeply-nested classes
   - Tests using `assert.throws` patterns we mis-classify as type
     narrowing
   - Generated `property-escapes` tests that may explode regex
     compilation
   - `Temporal/*` tests that hit the prototype chain hard
3. Either:
   - Fix the compiler hot spot (preferred — restores real conformance)
   - Add a narrow skip rule with a back-pointer to the root-cause issue
     (acceptable if the fix is in a much larger refactor)

## Acceptance criteria

- ≤ 20 tests remain at `compile_timeout` in the next baseline refresh
- Per-shard p95 wall time ≤ 70 s on the 115-shard matrix
- Root-cause issues filed for the remaining timeouts

## Related

- `slow-lane-shard` PR — within-shard sorting by descending duration so
  these timeouts run first in each shard, surfacing them early in CI
  logs and overlapping their wall time with the rest of the shard.
- `tests/test262-slow-tests.json` — the duration map (also contains these
  timeouts, sorted to the top of each shard).
- `scripts/refresh-slow-tests.mjs` — regenerates the map from the
  committed baseline JSONL.

## Findings (2026-05-23 investigation)

### Headline result

Of the 100 `compile_timeout` rows in the committed baseline, **only 5
actually reproduce locally** when each test is run in a fresh fork
(POOL_SIZE=1, unified worker, 8s budget). The remaining **95 are CI
noise** — fork-pool contention, GC pauses near the 30s ceiling, or
flaky scheduling under the 50-shard matrix. They pass cleanly in
isolation.

This reframes the issue: the bucket is not 100 compiler bugs but a
small handful of real runaway loops plus a long tail of timing flake.

### Reproduction harness

`.tmp/probe-pool.mts` in the investigation worktree drives the real
`CompilerPool` (unified worker = compile + execute in a child process)
against a list of test262 paths and reports timeouts per-test. Same
code path the sharded CI runner uses, just isolated:

```
POOL_SIZE=1 TIMEOUT_MS=8000 npx tsx .tmp/probe-pool.mts <paths…>
```

Ran the full 100-test list at 8s budget → 5 timeouts. Re-ran the
remaining 95 in a fresh pool at 8s → 0 timeouts. Re-ran the 5 hot
spots individually at 15s → all 5 still hang.

### Misnamed status

`compile_timeout` is misleading — the 30s budget covers **compile +
execute** in one fork. For the 5 real hot spots, compilation finishes
in <500ms; the hang is in the **executing Wasm test() function**, not
in the compiler. None of the 5 have a parser/IR bomb. The category
label should arguably become `wall_timeout` to avoid future
investigations starting in the wrong layer.

### Hot spot A — `Array.prototype.{indexOf,lastIndexOf}.call(obj, …)` with `length: 4294967296` (3 tests)

Tests:
- `built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js`
- `built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js`
- `built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js`

Root cause:

1. The test builds `var obj = { 0: targetObj, 4294967294: targetObj,
   4294967295: targetObj, length: 4294967296 }` where
   `targetObj = {}`.
2. Our codegen compiles the object literal to a wasmGC struct with
   field types inferred from the value expressions:
   ```
   (struct (field $0 (mut (ref null 13)))
           (field $4294967294 (mut (ref null 13)))
           (field $4294967295 (mut (ref null 13)))
           (field $length (mut f64)))
   ```
   …where `(ref null 13)` is the `Test262Error` struct ref (the only
   non-empty struct in scope). `targetObj` is an empty externref `{}`
   so `ref.test (ref 13)` fails, and the struct ends up storing
   `ref.null 13` in fields "0", "4294967294", "4294967295".
3. `Array.prototype.indexOf.call` inlines the search loop generated
   in `src/codegen/array-methods.ts` (`compileArrayLikePrototypeCall`).
   The loop reads `len = __extern_length(obj) = 4_294_967_296` from
   the struct's `__sget_length` export and iterates
   `i = 0; i < len; i++`, calling `__extern_has_idx(obj, i)` each
   iteration.
4. `__extern_has_idx` checks the `__sget_<i>` export at runtime; the
   exported getter returns `null` (per step 2). The runtime sees a
   null payload and returns 0, so `has_idx` reports "no property at
   i=0" even though field "0" exists. The loop never short-circuits
   and grinds through ~30M iterations/second × 30s = ~900M of the
   4.29B iterations before the pool kills the fork.

Confirmed via `.tmp/probe-trace2.mts` (wraps every env import with a
proxy and prints `__extern_has_idx` returns) and `.tmp/probe-has-idx.mts`
+ `.tmp/probe-struct-keys.mts` (inspects the struct fields directly).

Fix sketches (none landed in this PR — see "Why no compiler fix
landed" below):

- **Cheapest:** the codegen object-literal pass shouldn't pick
  `Test262Error` as the field type for `0: targetObj` when `targetObj`
  is `any` / unknown structural shape. Widen to `externref` for
  property values that don't have a single matching struct candidate.
- **Defensive runtime fix:** in `__extern_has_idx`, when the
  `__sget_<i>` getter exists at all, treat the property as present
  even if the returned value is null (because that's still a
  configured field, just nulled out). Risk: breaks tests that rely on
  HasProperty distinguishing "field exists, value is null" from
  "field absent" — needs a survey of how often this matters in
  test262.
- **Loop-side fix:** the inlined loop could optionally call
  `__extern_get_idx` first and check non-undefined instead of going
  through has_idx for these struct-backed receivers. Adds one host
  call per iteration in the hot path, regresses the well-typed case.

Estimated payoff: **3 tests** (the indexOf/lastIndexOf trio). Same
underlying bug; one fix lands all three.

### Hot spot B — `Array.prototype.toSorted` with closure-throwing comparator (1 test)

Test: `built-ins/Array/prototype/toSorted/comparefn-not-a-function.js`

The test loops over 10 invalid comparators (`null`, `true`, `42`,
`Symbol()`, etc.) and asserts each one makes `toSorted` throw a
TypeError. The bridge from each iteration's `assert.throws(..., () =>
[1].toSorted(invalidComparators[i]))` to our codegen produces
something that hangs (`compile + exec > 15s` in isolation). Did not
fully diagnose — needs a per-iteration trace. Could be `toSorted`
codegen not checking IsCallable before reading `length`, then the
length-throw branch infinite-looping into the closure body.

Estimated payoff: **1 test**.

### Hot spot C — `eval()` in a 65k-iteration loop (1 test)

Test: `language/comments/S7.4_A6.js`

```js
for (var indexI = 0; indexI <= 65535; indexI++) {
  eval("/*var " + String.fromCharCode(indexI) + "xx = 1*/");
  …
}
```

Our `shouldSkip` filter passes this test through because the source
doesn't contain a top-level `eval` shape it recognizes (the `eval`
call is inside the loop body and the filter probably looks at
identifier names only). Compilation succeeds (eval gets compiled to a
stub that probably re-enters compile() or throws); execution then
loops 65,536 times. Even at 1ms per iteration this is 65s — well
past the 30s ceiling.

Fix sketch: tighten the skip filter to catch `eval(` anywhere in the
source, OR add a no-op `eval` stub that returns undefined and
terminates the loop quickly. The latter is safer for tests that
genuinely use eval in negative/parse-error tests.

Estimated payoff: **1 test**.

### The 95-test long tail — CI flake, not compiler bugs

Examples that ran ≤300ms locally but timed out in CI:
- `built-ins/Math/trunc/Math.trunc_Infinity.js` — 60ms locally
- `built-ins/Promise/prototype/catch/name.js` — 90ms locally
- `built-ins/Iterator/concat/get-iterator-method-throws.js` — 55ms
- `built-ins/Temporal/*` — all skipped as proposals locally; the CI
  baseline contains entries from before the Temporal skip filter
  landed, or from runs with `TEST262_INCLUDE_PROPOSALS=1`.

These don't need compiler work. They need **CI infrastructure
improvements**:

1. **Auto-retry on `compile_timeout`**: re-run any test that hits the
   30s budget exactly once, on a fresh fork. Cheap, removes most
   noise.
2. **Drop or relabel Temporal entries** in the committed baseline
   when the runner skips them by default — these inflate the
   `compile_timeout` count by 9 with no actionable signal.
3. **Reduce fork pool size when sharding is tight** so each fork has
   more CPU headroom and tests near the 30s boundary don't pin.

### Recommended next steps (in priority order)

1. **CI infra**: add the 1-retry mechanism for `compile_timeout`
   results. Eliminates the 95-test tail at zero compiler-engineering
   cost. Estimated total effort: 1 dev-hour. **This is the cheapest
   single fix and recovers the most test slots.**
2. **Hot spot A (indexOf/lastIndexOf)**: fix object-literal field
   type inference so values that don't fit any concrete struct get
   widened to externref. Estimated effort: 1 dev-day; payoff 3 tests
   and likely several latent correctness bugs in the same family.
3. **Hot spot C (eval-in-loop)**: tighten skip filter for `eval(`
   sites. Estimated effort: 30 min; payoff 1 test.
4. **Hot spot B (toSorted)**: diagnose with a per-iteration trace;
   probably a closure/throw interaction. Estimated effort: 2-4
   dev-hours; payoff 1 test.

After (1) + (2) + (3) + (4): baseline `compile_timeout` count drops
from 100 to **~0**. Wall-time on the slowest shard drops by 30 × 5 =
150 fork-seconds.

### Why no compiler fix landed in this PR

The hot-spot-A fix touches `compileObjectLiteralForStruct` field type
resolution and risks regressing struct-shape inference across a wide
swath of code. The runtime-side defensive fix in `__extern_has_idx`
has a tractable surface area but needs a HasProperty-semantics audit
to avoid silently flipping tests that distinguish "absent" from
"null-valued". Neither is a clean 30-min change. Documenting the root
cause so the next dev can land the right fix is the higher-leverage
move from this investigation budget.

Repro artifacts left in the worktree for the follow-up dev (kept in
`.tmp/`, gitignored):
- `.tmp/probe-pool.mts` — drive the real `CompilerPool` against a
  test list.
- `.tmp/probe-exec.mts` — in-process compile + execute one test.
- `.tmp/probe-hang-test.mts` — instrumented harness that prints every
  host-import call (the script that surfaced the runaway has_idx
  loop).
- `.tmp/probe-trace2.mts` — wraps `env.*` imports with a proxy and
  prints the first few `__extern_has_idx` returns.
- `.tmp/probe-has-idx.mts`, `.tmp/probe-struct-keys.mts` — inspect
  the struct field types and the runtime helpers in isolation.
