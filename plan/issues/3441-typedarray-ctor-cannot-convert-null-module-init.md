---
id: 3441
title: "TypedArray constructor cluster throws 'Cannot convert null to object' at __module_init (2,069 default-lane fails)"
status: done
created: 2026-07-19
completed: 2026-07-20
assignee: ttraenkler/senior-dev
priority: high
task_type: bug
area: test262-conformance
goal: test262-conformance
model: fable
sprint: 73
horizon: m
related: [3417, 2375, 1623]
---

# #3441 — TypedArray ctor `Cannot convert null to object` at `__module_init`

## Summary

Harvest of the 2026-07-19 published baselines (default / JS-host lane, oracle v8)
surfaced the **single largest default-lane failure cluster**:

```
runtime_error: Cannot convert null to object [in __module_init()]
```

**2,069 official records**, thrown during module init (before the test body runs),
dominated by TypedArray constructor tests:

| category | count |
| --- | ---: |
| built-ins/TypedArray | 1,316 |
| built-ins/TypedArrayConstructors | 619 |
| built-ins/Atomics | 90 |
| built-ins/Array | 12 |
| built-ins/Proxy | 7 |

This is **not** in the #3417 oracle-v8 reclassification umbrella table (which
covers `async-marker` #3421, `strict-rerun` #3422, module-global-`undefined`
#3423, duplicate-identifier #3419, etc.). #3423 tracks
`Cannot convert **undefined** or null to object [in verifyProperty()]` — a
distinct signature (undefined, and thrown in `verifyProperty`, not
`__module_init`). This cluster is `null` specifically, thrown in
`__module_init()`, and is TypedArray-constructor-centric — a separate bug.

## Sample paths

- `test/built-ins/TypedArrayConstructors/ctors/length-arg/use-default-proto-if-custom-proto-is-not-object.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/detached-buffer.js`
- `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/proto-from-ctor-realm-sab.js`

## Root cause (hypothesis)

The error fires in `__module_init()` — i.e. while the compiled module's top-level
code runs, **before** the test assertions. The TypedArray-ctor test corpus leans
on `%TypedArray%`-intrinsic reflection and `testWithTypedArrayConstructors` /
`testTypedArrayConversions` harness helpers that walk the TypedArray constructor
list and read `.prototype` / `[[Prototype]]` chains. A read that resolves to
`null` where an object is expected (e.g. `%TypedArray%.prototype`,
`ctor.prototype`, or a proto-from-ctor-realm lookup returning the null sentinel
instead of the intrinsic object) is coerced with a `ToObject`-style operation and
throws `TypeError: Cannot convert null to object`.

Likely the same missing-native-proto-value-read family as **#2375** (standalone
TypedArray `$NativeProto` init-trap) surfacing in the **default** lane under the
oracle-v8 harness, which exercises the real upstream harness reflection instead of
the old synthetic surrogate.

## Suggested fix

1. Reproduce with one sample under the real oracle-v8 harness
   (`testWithTypedArrayConstructors`) and capture which read yields `null`.
2. Check the `%TypedArray%` intrinsic and per-ctor `.prototype` value-reads in
   codegen — ensure they resolve to the native prototype object, not the null
   sentinel, in the JS-host lane.
3. Cross-check against #2375 (standalone init-trap) — a shared native-proto
   value-read fix may close both lanes.

## Regression note

Filed from the 2026-07-19 harvest. Largest single coherent untracked default-lane
bucket. If a prior harvest recorded a lower count for TypedArray-ctor
`module_init` traps, treat growth as a v8-harness reclassification exposure rather
than a new codegen regression (the v8 flip #3370 made the real harness
authoritative).

## Implementation Plan (architect, 2026-07-19 — verified against source)

### Root cause (confirmed, NOT codegen — a worker-lane sandbox-parity gap)

This is the **#3419 fix missing from the worker lane**. Verified chain:

1. Every affected test `includes: [testTypedArray.js]`. That harness file's
   first executable statements read TypedArray constructors as bare VALUES:
   `test262/harness/testTypedArray.js:64` is
   `var TypedArray = Object.getPrototypeOf(Int8Array);` — executed in
   `__module_init`.
2. Host/gc lane lowers a bare TA-constructor identifier to
   `__extern_get(__get_globalThis(), "Int8Array")` — the #3087 route at
   `src/codegen/expressions/identifiers.ts:818-859`.
3. In the sharded-CI worker, `__get_globalThis` resolves to the literal-harness
   sandbox built by `buildOriginalHarnessSandbox`
   (`scripts/test262-worker.mjs:72`), whose global list
   `ORIGINAL_HARNESS_SANDBOX_GLOBALS` (`scripts/test262-worker.mjs:47-71`)
   **stops at `Reflect`** — no TypedArray views, no
   ArrayBuffer/SharedArrayBuffer/DataView/Atomics/Proxy/BigInt.
4. `__extern_get` (src/runtime.ts, `name === "__extern_get"` arm) misses →
   null/undefined externref → `__getPrototypeOf` (`src/runtime.ts:9996`, the
   only site emitting exactly "Cannot convert null to object") throws in
   `__module_init`.
5. **The runner lane already fixed this**: `SANDBOX_GLOBAL_NAMES` in
   `tests/test262-runner.ts` (~line 66, the `(#3419)` comment block) added the
   full TypedArray cluster + `ArrayBuffer`/`SharedArrayBuffer`/`DataView`/
   `Float16Array`/`BigInt64Array`/`BigUint64Array`/`BigInt`/`EvalError`/
   `URIError`/`AggregateError`/`Proxy`. The worker's twin list was never
   updated. The 2,069 records are the delta between the two lanes.

Repro (confirmed): compiling `var TypedArray = Object.getPrototypeOf(Int8Array);`
and instantiating with a `globalSandbox` restricted to the worker's 22-name list
traps `TypeError: Cannot convert … to object` in `__module_init`. (The exact
null-vs-undefined wording depends on which miss path `__extern_get` takes for
the `Object.create(null)` sandbox — verify the precise message once through the
worker itself, but the mechanism is identical.)

### Changes

**File: `scripts/test262-worker.mjs`** (line 47, `ORIGINAL_HARNESS_SANDBOX_GLOBALS`)
- Bring the list to parity with `SANDBOX_GLOBAL_NAMES` in
  `tests/test262-runner.ts` — append (same order, same try/catch tolerance for
  engines lacking `Float16Array`/`SharedArrayBuffer`):
  `ArrayBuffer, SharedArrayBuffer, DataView, Int8Array, Uint8Array,
  Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float16Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  BigInt, EvalError, URIError, AggregateError, Proxy`.
- **Also add `Atomics` to BOTH lists** (90 records are `built-ins/Atomics`;
  `Atomics` is on neither list today — the runner lane presumably still fails
  those the same way).

**Structural (recommended, kills the drift class):** extract ONE shared list
into `scripts/test262-sandbox-globals.mjs` exporting `SANDBOX_GLOBAL_NAMES`;
import it from both `scripts/test262-worker.mjs` and `tests/test262-runner.ts`.
This is the third worker↔runner parity bug in this family (#3227, #3428 B,
now #3419-vs-worker) — the two hand-maintained twins are the root problem.

### Edge cases
- The sandbox pulls each name from a FRESH vm context
  (`runInContext(name, context)`) — intra-sandbox identities hold
  (`Object.getPrototypeOf(Int8Array) === Object.getPrototypeOf(Uint8Array)`),
  which is exactly what testTypedArray.js compares. Cross-realm identity vs the
  worker realm's own ctors (used by `builtinCtors` in `src/runtime.ts:7401` for
  `new Int8Array(...)` extern-construction) remains mismatched — same accepted
  tradeoff as the runner lane; do not try to unify realms in this issue.
- `try { … } catch {}` per name already tolerates engines missing a global —
  keep it for `Float16Array`/`SharedArrayBuffer`.
- Do NOT touch the `$DONE` stub or `undefined/Infinity/NaN` descriptors (#3428
  / #3367 behavior).

### How to test
- Scoped: `npx tsx` one sample through `scripts/test262-worker.mjs` (or
  `runTest262File` with the extended worker list), e.g.
  `test/built-ins/TypedArrayConstructors/ctors/length-arg/use-default-proto-if-custom-proto-is-not-object.js`
  → the `__module_init` trap must be gone (test then passes or surfaces its
  honest verdict).
- Watch the CI shard report: expect the
  `Cannot convert null to object [in __module_init()]` bucket (~2,069) to
  collapse; residuals reclassify to honest TypedArray semantics failures.
- This is an intended large INCREASE — coordinate baseline promotion, not a
  regression.

### Standalone note
Runner-side fix only; no compiler change, no host-import surface change. The
standalone lane's TypedArray intrinsic story stays #2375/#2651/#2901
(`src/codegen/builtin-value-read.ts:652-671`).

## Resolution (2026-07-20, senior-dev)

Confirmed the architect diagnosis end-to-end before touching code:

- Read both twin lists: `tests/test262-runner.ts` `SANDBOX_GLOBAL_NAMES` had
  the #3419 TypedArray cluster; `scripts/test262-worker.mjs`
  `ORIGINAL_HARNESS_SANDBOX_GLOBALS` stopped at `Reflect`. `Atomics` was on
  neither.
- `test262/harness/testTypedArray.js:64` reads
  `var TypedArray = Object.getPrototypeOf(Int8Array);` at module-init top level;
  the trap string originates at `src/runtime.ts:9996` (`__getPrototypeOf`).
- Isolated before/after repro (compile once, instantiate + `__module_init`
  twice): the 22-name worker list traps `Cannot convert undefined to object`;
  the extended list runs clean. Sandbox is the sole difference. (Local
  `Object.create(null)` sandbox yields the `undefined` wording; the harvest's
  `null` wording is the same `__getPrototypeOf` site — both fixed by seeding the
  globals.)
- Real-sample runner probe: `use-default-proto-if-custom-proto-is-not-object.js`
  and `internals/Set/detached-buffer.js` now progress PAST module init into the
  test body (residual honest TypedArray-semantics fails), no module-init trap.

**Fix (chosen: shared-list extraction — kills the drift class):**

- New `scripts/test262-sandbox-globals.mjs` exports the single
  `SANDBOX_GLOBAL_NAMES` (base + #3419 cluster + `Atomics`), side-effect-free.
- `scripts/test262-worker.mjs` and `tests/test262-runner.ts` both import it; the
  two hand-maintained twins are gone, so this parity class (#3227, #3428 B,
  #3419-vs-worker) can't recur.
- Regression test `tests/issue-3441.test.ts` asserts the shared list ⊇ the
  cluster + `Atomics` and that the built sandbox exposes `Int8Array`/`Atomics`.

Expected: the ~2,069 `Cannot convert null to object [in __module_init()]`
default-lane bucket (+90 Atomics) collapses; the honest fail→pass flip is a
fraction of that (residuals reclassify to real TypedArray-semantics fails). This
is an intended large baseline change — not a regression.

## Accepted trap-growth collateral + one-cycle #3189 override (2026-07-20)

Landing this fix required a **one-cycle** widening of the #3189 uncatchable-trap
ratchet. It is NOT a silent floor raise — the rationale and the fix-forward are
recorded here so the override is auditable and provably transitional.

**What happened.** The sandbox-parity fix lets the TypedArray harness run PAST
`__module_init` for the first time. 28 tests that previously died there (catchable
"Cannot convert null to object") now execute their body and hit PRE-EXISTING
compiler trap-gaps: `null_deref` +19 (166→185), `oob` +9 (48→57). All 28
`include: [testTypedArray.js]` and were ALREADY failing before this PR — a
failure-MODE change (catchable → uncatchable), **zero pass-loss**. Net host delta
is **+647** (656 improvements − 9 non-timeout regressions), measured in the #3430
merge_group run 29711072322.

**The override (both reset to 0 after #3430 lands + baseline promotes).**
- merge_group gate (`scripts/diff-test262.ts`, per-category): `TRAP_RATCHET_TOLERANCE=25`
  — covers null_deref +19 and oob +9.
- promote-baseline gate (`scripts/check-baseline-trap-growth.ts`): `BASELINE_TRAP_GROWTH_ALLOW=25`.

The change-scoped `trap-growth-allow:` frontmatter mechanism was NOT usable here:
both gates read it only in rebase mode (forward oracle bump, `diff-test262.ts:1766`),
and this is a same-oracle runner-only change, so the frontmatter is inert. The
repo-var valves are the only effective lever.

**Fix-forward:** #3488 tracks IMPLEMENTING the unmasked TypedArray trap-gaps
(`.set` arg-coercion / bounds, `bit-precision` codecs, `*-invoked-as-func`
reflective null-receiver guards) so the ratchet tightens back to its prior floor.
