---
id: 4436
title: "ES5 standalone: `length` as an own property of a function instance + §15.1.5 ExpectedArgumentCount"
status: in-progress
assignee: ttraenkler/claude-es5-standalone
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-objects, property-descriptors, own-properties
goal: standalone-gap
related: [2896, 3017, 3468, 4010, 4098, 4194, 4241, 4390]
umbrella: 2860
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #4436 — Function-instance own properties (`function-object-semantics` residual)

Residual of the ES5-standalone `function-object-semantics` bucket after #2896
(builtin function-object metadata) and #4390 (global function properties), both
`done`. Those two moved **builtin** function values and the **realm object**;
neither touched a **user** function instance, which is what the remaining
failures are about.

## Bucket map (measured 2026-08-15)

Source: `.test262-cache/test262-standalone-current.jsonl` (48,735 entries,
18,029 non-pass) plus a 25-file driver run at base `b5159d3`.

### Corpus-wide, by failure message

| bucket                                          | count | in scope |
| ----------------------------------------------- | ----: | -------- |
| `name should be an own property`                |    74 | partial  |
| `length should be an own property`              |    32 | **yes**  |
| `<other> should be an own property`             |   399 | no — 266 are `language/{statements,expressions}/class` (class-field/method descriptors, a different stratum) |
| `prototype should be an own property`           |     8 | no       |
| `f.hasOwnProperty('length')` (Function/length/*) |     7 | no — `new Function(...)`, eval lane |
| `Expected obj[length] NOT to be writable`       |     4 | no — same eval lane |

### The 25-file driver sample, before → after

| bucket                                                        | before | after | note |
| ------------------------------------------------------------- | -----: | ----: | ---- |
| `length should be an own property`                            |     12 |     0 | **cause removed** |
| `length descriptor value should be 0` (new, narrower message) |      0 |     9 | residual R2 — one step away |
| `name should be an own property`                              |      3 |     3 | residual R1 |
| passing                                                       |      6 |     8 | +2 flips |
| unrelated fails (proto chain, `arguments.callee`, TypeError)  |      4 |     4 | untouched |

The nine `-dflt` files did **not** flip, but their failure moved from "the
property does not exist" to "the property exists, is configurable, is
non-writable, is non-enumerable, and its value is N instead of 0". Every step
of `verifyProperty` now passes except the value comparison — see R2.

## Root causes

Two independent defects, both confirmed by direct probe, not inferred.

### C1 — the reflective surface did not know function instances have `length`

`f.length` folded to a constant for a typed receiver, but every **reflective**
surface — the one `propertyHelper.js` actually uses, because its receiver and
key are runtime parameters — said the property was absent:

| read on `function f(a,b){}` (standalone) | before | spec |
| ----------------------------------------- | ------ | ---- |
| `f.length` (static fold)                 | 2      | 2    |
| `f["length"]` (dynamic key)              | **0**  | 2    |
| `f.hasOwnProperty("length")`             | false  | true |
| `Object.getOwnPropertyDescriptor(f,…)`   | undef  | desc |
| `Object.getOwnPropertyNames(f)` ∋ length | false  | true |

The dynamic `0` was deliberate: `dyn-read.ts`'s closure arm returned a flat
`box_number(0)` for any closure `__builtinfn_get_meta` declined, commented
*"arity not statically tracked"*. It **is** tracked — every struct in the
funcref-wrapper hierarchy carries the declared formal count in the `$arity`
header slot (#3673).

### C2 — `ExpectedArgumentCount` was computed as a FILTER, not a PREFIX

`property-access-dispatch.ts` counted parameters with

```js
sig.parameters.filter((p) => !decl.dotDotDotToken && !decl.questionToken && !decl.initializer).length
```

justified by *"TS forbids required-after-optional, so filtering is equivalent to
iterating until the first one."* That premise does not hold for the JavaScript
this compiler accepts (`allowJs: true`, and every Test262 file):

| source                     | filter | §15.1.5 |
| -------------------------- | -----: | ------: |
| `function f(x = 42, y) {}` |  **1** |   **0** |
| `function f(x, y=4, z) {}` |  **2** |   **1** |

§15.1.5 stops at the first parameter that HasInitializer; parameters to its
right never count, **even when they are themselves required**. These are exactly
the `f2`/`f4` cases of `function/length-dflt.js`.

## What shipped

- **`src/codegen/function-expected-argument-count.ts`** (new) — §15.1.5 as a
  prefix walk, stated once so the static fold and any future runtime carrier
  cannot disagree about one observable value. Wired into the `<fn>.length` fold.
- **`src/codegen/function-instance-props.ts`** (new) — a **generic closure arm**
  appended to the three #2896 helpers every reflective surface already funnels
  through, so `hasOwnProperty` / `getOwnPropertyDescriptor` /
  `getOwnPropertyNames` / `delete` / the non-writable `__extern_set` refusal /
  the dynamic `fn[key]` read all move together and cannot disagree:
  - `__builtinfn_get_meta(fn,"length")` → `box_number($arity)`
  - `__builtinfn_delete(fn,"length")` → #4098 self-referential bag tombstone
  - `__builtinfn_push_ownnames(fn,vec)` → push `"length"`
  - `__builtinfn_gopd` derives `{writable:false, enumerable:false,
    configurable:true}` from `get_meta` + `FLAG_CONFIGURABLE` — §10.2.4 by
    construction, not by a second spelling of the flags.

### Three things that were load-bearing and are easy to get wrong

1. **Ordering.** `fillFunctionInstanceProps` runs *before* `fillBuiltinFnMeta`;
   both splice at body index 0, so the builtin arms end up in **front**. A
   #2896 meta struct is itself a funcref-wrapper-root descendant, so the generic
   `ref.test` matches it too — the builtin arms always `return` (including the
   deleted case), which is what stops a raw `$arity` shadowing a builtin's spec
   arity. Verified by control: 51/51 `built-ins/**/{length,name,prop-desc}.js`
   still pass.
2. **Deletability ships with visibility (#4010's ordering law).**
   `propertyHelper`'s `isConfigurable` is `delete obj[name]; return
   !hasOwnProperty(obj,name)`, so a visible-but-undeletable `length` fails every
   `verifyProperty` naming `configurable: true` — i.e. all of them. #4055 v1
   ignored this and the queue parked it at **-684**. The delete arm is in the
   same change.
3. **`push_ownnames` must PUSH AND FALL THROUGH, not return 1.** Its caller
   reads a `1` as "this receiver's own names are complete" and returns the
   vector, skipping the `bagKeysIf` carrier-bag key source. Correct for a
   builtin, wrong for a user closure, which also has #3468 expandos — the first
   cut dropped `p` from `getOwnPropertyNames(f)` after `f.p = 12`. Caught by
   `issue-4010.test.ts`, not by the new tests; fixed and now commented at the
   site.

## Verification

- **Target sample** (25 files, `--target standalone`, real runner): **6 → 8
  pass, 0 regressions**; the 12-file "length should be an own property" cause is
  gone.
- **Controls, 122 files, 122/122 pass**: 71 currently-passing files sampled by
  stride from `language/{statements,expressions}/{function,arrow-function,generators,class}`
  ∪ `built-ins/Function` ∪ `Object/{getOwnPropertyDescriptor,getOwnPropertyNames,keys,defineProperty}`
  (pool 9,458), plus 51 sampled from `built-ins/**/{length,name,prop-desc}.js`
  (pool 952) specifically to catch builtin-metadata shadowing.
- **Vitest**: `tests/issue-4436.test.ts` new, 23/23. `issue-2896`,
  `issue-3468-closure-own-props`, `issue-4010`, `issue-4194-instance-expando`,
  `issue-4241-carrier-bag-slot`, `issue-4098-error-expando`,
  `es5-standalone-function-semantics`, `es5-standalone-arguments-callee` all
  green.
- **Pre-existing, NOT caused by this change**:
  `tests/issue-3017-function-poison-pill.test.ts` fails 4/16 — identical count
  and identical tests on base `b5159d3` (A/B'd with file-copy revert). #3017 is
  in-progress in another lane; not touched here.
- **Gates**: `typecheck`, `check:oracle-ratchet` (+0/+0),
  `check:stack-balance`, `check:ir-fallbacks` all OK. `check:loc-budget` /
  `check:func-budget` need the allowances in this file's frontmatter — the
  growth is 8 lines in `index.ts` and 2 in `object-runtime.ts`, entirely the
  reserve/fill wiring a new subsystem module requires; all new logic is in the
  two new modules.

### One test expectation was updated, deliberately

`issue-3468-closure-own-props.test.ts` — *"does not let a custom own property
shadow the builtin metadata path"* asserted `(g as any).length === 0` for a
two-parameter arrow. The `0` was the flat `box_number(0)` defect, not the
invariant under test (which is "writing a custom property must not disturb
`.length`"). Updated to `2`, with the reasoning recorded at the site. Pinning
`0` would have pinned the bug.

## Residuals, with owners

| id | residual | why it is not fixed here | owner |
| -- | -------- | ------------------------ | ----- |
| **R1** | `name` is not an own property of a user closure (`hasOwnProperty("name")` false; the static fold answers). 74 corpus files, though most also need class/async/destructuring work. | `name` has no runtime carrier on a user closure. Adding one needs either a new closure-header field (changes gc-mode bytes — #2896's standing constraint) or a **per-function meta subtype**, which is the real design: generalize `ensureBuiltinFnMetaType` to append `bfnstate`/`bfnid` after the base's OWN fields (the constructible wrapper has 4, capture subtypes have 3+N, so the hardcoded `BFN_STATE_FIELD_IDX`/`BFN_ID_FIELD_IDX` must become per-entry indices in `ctx.builtinFnMetaByTypeIdx`). Then every existing arm answers `name` AND an exact `length` with no new runtime code. | **unowned — file as the next slice of #2860** |
| **R2** | The reflective `length` VALUE is `$arity` (declared formal count), not §15.1.5, for a function with a defaulted/optional parameter. 9 of 25 sample files stop here. Rest params are already correct (the allocation site pushes `max(0, params-1)`). | `$arity` cannot simply be re-pointed at the spec value: `closure-exports.ts` widens an under-applied dispatch to `max(n, $arity)` and would stop padding omitted arguments. Same per-function meta subtype as R1 fixes it — R1 and R2 are **one** slice. | **unowned — same slice as R1** |
| **R3** | `new function f(){ this.p = 1; }` (an INLINE function expression as the `new` callee) traps with a null dereference; `var F = function f(){…}; new F()` works. 3+ files (`S13.2.2_A16_T1/T2/T3`). | Separate construct-path defect, unrelated to own properties. Confirmed by probe. | **unowned — file separately** |
| **R4** | `f.constructor === Function`, `Function.hasOwnProperty("length")` need the `Function` intrinsic as a real object. | eval / `new Function` lane. | **out of scope by instruction** |
| **R5** | `f.hasOwnProperty("prototype")` false; `propertyIsEnumerable` on a closure expando returns false. | Adjacent own-property surfaces on function instances; same substrate, not measured into a bucket here. | **unowned** |
| **R6** | Accessor `.length` reads `NaN` (`gOPD(o,"s").set.length`). | Accessor-extraction defect, not a function-object one. | **unowned** |
| **R7** | `caller`/`arguments` poison pills. | #3017, in-progress in another lane. | **#3017** |
