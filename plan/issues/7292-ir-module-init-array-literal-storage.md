---
id: 7292
title: "IR module-init: script-var array-literal storage (`var values = [2, 1, 3]`)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7252, 7128, 2949, 7274]
assignee: "ttraenkler/lever-v" # handed over from c-lane-opus, 2026-11-07
---

# #7292 — IR module-init: script-var array-literal storage

## Problem

A script `var` holding an array literal (`var values = [2, 1, 3]`,
`var arr = []`, `var invalidStrings = ["…", …]`) is refused in module-init as
`vardecl-module-storage-unrepresentable`: the IR has no module-binding value
kind for legacy's array slot.

## Outcome (2026-11-07): measured, zero-legacy yield 0, no code yet

This admission alone moves **no** test262 file to zero legacy units. Per the
dispatch rule, this issue stops at measurement with a docs-only PR. The design
below is ready for when the co-blockers listed here fall.

**Ownership check.** #7128's S5 ("array-literal targets") is about arrays as
`Object.defineProperty` targets on the open-object carrier. #2949 is the
dynamic value representation. Neither covers a script `var`'s array slot.
#7274 has no issue file on main.

## Measurement (main `c03f7d0e`, 2026-11-07)

Census command:
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 npx tsx scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone --jobs 3 --files-json …`
(ir 1213 / both 8742 / legacy 4493 units; zero-legacy 32 files.)

### What legacy allocates

Probe: a script with `var values = [2, 1, 3]; var strs = ["a", "b"]; var
empty = []; var objs = [{}]`, compiled `--target standalone`:

| Initializer | `__mod_` slot |
| --- | --- |
| numeric literals | `(mut (ref null $__vec_f64))`, struct `{length i32, data (ref null $__arr_f64)}` |
| string literals | `(mut (ref null $__vec_ref_N))`, a vec of `$AnyString` refs |
| `[]`, `[{}]` | `(mut (ref null $__vec_externref))` |

The IR builds vec values through the same `getOrRegisterVecType` registry
(`src/ir/integration.ts`), so an f64 / string vec binding would share legacy's
struct by construction. `scriptVarHome` (`src/codegen/index.ts`) names no home
for any vec slot today. That is the one reason these bindings resolve as
`vardecl-module-storage-unrepresentable`.

### Population

There are **369** array-literal storage parts in **191** files, across module-init and
harness units. By element kind:

| Initializer | Parts |
| --- | ---: |
| `[]` (empty) | 80 |
| constructor lists `[Float64Array, …]` / `[Int32Array, …]` / `[Uint8Array, …]` (testTypedArray) | 108 |
| function lists `[makePassthrough, …]` (testTypedArray) | 51 |
| string literals | 46 |
| numeric literals | 41 |
| nested arrays | 25 |
| other (`[undefined, null, …]`, `Promise.reject(…)`, Temporal objects, arrows) | 18 |

### Sole-blocker files

Of the files whose only legacy unit is `<module-init>`, **76** carry an
array-literal storage part. Only **1** has no other statement-level refusal,
and **14** have exactly one more:

| Other refusals | Files | Next blocker |
| ---: | ---: | --- |
| 0 | 1 | `built-ins/Array/15.4.5.1-5-1.js`: `var a = []; a[4294967295] = …`. Index 2^32−1 is **not** an array index, so it is an ordinary property on the array object, which the IR vec has no slot for. |
| 1 | 4 | `for-init-var-kind` (`for (var i = 0; …)`): `exponentiation/applying-the-exp-operator_A18.js`, three intl402 Temporal `inLeapYear` files (Temporal calls are masked inside the loop) |
| 1 | 3 | `expr-array-method-not-lowerable`: `invalidStrings.forEach(callback)` (Temporal ×3) |
| 1 | 2 | nested-array `tests` read (`expr-module-storage-unrepresentable`) |
| 1 | 5 | `a.flat(Infinity)`, `Object` not in scope ×1, `Object.defineProperty(arr, …)` (#7128 S5), destructuring assignment from `vals`, `Intl` options |

Co-occurring refusal arms in the same module-inits, by parts:

| Arm | Parts | Note |
| --- | ---: | --- |
| `expr-ident-not-in-scope` | 511 | #7278 / #7267 |
| `vardecl-module-value-flow` | 466 | |
| `expr-array-method-not-lowerable` | 59 | |
| `expr-module-storage-unrepresentable` | 59 | reads of these same vars; they clear with the storage |
| `closure-return-type` | 52 | |
| `expr-object-define-property-target` | 23 | |
| `for-init-var-kind` | 11 | |

**Expected zero-legacy delta of the bounded admission: 0.**

## Implementation Plan (for when a co-blocker falls)

- **Module.** `src/ir/module-binding-value-kinds.ts` gets a
  `{ kind: "vec", element: "f64" | "string" }` value kind beside
  `class-instance` (#7252's precedent: one script `var`, sole home, every write
  certified).
- **Home.** `scriptVarHome` (`src/codegen/index.ts`) adds a `"vec"` home when
  the slot is `(ref null $__vec_f64)` or the native-string vec. The
  `externref` vec of `[]` / `[{}]` stays homeless until the empty literal's
  element kind is provable from every later write.
- **Certification, shared by selector and from-ast** (the #7252 every-write
  pattern):
  - every write to the var is an array literal whose elements are all f64
    literals (or all string literals), with no holes and no spread;
  - every use is one the IR vec already lowers: index read in bounds,
    `.length`, an index write, `push`;
  - holes `[,1]`, mixed kinds `[1, "a"]`, `length` writes, `delete a[i]`,
    non-index keys (`a[4294967295]`), aliasing through a second var, closure
    captures and reassignment to a non-array all refuse with named arms.
- **Storage.** `resolveModuleBindingGlobal` (`src/ir/integration.ts`) maps
  the kind to the vec's IR type and checks it against legacy's global, the way
  `class-instance` does.
- **Quality criterion.** One value kind and one certification, both reused
  from #7252's arm shape; no new import; gc byte-identical where unclaimed.

## When to pick this up

Once `for-init-var-kind` (`for (var i = …)` in module-init) or array-method
callbacks (`forEach(fn)`) are admitted, re-run the census above. The pair
rows (4 + 3 files) become this admission's yield.

## Lever V — as built (2026-11-07, `claude/7106-lever-v`)

Handed over from lane C (claim on #6583). Stacked on #7106 lever L2
(`claude/7106-lever-l2`, #7179), because it routes the new home through L2's
`reachableScriptVarHome` choke point. The "When to pick this up" condition
holds: with lever L (`for (var …)`) and #7176 (the `regexp-match` home for
`__executed`), the S15.10.2 `exec` family is blocked only by
`var __expected = ["…"]`.

### Census (2026-11-07)

A parse-only scan over the 9,174 ES5 files found 876 with a script `var`
initialized by an array literal. Element kinds: empty 372, string 321, number
138, other or mixed 108. Uses of the string/number ones: `.length` 571,
`x[expr]` 336, `x[literal]` 73, an expando write and read of `index` and
`input` 216 each (`__expected.index = 2`), `Object.defineProperty(x, …)` 84,
`hasOwnProperty` 45, index writes 3, `length` writes 12, other methods ~40.
On the overlay (#7176 + lever L + L2), 193 of the 199 S15.10.2 files are
blocked only by `vardecl-module-storage-unrepresentable` on `__expected`.

### What changed against the plan above

- **String vecs only.** A number vec stays refused: the IR's unproven f64
  element read answers `NaN` (the vec's out-of-bounds image), where JS — and
  legacy — answer `undefined` (`assert.sameValue(a[5], undefined)` was claimed
  and wrong in a probe). It needs an undefined-capable read first.
- **Expandos are in, index writes and `push` are out.** The census population
  writes and reads named properties on the array (216 files), never an index
  or `push`.

### Design

- **Home** (`src/codegen/index.ts`, `scriptVarHome`): `"vec"` when the slot is
  the native-string vec (`vecTypeMap` key `ref_<$AnyString>`, the key both
  legacy's array literal and the IR's `resolveVecForElementImpl` use).
  `reachableScriptVarHome` refuses it for a nested declaration.
- **Value kind** (`src/ir/module-binding-value-kinds.ts`):
  `{ kind: "vec", element: "string" }`, a struct handle beside
  `class-instance` (`isIrModuleStructValueKind`, renamed from
  `isIrModuleClassInstanceValueKind`): neither scalar nor extern-like.
- **Certification** (`src/ir/module-binding-vec.ts`, new, #7252's shape):
  - the initializer is the binding's only write anywhere in the source,
    every element a string literal, no hole, no spread, no dynamic scope;
  - every use follows the declaration in module-init (the shared
    `scriptVarUseFollowsDeclaration`) and is an element read, `.length`, or a
    named property read or plain `=` write. Every other use (passing the
    array, a method call, `length` or index writes, `delete`, a read in a
    function) refuses at its site (`script-var-use-site`).
  - An element store into any module binding now asks its resolver
    (`body-elemstore-module-storage-unrepresentable`), so `e[0] = …` refuses
    at selection instead of failing to lower.
- **Storage** (`src/ir/integration.ts`, `resolveModuleBindingGlobal`): the IR
  `vec<string>` (non-null: every read follows the write, as for a class
  instance) against the struct `resolveVecForElementImpl` registers for
  `$AnyString`, which is legacy's.
- **Lowering** (`src/ir/from-ast.ts`), for a script-var vec only
  (`isScriptVarVec`: the receiver reads its module slot), all through the
  existing dynamic carrier, as legacy reads these. A function-local vec keeps
  main's vec-only paths: the first cut applied the dynamic read to every vec,
  and the equivalence gate caught `typeof a[0]` on a push-built function-local
  string vec (#7166's sweep) answering differently.
  - a named property read on a vec (`e.index`): the boxed vec through
    `dyn.member_get`;
  - an unproven native-string element read (`e[i]` outside a counted loop):
    the boxed vec through `dyn.member_get`, which answers `undefined` out of
    bounds and for `0.5` / `-1` (it used to demote after the claim);
  - a script-var vec's named write (`e.index = 2`): `dyn.member_set` on the
    boxed vec through legacy's own store (`__extern_set`). The native strict
    store keeps no expando for a vec, and the certified array never escapes,
    so its named `[[Set]]` cannot fail.
- **Reuse:** the vec registry key, `resolveVecForElementImpl`, the dynamic
  reader/store and `boxToAny`, #7252's write/use certification pattern and
  `scriptVarUseFollowsDeclaration`, L2's home choke point.
- **Duplicates removed:** the two copies of "box the name, `dyn.member_get`"
  (`<dynamic>.p` and `<externref>.p`) and the indexed twin now share
  `dynamicNamedPropertyRead` / `dynamicIndexedRead`.

### Measured (2026-11-07, one niced worker)

Base: lever L2 + main (`4629e3db39`) with #7176 merged locally; head: the same
with lever V. Neither overlay is pushed. Population: the 876 array-literal
files plus 200 random ES5 files (995 compile on both sides; gc on the 200
sample files plus every changed file, 362).

| measure | standalone | gc |
| --- | --- | --- |
| IR-only files | 14 → 191 (**+177**, 176 of them S15.10.2) | 14 → 191 (+177) |
| IR-only files lost / units newly legacy / new post-claim errors | 0 / 0 / 0 | 0 / 0 / 0 |
| binaries changed | 177, each a newly claimed `<module-init>` | 177 |
| byte-identical | 818 | 185 |
| pass → fail on the 177 | 0 (177/177 pass on both) | 0 |
| playground (26 binaries) | identical | identical |

### Review round 1 (PR #7186, 2026-11-07)

Four findings, all fixed in `0de7df41cc`:

- **Inherited names.** `a.constructor === Array` read `false` and
  `a.join === undefined` read `true`: the dynamic reader sees only own
  properties of the boxed vec. `vecUseSupported` now admits a named read only
  for a name an earlier top-level `<binding>.<name> = …` statement wrote (an own
  expando); every other name, inherited ones included, refuses at its site.
- **Claim-then-demote shapes.** `a["01"]`, `a["-0"]`, `a["length"]`,
  `a["foo"]`, `a[undefined]`, `a[k]` with a string `k`, `a[null]`,
  `a[0].length`, `a[9] === undefined`, `a.foo + 1`, `a.foo + a.bar` were
  claimed, then demoted or answered wrongly. An element read now needs a
  checker-number key, and an element or expando read is admitted only as a
  call argument (the IR boxes whatever it lowers to), so an `undefined` answer
  never reaches a typed consumer. All refuse at select; each is a test row on
  both lanes.
- **Duplication.** The "every write of this script var" scan the vec and
  class-instance homes each carried is one cached `scriptVarWrites` in
  `module-binding-class-instance.ts`; both certify their own predicate over it.
- **Comment** at the vec named-write arm shrunk to a pointer to
  `vecUseSupported`.

Re-measured after the fixes (base: lever L2 + main `636331310e` with #7176
merged locally; head: lever V `ac75acf28f`, same overlay; neither overlay is
pushed). Population, rebuilt after the container reset: the 576 test262 files
with a top-level `var` initialized by a non-empty all-string array literal,
plus a seeded random 200 from all of test262 (775 distinct), compiled as the
runner does (`assembleOriginalHarness` + `originalHarnessCompileOptions`).

| measure | standalone | gc |
| --- | --- | --- |
| IR-only files | 5 → 182 (**+177**, 176 S15.10.2 + one annexB RegExp) | 4 → 181 (+177) |
| IR-only files lost / new post-claim errors | 0 / 0 | 0 / 0 |
| module-init newly claimed / newly refused | 177 / 0 | 177 / 0 |
| binaries changed | 177, each a newly claimed `<module-init>` | 177 |
| byte-identical | 597 of the other 598 | 597 of 598 |
| pass → fail on the changed files | 0 (177/177 pass on both sides) | 0 |
| random 200 | 0 changes | 0 changes |

The one other differing binary (`staging/sm/String/match-GetMethod.js`, still
legacy, a skipped staging file) is a measurement artifact: compiled alone it is
byte-identical on both sides; the census resumed the base run in a fresh
process after a restart, and that file's binary depends on what the same
process compiled before it.

### Review round 2 (PR #7186, 2026-11-08)

Round 1's call-argument whitelist and checker-number key re-implemented the
selector's own checks, and got both wrong: `var k = 0; k = "01"; a[k]` (the key
is the dynamic carrier in the IR, a number to the checker) and
`function g(s) { return s + "!"; } g(a[1])` (a typed parameter takes no
carrier) were claimed and then withdrawn. Fixed in `002d2790e1`:

- **The selector types the read.** `provenIrFamily` answers `dynamic` for a
  script-var vec's element read and expando read (`isScriptVarVecCarrierRead`),
  so the binary-operator family judge sees the carrier. `phase1ScriptVarVecReadAdmitted`
  admits one only where from-ast lowers it: the dynamic reader is buildable, an
  element key's IR family is `number`, and the consumer takes the carrier —
  `carrierValueConsumed` (renamed from `carrierAdditionConsumed`, now shared
  with the carrier `+`), a function object's member call (`assert.sameValue`
  boxes every argument), or a top-level function's parameter resolved dynamic.
  The resolver keeps only the use shapes (`vecUseSupported`): no whitelist and
  no raw `checker.getTypeAtLocation`.
- **from-ast lowers every script-var vec element read through the dynamic
  reader**, before the index is lowered (so it is lowered once), matching the
  selector's type. `a[9] === undefined` now claims: the undefined compare tests
  a carrier operand's tag before it refuses an unproven typed read.
- **Shared module.** `scriptVarWrites` and `scriptVarUseFollowsDeclaration` live
  in `module-binding-script-var.ts`; the class-instance, vec and native-buffer
  certifiers import them from there. The class-instance verdict keeps its
  per-declaration cache. In `module-bindings.ts` the class-instance and vec
  use-site checks are one `certifiedUse` test.
- **Rows**: the four dynamic keys (`"01"`, `"1"`, `" 1"`, `"-0"`) and the
  string parameter refuse at select; `=== undefined`, `typeof a[i]` and an
  expando passed to a dynamic parameter claim and run.

Re-measured after round 2 (base: lever L2 + main `6d723c6949` with #7176
merged locally; head: lever V after round 2, same overlay; neither pushed), on
the 177 files round 1 claimed plus the seeded random 200:

| measure | standalone | gc |
| --- | --- | --- |
| IR-only files, 177 set | 0 → 177 (**+177**) | 0 → 177 (+177) |
| IR-only files lost / new post-claim errors | 0 / 0 | 0 / 0 |
| binaries changed | 177, each a newly claimed `<module-init>` | 177 |
| random 200 | 0 changes (5 / 4 IR-only both sides) | 0 changes |
| pass → fail on the 177 | 0 (177/177 pass on both sides) | 0 |

### Review round 3 (PR #7186, 2026-11-08)

Two items, fixed in `ff177c8963`:

- **Refusal reason.** Round 2 lowered the operand of `x === undefined` before
  the unproven-read check, so a function-local string vec's `a[k] === undefined`
  refused as `element-access-unsupported` instead of `nullish-value-unsupported`
  (same bytes, another fallback bucket). The check runs first again and exempts
  only a script-var vec read (`isScriptVarVec`, which now also requires the
  slot's IR type to be a vec); probes of function-local string and number vecs
  report `nullish-value-unsupported` as on main (round 2 reported
  `element-access-unsupported` for the string one). A test row pins it on both
  lanes.
- **No grant.** The resolver's per-home dispatch for the write-certified homes
  is `module-binding-certified-homes.ts` (`certifiedScriptVarKind`,
  `certifiedScriptVarWriteMatches`, `certifiedScriptVarUse`), above the
  certifiers, which import the shared facts from `module-binding-script-var.ts`
  (the dispatcher cannot live there: the certifiers import that module, so it
  would close a cycle). `module-bindings.ts` imports only the dispatcher, and
  the `loc-budget-allow` grant is gone.

Byte identity against round 2 (`c4ad393e73`; both sides with #7176
`claude/7106-lever-r2` merged locally, not pushed), compiled as the runner
does (`assembleOriginalHarness` + `originalHarnessCompileOptions`, primary and
strict-rerun variants), one niced process per side: the 576 test262 files with
a top-level `var` initialized by a non-empty all-string array literal, plus a
seeded random 200 ES5 files (770 distinct, 1,686 compiles per side).

| measure | standalone | gc |
| --- | --- | --- |
| binaries / compile errors / IR outcomes | 843 identical, 0 changed | 843 identical, 0 changed |
| `<module-init>` claimed in the 576 set | 177 → 177 (176 S15.10.2 + 1 annexB) | 177 → 177 |
| post-claim errors in a claimed `<module-init>` | 0 | 0 |

### Follow-ups

- Number vecs: an undefined-capable unproven f64 read, then the same home.
- Uses the census saw and this refuses: `Object.defineProperty(arr, …)`
  (#7128 S5), `hasOwnProperty`, `forEach` / `filter` callbacks, passing the
  array to `assert.compareArray`.

