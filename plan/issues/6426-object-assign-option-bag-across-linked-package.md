---
id: 6426
title: "`Object.assign(this, options)` in a base class drops the value when the class lives in a separately-linked package"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-13
completed: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

A base class that copies its constructor options onto `this` reads those
properties back as `null` (objects) or the wrong `typeof` (functions) — but
**only** when the class is compiled as a separately-linked package
(`linkPlan.mode === "separate"`). The identical source in a single compilation
unit is correct.

```js
// router5366/index.js  (a separately-linked package)
export class RegExpRouter { constructor() { this.name = "RegExpRouter"; } }
export class Base {
  router;
  getPath;
  constructor(options = {}) {
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
  }
}

// main.js
new Base({ router: new RegExpRouter() }).router;          // node: the instance   wasm: null
typeof new Base({ getPath: (r) => "/p" }).getPath;        // node: "function"     wasm: "object"
```

Measured 2026-09-12 on `main` at `24411b6763`, in the three lanes of
`tests/issue-5366-nullish-join-carrier.test.ts`:

| lane                            | `baseObjectAssign` | `otherOptionKey` |
| ------------------------------- | ------------------ | ---------------- |
| single module                   | `"RegExpRouter"` ✓ | `"function"` ✓   |
| two modules, one unit           | `"RegExpRouter"` ✓ | `"function"` ✓   |
| separately-linked package       | `"null"` ✗         | `"object"` ✗     |

Found while fixing
[#5366](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5366-class-instance-field-from-constructor-option-reads-null),
whose `??` join defect it is **not**: neither row contains a `??`, and both are
identical before and after that fix. The two are pinned as `LINKED_RESIDUALS`
in that test, so this issue's fix is observable as those assertions flipping.

## Hypotheses

- The declared-but-uninitialised fields (`router;`, `getPath;`) get a struct
  slot typed from the package's own view, and the cross-module `Object.assign`
  writes through a guarded store that substitutes null — the same
  null-substituting-downcast family as #5366 and #5376, one seam further out.
- `Object.assign`'s own lowering may take a different (host-reflection) path
  when the receiver's struct type is owned by another linked module, and lose
  the callable/struct identity on the way through.

`typeof … === "object"` for a copied **function** is the sharper clue of the
two: the value survives the copy but arrives as something other than a
callable, which points at the copy, not at the field slot.

## Acceptance criteria

1. Both rows answer as node does in the separately-linked lane.
2. The `LINKED_RESIDUALS` override in
   `tests/issue-5366-nullish-join-carrier.test.ts` is deleted and that lane
   asserts the shared `EXPECTED` table.
3. A/B over the 17 dogfood suites, per test file.

## Implementation Plan

**Diagnosis (measured 2026-09-12 on upstream/main `23a0ddaa26`, `.tmp/6426-repro.mts`, `linkPlan.mode === "separate"`).** Both hypotheses in the issue are wrong, and `Object.assign` is innocent: a package ctor doing `Object.assign(this, options)` directly reads back `"R"` for an object, `"function …"` for a function and `"7"` for a number. What fails is the **object-rest source**: `const { strict, ...rest } = options; Object.assign(this, rest)` → `undefined`, and a probe class storing `Object.keys(rest)` / `rest.router` answers `router|no` — the key survives, the value is lost. (Both issue rows read the same lost value; `typeof null === "object"` is why the function row "looked" different.) The root module is bundled-identical: `restKeys` = `router|has` in one unit.

**Mechanism.** `src/runtime.ts` `__extern_rest_object` (≈L13889): `const exports = callbackState?.getExports()` is the *reader's* (provider's) exports; `_getStructFieldNames(obj, exports)` internally routes through `_decoderExportsFor` (#5225) so the names are the *owner's* (consumer minted the options literal), but the value read `exports?.[\`__sget_${key}\`]` uses the provider's getter → `ref.test` miss → default. Exactly the mixed-decoder hazard the #5225 comment on `_decoderExportsFor` describes; #5225 fixed `__extern_get` (≈L12569) and one more site (≈L18535) but not this family.

**Change (host runtime only, `src/runtime.ts`).**
1. `__extern_rest_object`: `const exports = _decoderExportsFor(obj, callbackState?.getExports()); // (#5225)` — one line, mirroring L12569. Nothing else in the helper moves: result key order (owner field order, then sidecar keys), `excluded`, enumerability filter and the sidecar merge are untouched.
2. Same one-liner in the three siblings with the identical shape, so a consumer-minted struct read inside a provider is complete: `__object_values` (≈L13817), `__object_entries` (≈L13842), and the tuple arm of the slice helper (≈L13871, `_getStructFieldNames(arr, exports)` + `exports[\`__sget_…\`]`). Do NOT touch `__object_keys` (names-only, already correct) or any `ssetExports` write path in `_safeSet` (the write side is not what fails here).
3. No codegen change. `src/codegen/statements/destructuring.ts` ≈L853 correctly routes rest patterns to the externref path; the standalone twin (`__extern_rest_object` in `src/codegen/destructuring-params.ts`) never runs `runtime.ts`, so the standalone lane is unaffected — expectation: no delta in standalone floor/net.

**Probe first (already written, `.tmp/6426-repro.mts`; re-run with `npx tsx`).** Confirm `restObj`/`restAll`/`restNoDefault`/`restKeys` flip to node's answers after step 1 while `declaredObj`/`spreadCopy`/`directObj` stay unchanged (anti-vacuity).

**Regression test `tests/issue-6426-linked-object-rest-source.test.ts`** — model on `tests/issue-5225-consumer-literal-seam.test.ts`: untyped `.js` two-file fixture, provider = classes only (a provider exporting untyped *functions* trips the "inferred/any package signatures" fallback to `bundled` when the entry has top-level statements — that is why a naive reduction never reaches `separate`; assert `result.linkPlan?.mode === "separate"`). Rows: rest-then-assign with an object / a function / a number value; `Object.keys(rest)` + `rest.x` inside the ctor; `Object.values`/`Object.entries` of a consumer-minted struct inside a provider method. Controls that pass on parent: direct `Object.assign(this, options)`, `{ ...o }` spread source, `this.x = options.x`. Three lanes (single `compile`, `compileMulti` one unit, `compileProject` separate) assert one shared `EXPECTED` table; fails on parent only in the linked lane.
Then delete `LINKED_RESIDUALS` in `tests/issue-5366-nullish-join-carrier.test.ts` and assert `EXPECTED` in its linked lane (acceptance 2).

**Dogfood.** The 17 upstream suites compile the package's OWN source as the root unit, so the consumer→provider rest seam is not expected to fire there: anchors (hono 259/324, redux 67/82, axios 208/231, …) expected flat; run the per-file A/B anyway and report it — a flat table is the acceptable result, any movement must be explained. Gates: `check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports` before commit.

## Dispatch

**Model: opus.** The defect is located to four one-line sites in `src/runtime.ts` with a known template (#5225), but the work needs a correct three-lane linked-package fixture (the fallback-to-bundled trap above) and a per-file dogfood A/B read honestly — medium, not mechanical.

## Resolution

**Fixed 2026-09-13** in `src/runtime.ts` (host runtime only, no codegen change),
PR on `issue-6426`. The plan's diagnosis was right and its four sites were the
right four; the probe confirmed it before any edit and added one row it did not
predict.

**Mechanism.** Four host helpers read a WasmGC struct in two steps: field NAMES
from `_getStructFieldNames`, then each VALUE from `exports["__sget_<key>"]`.
Since #5225 the name step routes through `_decoderExportsFor`, so it answers
with the struct OWNER's decoder — but the value step still used the READER's
own exports. A `__sget_<key>` getter is module-global by field NAME and does not
trap on a foreign struct type: it `ref.test`-misses and returns its miss default.
So when a consumer mints an options bag and a linked provider does
`const { strict, ...rest } = options; Object.assign(this, rest)`, every key
survives and every value is lost — `null` for references, `0` for numbers.
`typeof null === "object"` is the whole reason the issue's function row looked
like a different defect from its object row; both are the same lost value.

The fix is one line at each of the four sites — `_decoderExportsFor(obj,
callbackState?.getExports())`, exactly the L12569 template — in
`__extern_rest_object`, `__object_values`, `__object_entries` and the tuple arm
of `__extern_slice`. `__object_keys` is names-only and was already correct;
nothing on the write side moved. The diff is 4 changed lines and **zero net
lines**: `src/runtime.ts` sits exactly at the #4401 ceiling (19735), so the
mechanism is written up here and in the test header rather than inline, and the
sites carry the repo's existing `// (#5225/#6426)` marker.

**Probe (`.tmp/6426-repro.mts`, `linkPlan.mode === "separate"`), base → fix.**
6 of 9 rows wrong on base, 0 after; the 3 controls never moved.

| row | base | fix | node |
| --- | --- | --- | --- |
| `restObj` (object through `...rest`) | `"null"` | `"R"` | `"R"` |
| `restFn` (function through `...rest`) | `"object"` | `"function"` | `"function"` |
| `restNum` (number through `...rest`) | `"0"` | `"7"` | `"7"` |
| `restKeys` (`Object.keys(rest)` + `rest.router`) | `"router\|no"` | `"router\|has"` | `"router\|has"` |
| `Object.values` of a consumer struct in the provider | `"undefined,undefined"` | `"number,string"` | `"number,string"` |
| `Object.entries` of same | `"a:undefined,b:undefined"` | `"a:number,b:string"` | `"a:number,b:string"` |
| control: direct `Object.assign(this, options)` | `"R"` | `"R"` | `"R"` |
| control: `{ ...options }` spread source | `"R"` | `"R"` | `"R"` |
| control: `this.router = options.router` | `"R"` | `"R"` | `"R"` |

The number row (`0`, not `undefined`) is the sharpest confirmation of the
mechanism: that is a `ref.test`-miss default, not a missing key.

**Regression test** `tests/issue-6426-linked-object-rest-source.test.ts`, 12 rows
x 3 lanes, one shared `EXPECTED` table:

- parent: single 0 wrong / one-unit multi 0 / separately-linked **6** = 6
- fix: 0 / 0 / 0 = 0

The 6 are `restObj`, `restFn`, `restNum`, `restKeys`, `restValues`,
`restEntries`. The other 6 rows are anti-vacuity controls that already passed on
the parent (direct assign, spread source, plain field store, `Object.keys`,
rest-with-an-excluded-key, empty bag), and the linked lane additionally asserts
that all 6 regressed rows are actually present in that module's exports.

**Acceptance 2** — `LINKED_RESIDUALS` is deleted from
`tests/issue-5366-nullish-join-carrier.test.ts` and its linked lane now asserts
the shared `EXPECTED` table; all three lanes of that file pass.

**Dogfood A/B** — base vs fix at one HEAD over all 17 upstream suites, results
in the PR body. Flat, as the plan predicted: these suites compile the package's
own source as the root unit, so the consumer→provider rest seam never fires.

**Residual.** `tests/issue-2131.test.ts` fails 6/7 on `upstream/main`
`3e92241ecc` and fails identically with this change — pre-existing, untouched,
not this issue's.
