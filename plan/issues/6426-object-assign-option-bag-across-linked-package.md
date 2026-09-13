---
id: 6426
title: "`Object.assign(this, options)` in a base class drops the value when the class lives in a separately-linked package"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
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
