---
id: 6419
title: "Eleven closure-area tests across ten files are red on current main — found by an A/B sweep, every one identical on both arms"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Found while refreshing [#5356](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5356-eager-capture-box-skips-let-const)
onto main (PR #5683). A sweep of the 100 test files under `tests/` whose names
match closure / capture / TDZ / hoist / destructuring / switch / let-const /
block-scope turned up 11 failing tests in 10 files.

**Every one of them is on main, not in that PR.** Each was re-run twice at one
head — once with the PR's seven touched `src/` files reverted to their
`upstream/main` content, once with the fix — and the failing-test lists came
back **byte-identical**, only the timings differing. That control matters most
for `#2623`, which is literally a capture-box-depth test and the first thing a
reader would suspect.

CI is green on main, so none of these are in a required lane today. They are
real defects that the gates do not currently see.

## The failures

| file | failing test | symptom |
| ---- | ------------ | ------- |
| `tests/illegal-cast-closures-585.test.ts` | assert_throws pattern with capturing closure | `Codegen error: prepared class … descriptor is stale` |
| `tests/issue-1058-function-hoist-facts.test.ts` | (whole file, at collection) | `TypeError: Cannot read properties of undefined (reading 'MAP')` |
| `tests/issue-1128-dstr-tdz.test.ts` | self-reference in array destructuring default throws | assertion |
| `tests/issue-1528-closure-construct.test.ts` | does NOT route a generator-method value through the construct bridge | expected `false`, got `true` |
| `tests/issue-1712-capture-closure-dispatch.test.ts` | prototype method returns a fnctor-instance node graph (acorn shape) | assertion |
| `tests/issue-2623-capture-box-depth.test.ts` | Constructor and its nested resolve capture callCount at the SAME depth | assertion |
| `tests/issue-2623-capture-box-depth.test.ts` | the capability fixture's nested capture is single-boxed (no cell-of-cell) | assertion |
| `tests/issue-2637-b2-ctor-closure-registration.test.ts` | `Promise.try.call(SubPromise, …)` runs the user body on the capability promise | assertion |
| `tests/issue-3036-late-microtask-closure.test.ts` | single instance: the late callback fires cleanly and sets the module global | assertion |
| `tests/issue-3036-late-microtask-closure.test.ts` | back-to-back instances: an earlier instance's late microtask survives a later `setExports` swap | assertion |
| `tests/issue-3520-closure-host-bridge-abi.test.ts` | does not discover closure helpers from a forged closure-free name family | assertion |

Three deserve calling out because their shape, not just their count, is
informative.

### `prepared class … descriptor is stale` — a compile error, not a wrong answer

```
Compile failed:
  L0: Codegen error: prepared class ir-class:v1:ir-source%3Av1%3A0000000000000000%3Aentry%3Ainput.ts:root:declaration:0000000000000000 descriptor is stale
```

The other 6 tests in that file pass. A stale-descriptor rejection means the
prepared-class cache key and the descriptor it resolves to have diverged, so
this is a caching/invalidation defect in the prepared-class path rather than
anything about closures — the `assert_throws` shape just happens to reach it.
Note the all-zero hash segments in the key.

### `collections-brand.ts` circular-import TDZ — the file cannot load first

`tests/issue-1058-function-hoist-facts.test.ts` fails at **collection** time,
standalone, with no test having run:

```
TypeError: Cannot read properties of undefined (reading 'MAP')
 ❯ src/codegen/collections-brand.ts:100:24
     99| const KIND_OF: Record<CollectionClass, number> = {
    100|   Map: COLLECTION_KIND.MAP,
 ❯ src/codegen/expressions/calls.ts:36:1
```

`COLLECTION_KIND` is `undefined` at module-evaluation time — a cycle between
`src/codegen/collections-brand.ts` and `src/codegen/expressions/calls.ts` where
`KIND_OF`'s top-level initializer runs before the other module's binding is
populated.

**This one is latent rather than permanently red, which is exactly why CI stays
green.** It throws only when this module is the *first* thing to pull the cycle
in. Run the file alone (or first in a fork) and it reproduces; run it after
almost anything else and it does not. So it is an ordering hazard that will
surface as a mystifying, unrelated-looking failure the next time vitest's
sharding shuffles — and the error will point at `collections-brand.ts`, which
will be innocent.

### A generator method IS routed through the construct bridge

`tests/issue-1528-closure-construct.test.ts`: expected `false`, got `true`. The
three sibling assertions — generator **function**, async function, plain
function — all pass, so the classifier handles every case except a generator
declared as an object/class **method**.

## Reproduction

```bash
node node_modules/vitest/vitest.mjs run \
  tests/illegal-cast-closures-585.test.ts \
  tests/issue-1528-closure-construct.test.ts \
  tests/issue-1058-function-hoist-facts.test.ts \
  --pool=forks --poolOptions.forks.maxForks=1
# → Test Files 3 failed (3); Tests 2 failed | 15 passed | 1 skipped (18)
```

The other seven files reproduce the same way, one file per vitest invocation.
Run them one at a time: the whole 100-file set, and even 12-file batches at
`maxForks=3`, OOM on a 16 GB box.

## Acceptance criteria

1. All eleven tests pass, standalone and in a batch.
2. The `collections-brand.ts` cycle gets a test that loads that module **first**,
   so the cycle cannot silently come back.
3. The generator-**method** case is added next to its three passing siblings.
4. Whatever lane should have caught these gets them: today CI is green while
   eleven tests in the repo are red, which is the finding behind the finding.
5. A/B at one head over the dogfood suites: nothing regresses.

## Implementation Plan

Re-measured on upstream/main 23a0ddaa26, one vitest fork per file: **9 of the 11 still fail**; both `#2623` rows now pass (drop them from the table). Eight distinct root causes, each pinned with a `.tmp/` probe — fix in this order, one commit each, and land as ONE PR:

1. **Import cycle (`issue-1058-function-hoist-facts`)** — chain is `map-runtime.ts → index.js/shared.js → expressions/calls.ts:36 → collections-brand.ts → map-runtime.ts` (in progress, so `COLLECTION_KIND` is `undefined` at `KIND_OF` init, L99). Move `COLLECTION_KIND` (map-runtime.ts:92) into a new import-free leaf `src/codegen/collection-kind.ts`; re-export from map-runtime.ts so no other importer changes. Test: `tests/issue-6419-collections-brand-load-order.test.ts` whose FIRST import is `../src/codegen/statements/nested-declarations.js` (the 1058 file's entry into the cycle) and asserts `KIND_OF`-backed `isCollectionReflectiveCallShape` is callable — fails on parent at collection, passes with fix.
2. **`#1128` array TDZ** — probe: `let [y = y] = []` → 0 (no throw); `[undefined]` → throws; object pattern → throws. Only the 0-field-struct "empty tuple" arm (`compileArrayDestructuring`, destructuring.ts ~L1269-1272 + the per-element loop from L1372) applies the default without the binding's TDZ read. Route that arm's default through the same TDZ-checked initializer path the 1-field tuple uses. Test: two-file untyped `.js` fixture (`[]` vs `[undefined]` as the anti-vacuity control that already passes), `let` and `const`.
3. **`#1528` generator method** — probe: `{ *m(){} }.m` emits `__construct_closure`; `function*` value does not. `initIsGenerator` (new-super.ts ~L6217) only unwraps `FunctionExpression`; extend it (and the sibling checks at L311/L315/L540) to `PropertyAccessExpression` on an `ObjectLiteralExpression` whose property is a `MethodDeclaration` with `asteriskToken`, plus class-method members. Keep the plain-method (`{ m(){} }.m`) case routing through the bridge (it does today, and is constructable-agnostic).
4. **`#585` "descriptor is stale"** — probe: needs BOTH a class field initializer (`val: number = 10`) AND a method call captured in an arrow (`() => o.doSomething()`); drop either and it compiles. Site: `assertSamePreparedClassLayoutEntry` (program-abi-prepared-transaction.ts L410-440) via `payload.entries.forEach` L457. Step 1: make the throw name the first differing field (keep this permanently — a bare "stale" cost this diagnosis). Expected arm: the lifted arrow re-prepares the class after the field-initializer pass mutated `session.draft` / `structuralReferenceBindingIds`; fix by re-observing the class layout at second prepare (or excluding the session-mutable fields from staleness) — NOT by relaxing `preparedProgramAbiDraftsEqual`. Order constraint: entries must stay in declaration order; the fix must not renumber `declarationOrder`.
5. **`#1712` fnctor instance readback** — probe: `export function parse(){ return new Node("Program") }` in a `.mjs` (signature `result: "aggregate"`) reaches the host as a null-proto `{}` with no `type` in all three shapes (direct / via function / via prototype method), so this is the export-boundary aggregate marshal in `wrapExports` (runtime.ts ~L19517 `invoke` result path), not closure dispatch. Find where class-instance structs get a boundary view and add fnctor-instance struct types (declarations.ts L391/L414 mark them `aggregate` but no view is built). Test: same two-file `.js` fixture, control = the string-returning sibling that passes on parent.
6. **`#3036` standalone drain** — standalone now has the native Promise lane: `run(): void` enqueues the job and nothing drains it (host drains only through `_drainNativePromiseBoundary`, which needs a promise boundary). Test premise stale, not a compiler defect: after `inst.run()` call `exports.__drain_microtasks()` exactly as `tests/issue-3518-…test.ts:351` does; keep the multi-instance `setExports` swap assertion intact.
7. **`#2637` `Promise.try`** — environment: Node 22 has no `Promise.try` (CI runs Node 24/25 and is green). `package.json` says `engines >=20`, so add a host-runtime polyfill for `Promise.try` next to the existing `withResolvers` handling in `src/runtime.ts` (standalone lane already lowers it natively); if the polyfill is out of scope, `it.skipIf(typeof Promise.try !== "function")` with a comment.
8. **`#3520` forged name family** — probe: ANY class with a method whose instance escapes (`class Empty { ping(){} }` + `makeEmpty()`) now yields 13 `:closure-host-bridge:` ABI entries and `$c*` exports; a field-only class yields 0. The test's last touch is 2026-09-03; `closure-exports.ts` changed on 09-05 (#5329, `d7c572931a`/`81b5f4ea91`). Bisect those two on this single test. If #5329 intentionally reserves the method-dispatcher family for escaping instances, rewrite the row to assert OWNERSHIP (user `__is_closure`/`__call_fn_0`/`$cf` keep the public labels, compiler aliases under `$cf$`), else restore the gate.

**Lane gap (acceptance 4):** verify which CI job runs `tests/issue-*.test.ts` (grep `ci.yml`/`quality` for the vitest globs) — the Node-version arm explains only #2637; the other eight must be excluded by a glob or list. Add the missing glob, or record the exclusion in `docs/ci-policy.md` if it is deliberate (OOM).

**Dogfood/standalone expectation:** anchors unchanged (webpack 16/16 · three 17/18 · clsx 32/32 · lodash 59/62 · redux 67/82 · axios 208/231 · jest 335/356 · hono 259/324 …); #5 may move acorn-shaped packages upward only. Standalone floor unchanged — #2 is shared codegen, #3 is host-lane only (standalone lowers natively, new-super.ts L3801). Run the A/B at one head before enqueue.

## Dispatch
Model: **opus** — every arm is pinned to a file/function and six of eight are mechanical; escalate #4 alone to fable if the named-field probe does not point at a single re-observe site.
