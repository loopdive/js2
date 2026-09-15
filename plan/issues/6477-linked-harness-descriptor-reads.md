---
id: 6477
title: "Linked test262 harness: property-descriptor reads on consumer values differ from the honest lane"
status: done
completed: 2026-09-15
sprint: current
created: 2026-09-14
updated: 2026-09-15
# (2026-09-15, #6477 P2) The descriptor read and the two enumeration imports
# gain a `_decoderExportsFor` redirect plus the comment that explains WHY the
# redirect belongs at `_readOwnDescriptor`'s top rather than at each caller.
# The growth is comment-dominated; the mechanism is three assignments.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
language_feature: property-descriptors
goal: test262-conformance
depends_on: [3451]
related: [3451, 5225, 6475, 6482, 6483]
# id reserved 2026-09-14 with pr_scan="degraded" (gh unreachable): verified
# against upstream main + the assignment ref, NOT against in-flight PRs.
---

# #6477 — descriptor VALUES read wrong across the linked-harness boundary

## Problem

~14 rows of the #3451 slice-3 sample (measured 2026-09-14, 404 rows) differ with
messages of the form

```
foo descriptor value should be foobar
property descriptor value should be
Expected obj[foo] to equal NaN, actually data
```

concentrated in `built-ins/Object/defineProperty`.

## Why it is NOT the known pre-existing gap

`Object.prototype.hasOwnProperty.call` / `in` / `Object.hasOwn` on a compiled
object already answer wrong in the HONEST single-module lane under `allowJs`
(measured during #3451 P2), and #3451's substrate tests assert only PARITY there
because both lanes fail alike.

**These rows are different: the honest lane PASSES them.** So a value that the
honest lane reads correctly through `Object.getOwnPropertyDescriptor` reads
wrong when the reader is the provider and the object is a consumer struct. The
#5225 cross-module decoder registry is the mechanism that is supposed to answer
here (`_decoderExportsFor`), so the first question is whether it is consulted on
the descriptor-VALUE path at all, or only on the presence path.

## Acceptance criteria

- [ ] A minimal body reproducing one of the three messages, with the runtime
      path named.
- [ ] It is established whether `_decoderExportsFor` is reached on the
      descriptor-value read, and the answer recorded here.
- [ ] The ~14 rows flip to agreement without changing the honest lane.

## Implementation Plan (2026-09-15, Fable lane; implementation: Opus)

### Root cause (measured, not inferred)

Instrumented `src/runtime.ts` + `src/runtime/cross-module-struct-owners.ts`
and ran four minimal bodies through `scripts/test262-linked-harness-smoke.mts`
(cases kept in `.tmp/p6477/cases2`, gitignored):

```
[6477] __getOwnPropertyDescriptor import foo object (struct)
[6477] decoderFor enabled: false modules: 1 local=null
[6477]   -> desc undefined
```

While the test body runs, **the consumer is not a registered decoder**: the
#5225 registry holds ONE module (the provider), so `enabled` is false and every
cross-module read the provider makes on a consumer struct — `_readOwnDescriptor`
step 3 (`__sget_<name>` / `_structHasOwnFieldName`), `_safeGet`'s
`_crossModuleCallbackState`, `_wasmStructHasOwn` — resolves with the
**provider's** exports, whose `__struct_field_names` answers `null` for a
struct it never minted. Result: `undefined` for a literal field, a `null`/`0`
miss-default for a boxed number/NaN, "should be an own property" for
`hasOwnProperty`.

Why the consumer is missing: `scripts/test262-import-object.mjs` registers it
in `wireCompiledInstance(importObj, instance, true)` **after**
`WebAssembly.instantiate` returns — but a test262 body is top-level code, and
in the JS lane top-level code runs in the wasm `start` section, i.e. DURING
instantiation (this is the #5193 window: "the wasm `start` section runs before
`instance.exports` exists"). The Temporal lane (#5225/#5353) never noticed
because its consumer bodies also run in `start`, but their cross-module reads
go through funcref-registered helpers or happen post-init; the harness lane
makes the provider read consumer structs on the hot path.

The honest lane passes the same rows because there is one module and the
decoder redirect is a no-op. So this is a lane defect, not a codegen defect,
and it answers the issue's first question: `_decoderExportsFor` IS reached on
the descriptor-VALUE path (via `_readOwnDescriptor` callers) — it just has
nothing to redirect to.

**Also found, same trace:** `__getOwnPropertyDescriptor` (runtime.ts ~L14449)
passes `callbackState?.getExports()` straight into `_readOwnDescriptor`; unlike
`_wasmStructHasOwn` (which applies `_decoderExportsFor` at its top) it never
redirects. Fixing registration alone leaves that import reading the provider's
exports.

### Fix — two parts, host-side only, honest lane byte-identical

**P1 — run the linked body AFTER the consumer is wired (the actual fix).**
The mechanism already exists: `CompileOptions.deferTopLevelInit` (#2796,
`src/index.ts` ~L905) exports `__module_init` instead of installing a `start`
section, and `tests/issue-4017.test.ts` shows the host shape:
`setInstance(instance)` then `exports.__module_init()`.

1. `src/test262-harness-provider.ts` `compileHarnessLinkedBody` (~L446): pass
   `deferTopLevelInit: true` alongside `canonicalRuntimeTypes` /
   `sharedExceptionTag`. Consumer only — the provider build (`compileProject`,
   ~L303) is unchanged.
2. `scripts/test262-import-object.mjs` `instantiateTest262Module` linked arm
   (~L268): after `wireCompiledInstance(importObj, instance, true)`, if
   `typeof instance.exports.__module_init === "function"`, call it. Keep the
   call INSIDE the linked arm so the honest lane's instantiate path is
   untouched. A throw from `__module_init` must propagate exactly like a
   start-section throw did (the worker classifies the row from that rejection).
3. Async rows (`$DONE`, #6476): `__module_init` returning does not mean the
   row is done; the worker already awaits the marker after instantiate, so
   nothing changes — but verify with `tests/issue-6476-linked-async-marker.test.ts`.
4. Anything else that instantiates a linked harness body must make the same
   call: `scripts/test262-linked-harness-smoke.mts` and the three
   `tests/issue-3451-*`, `tests/issue-6475-*`, `tests/issue-6476-*` suites all
   go through `instantiateTest262Module`, so step 2 covers them — confirm by
   grep for `compileHarnessLinkedBody(` callers.

**P2 — redirect the descriptor import through the decoder registry.**
`src/runtime.ts` `__getOwnPropertyDescriptor` import: compute
`const exports = _decoderExportsFor(obj, callbackState?.getExports())` once and
pass it to `_readOwnDescriptor` (and to the `_wrapForHost` on the static-method
branch below it). Same one-line treatment for `__getOwnPropertyNames` and
`__propertyIsEnumerable` if they take the raw `getExports()` (check; `has` /
`in` already redirect via `_wasmStructHasOwn`). Single-module behaviour is
unchanged because `_decoderExportsFor` returns `exports` when no linked project
is live.

Do NOT extend `INIT_MARSHAL_HELPERS` (#5193) to carry `__struct_field_names` /
`__sget_*` into the start window — that is the alternative design and it does
not scale (one funcref per field name per module); P1 removes the window
instead.

### Order and validation

1. Capture the before-state: `node --import tsx scripts/test262-linked-harness-smoke.mts .tmp/p6477/cases2 10`
   (recreate the four bodies from this issue's "Root cause" if `.tmp` is gone:
   `num`, `plainval`, `arr540`, `a67desc` — see git history of this file's
   lane notes) and the 13 rows named below via the real worker protocol
   (`tests/test262-local-shard1.test.ts`, `COMPILER_POOL_SIZE=1`,
   `TEST262_ORACLE_MODE=linked` vs honest).
2. P1, then P2. Rebuild BOTH bundles before measuring — the worker and the
   smoke load `scripts/runtime-bundle.mjs` (`pnpm run build:runtime-bundle`),
   not `dist/`; a `pnpm run build` alone leaves the lane on the old runtime.
3. New test `tests/issue-6477-linked-descriptor-reads.test.ts` modelled on
   `tests/issue-6475-linked-provider-realm.test.ts`: the four bodies above pass
   in the linked lane; plus a control asserting `__module_init` is exported and
   `startFuncIdx` is absent for a linked body, and present/absent the other way
   round for an honest compile (byte-identity guard for the honest lane).
4. `tests/issue-3451-*`, `issue-6475-*`, `issue-6476-*`, `issue-5225*`,
   `issue-5353*`, `issue-5364*`, `issue-5738*` green; equivalence gate clean.

### The 13 rows (2026-09-15 measurement, all honest=pass linked=fail)

- `built-ins/Object/defineProperty/15.2.3.6-4-{49,67,68,299-1,300,354-10,540-8}.js`
- `language/expressions/class/elements/multiple-{stacked-definitions-rs-static-async-method,stacked-definitions-rs-static-generator-method,stacked-definitions-rs-static-generator-method-…-alt,definitions-rs-privatename-identifier-initializer-alt,definitions-rs-static-privatename-identifier-alt,stacked-definitions-grammar-privatename-identifier-semantics-stringvalue}-privatename-identifier*.js`

### Acceptance

- [x] The four minimal bodies pass in the linked lane (vitest) — **3 of 4.**
      `num`, `plainval` and `a67desc` pass and are pinned in
      `tests/issue-6477-linked-descriptor-reads.test.ts`. `arr540`
      (`verifyEqualTo` on a compiled ARRAY index) does NOT pass and is not
      fixable host-side — see "Residual 1" below.
- [ ] ≥ 12 of the 13 rows flip to agreement on the real worker — **NOT met:
      9 of 13** (see the measurement below). The remaining 4 are two distinct
      mechanisms, both outside P1/P2, both named below.
- [x] Honest lane byte-identical — `deferTopLevelInit` is set only in
      `compileHarnessLinkedBody`; the control test asserts an honest compile
      still carries a wasm `start` section and exports no `__module_init`, and
      the linked compile is the reverse. Equivalence gate: no new regressions
      (22 failing / 1720 passing, all 22 in the baseline).
- [x] `plan/issues/3451-…md` measurement table gets a new row.

## Implementation notes (2026-09-15, Opus lane)

### What was implemented

Both parts of the plan, unchanged in intent. One deliberate deviation:

**Deviation — P2's redirect went into `_readOwnDescriptor` itself, not only
into the `__getOwnPropertyDescriptor` import.** The plan asked for the redirect
at the import site. Doing it one level down (`exports = _decoderExportsFor(obj,
exports)` as the first statement of `_readOwnDescriptor`) is strictly stronger
and smaller: every export that function reaches — `__is_vec`, `__vec_len`,
`__vec_get`, `__sget_<name>`, and the `_wasmStructHasOwn` gate — is redirected
at once, and it also covers `_wasmStructPropertyIsEnumerable`, which funnels
into `_readOwnDescriptor` and which the import-site fix would have missed.
`_decoderExportsFor` is idempotent and a no-op when no linked project is live,
so the single-module lane is unchanged. The import site keeps one local
(`descExports`) because the static-method branch's `_wrapForHost` needs it too.
`__getOwnPropertyNames` got the same one-line redirect; `__propertyIsEnumerable`
needed none once `_readOwnDescriptor` redirects.

### Measurement (real worker protocol)

`tests/probe-6477.test.ts` = `runTest262Chunk(0, 1)` (gitignored probe),
`COMPILER_POOL_SIZE=1`, `TEST262_PATH_FILTER_FILE` holding **47 rows**: the 7
named `defineProperty` rows plus the WHOLE
`language/expressions/class/elements/multiple-*privatename-identifier*` family
(40 rows) — a superset, because the issue's 6 class names were elided and the
family is the honest unit. Honest lane = same command without
`TEST262_ORACLE_MODE=linked`. Note the filter paths need the `test/` prefix
(`relative(TEST262_ROOT, …)` where `TEST262_ROOT` is the submodule root).

| metric | before | after |
| --- | --- | --- |
| honest/linked agreement, 47 rows | **4 / 47** | **25 / 47** |
| linked rows flipped fail→pass | — | **21** |
| linked rows regressed pass→fail | — | **0** |
| `class/elements` **stacked** variants | 0 / 20 | **18 / 20** |
| `class/elements` **non-stacked** variants | 0 / 20 | 0 / 20 |

The 7 named `defineProperty` rows individually:

| row | before | after | remaining message |
| --- | --- | --- | --- |
| `15.2.3.6-4-49.js` | fail | **pass** | — |
| `15.2.3.6-4-67.js` | fail | **pass** | — |
| `15.2.3.6-4-354-10.js` | fail | **pass** | — |
| `15.2.3.6-4-68.js` | fail | fail | `foo descriptor value should be fghj; foo value should be fghj` |
| `15.2.3.6-4-299-1.js` | fail | fail | `Expected obj[0] to equal 10, actually 0` |
| `15.2.3.6-4-300.js` | fail | fail | `Expected obj[0] to equal 10, actually 0` |
| `15.2.3.6-4-540-8.js` | fail | fail | `wasm closure dispatcher __call_fn_0 is not available` |

Scoring the issue's own 13 rows (reading the 6 elided class names as their
`multiple-stacked-definitions-*` spellings, which is the only reading under
which the issue's "honest=pass linked=fail" claim held for all 6): **9 of 13
flip**, short of the ≥12 bar.

The four minimal bodies via `scripts/test262-linked-harness-smoke.mts`
(`.tmp/p6477/cases2`, honest column is the script's own limited lane):

| body | before (linked) | after (linked) |
| --- | --- | --- |
| `a67desc` | pass | pass |
| `num` | `numeric desc Expected SameValue(«undefined», «1001»)` | **pass** |
| `plainval` | `Expected SameValue(«undefined», «"abcd"»)` | descriptor now reads `abcd`; the row still fails on its `verifyEqualTo` line (Residual 1) |
| `arr540` | `Expected obj[0] to equal NaN, actually null` | unchanged (Residual 1) |

### Residuals — why they are NOT P1/P2 bugs

**Residual 1 — a provider reading a consumer ARRAY by index never reaches the
host at all.** `verifyEqualTo(arr, "0", v)` is `arr[name]` inside the provider.
Instrumenting `_safeGet` and the `__extern_get` import and running the smoke
with the trace on: after `__module_init` is called, **zero** runtime imports
fire for that row. The read is lowered to in-wasm vec access and `ref.test`s
against the PROVIDER's own types, misses, and yields the null/0 default. No
host-side decoder redirect can see it, so this needs a codegen/ABI answer
(the linked ABI must make a consumer-minted vec castable in the provider), not
another `_decoderExportsFor` call. This covers `arr540`, `plainval`'s second
line, `15.2.3.6-4-299-1`, `-300`, and (as a closure-dispatch variant of the
same crossing) `-540-8`.

**Residual 2 — `verifyProperty(C.prototype, "m", …)` on a class that ALSO has
fields.** All 20 `multiple-stacked-definitions-*` rows flip; all 20
`multiple-definitions-*` rows still fail, and their message CHANGED from
`foo descriptor value should be foobar` (the #6477 symptom, now gone) to
`m should be an own property`. The only structural difference between the two
templates is that the non-stacked one additionally declares `foo = "foobar"`
plus prototype methods `m()`/`m2()` and then runs `verifyProperty` on
`C.prototype`. The reduced form (`class C { m(){} }` + the same
`verifyProperty`) PASSES in the linked lane, so the trigger is the combination
of instance fields and prototype methods on one class object, not the
descriptor path #6477 fixed. Worth its own issue.

### Test-suite change outside the new file

`tests/issue-3451-linked-harness-substrate.test.ts` — the
`verifyProperty on a consumer object own property` case was a PARITY assertion
(both lanes fail alike). The linked lane now PASSES it while the honest lane
still fails on its pre-existing `allowJs` hasOwnProperty gap, which is the good
direction, so the case was lifted out of the parity `it.each` into a one-sided
assertion (`linked === "pass"`, `honest === "fail"`) with a dated note. The
other parity case (`function name`) is unchanged.

### Suites run

`issue-6477-*` (5/5), `issue-3451-*` (11/11), `issue-6475-*` (6/6),
`issue-6476-*` (3/3), `issue-5225-*`, `issue-5353-*`, `issue-5364-*`,
`issue-5738-*` (42/42 together), equivalence gate clean.
`tests/issue-4162.test.ts` has 2 failures in this container, both
`JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` —
environmental (missing `.test262-cache/quickjs-artifact-*/libquickjs.wasm`),
not related to this change.

### Acceptance decision (2026-09-15, Fable lane)

Accepted as done with the "≥ 12 of 13" box retargeted: the 9 rows this issue's
mechanism owned (consumer unregistered during `start`; descriptor import not
redirected) all flipped, with 21 fail→pass and 0 pass→fail on the 47-row
scope. The 4 remaining rows are two different mechanisms, measured above and
filed separately: in-wasm vec index reads across modules (#6482) and the
class-with-fields prototype own-property answer (#6483).
