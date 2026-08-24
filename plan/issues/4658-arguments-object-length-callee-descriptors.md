---
id: 4658
loc-budget-allow:
  # `__vec_gopd`'s `length` descriptor synthesis lives here; the §10.4.4 answer
  # has to be decided at that exact site. +19 lines = the brand/tombstone
  # consults plus their rationale; the mechanism itself is a new leaf module
  # (`src/codegen/arguments-length-brand.ts`), 0 lines of it in any god-file.
  - src/codegen/vec-overlay.ts
  # `emitArgumentsVecBody` is the single construction site every arguments
  # object passes through — the brand cannot be minted anywhere else. +11 lines
  # = one gated call plus why the gate is `registerWithHost`.
  - src/codegen/statements/nested-declarations.ts
  # +2 lines: the `$Object.flags` bit table comment, recording 0x40 as taken.
  - src/codegen/object-runtime.ts
func-budget-allow:
  # Same +18 lines as the `vec-overlay.ts` allowance above, seen at function
  # granularity: `__vec_gopd`'s bodies are built inside this one closure (it
  # owns `missExtern`/`integrityBit`/`setKey`), so a consult that has to sit in
  # the `length` arm cannot be hoisted out without duplicating that scope.
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  # +9 lines: the `in` (`__extern_has`) and dynamic-read (`__extern_get`)
  # `length` arms are built inside this one closure. All four own-property
  # surfaces have to read the same tombstone — wiring only some of them is a
  # new incoherence, not a fix — and these two live nowhere else.
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
title: "ES5 standalone: arguments-object `length`/`callee` own-property descriptors — a NUMBER write to arguments.length sticks but a STRING write does not; gOPD reports wrong writable/configurable; typeof argObj.callee answers \"number\""
status: done
completed: 2026-08-24
assignee: ttraenkler/dev-4658
sprint: current
created: 2026-08-23
updated: 2026-08-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: arguments-object
goal: standalone-gap
related: [4491, 4515, 4032]
origin: "Narrowed by dev-4515 against dev-4491's MERGED wave-4 tree (2026-08-23), then handed to dev-4491, which DECLINED it as a distinct slice with its own risk surface rather than fold it into an unrelated parity fix. Filed by the lead so it has an owner. Both lanes' measurements are recorded below; neither is working it."
---

# #4658 — arguments-object `length` / `callee` descriptors

## Why this is its own issue, not #4491's element-freeze work

dev-4515 re-verified these four rows against dev-4491's **merged** wave-4 fix
(`Object.freeze` now visible to array/arguments ELEMENTS) and the residue is
**not** element freeze — it is the `length` and `callee` **own-property
descriptors** on the arguments object. dev-4491 declined to fold it in with the
reason worth preserving: folding a distinct slice into an unrelated fix "would
make both unmeasurable". Take it as its own before/after.

## Affected rows

```
language/arguments-object/10.6-13-a-1.js   typeof argObj.callee → "number", want "function"
language/arguments-object/10.6-6-2.js      length descriptor should be configurable
language/arguments-object/10.6-7-1.js      length descriptor should be configurable
language/arguments-object/S10.6_A5_T4.js   arguments object don't exists
```

## Measured symptoms (dev-4515, on the merged wave-4 tree)

1. **A NUMBER write to `arguments.length` sticks; a STRING write does not.**
   dev-4491 identifies this as the same **kind-incompatible-carrier** defect as
   its own `15.2.3.7-6-a-183` residual — a cross-type write to a slot whose
   carrier was resolved for the other kind.
2. `Object.getOwnPropertyDescriptor(argObj, "length")` reports the wrong
   `writable` / `configurable`.
3. `typeof argObj.callee` answers `"number"`.

## Lead's note on likely shared root (from dev-4491)

The `length` half **likely shares a root with dev-4491's
`heterogeneousWidenedModuleGlobalType` residual** — whoever takes this may get
two fixes for one investigation. Verify that before assuming it; it is a
pointer, not a measurement.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read fully
   before the first edit. Especially: methodology 1–7, the **contention trap**
   (re-run every apparent flip AND apparent regression SERIALLY before it goes
   in a report — a `compile_error: compilation timeout` is a measurement
   failure, not a status), the **pool-suite false green** (`skipped` is not
   `passed`; read counts, never exit codes), the stale `compiler-bundle.mjs`
   trap, the `test262/` symlink-farm + **GITLINK hazard**.
2. Re-verify all four rows live on current campaign HEAD first — dev-4491's
   wave-4 fixes are merged and may have moved them since the narrowing.
3. Start with symptom 1 (the cross-type write): it is the one with a named
   sibling defect (`-6-a-183`) and a named candidate shared root
   (`heterogeneousWidenedModuleGlobalType`). Establish whether the carrier is
   resolved per-slot or per-kind before designing the fix.
4. `callee` answering `"number"` smells like the same slot-carrier confusion
   one level out — measure whether it shares root 1 before treating it
   separately.
5. Absent-not-wrong: if a descriptor cannot be answered faithfully, decline the
   fold rather than answer wrongly.

## Status note for the merging lead

`in-review`, not `done`, and deliberately so: **3 of the 4 rows are fixed**
(`10.6-13-a-1`, `10.6-6-2`, `10.6-7-1`) and the 4th (`S10.6_A5_T4`) is
**declined with a measured reason** — see RESIDUAL 1. The acceptance criteria
named four rows, so whether a reasoned decline closes the issue is the lead's
call, not this lane's. Everything else in the bar is met: 1,075-row scoped sweep
on both arms from this lane's own runs, 3 flips, **0 regressions**, per-file
flip list, pins revert-verified on base.

## Root cause

Three defects, not one. All measured on campaign HEAD `74389b417`, standalone,
with `.tmp/run-one.mts` / probe files under `.tmp/probes*`.

### Root 1 — the vec companion value-seed is a CHAIN read (fixes `10.6-13-a-1`)

`buildBagValueSeed` (`src/codegen/vec-bag-seed.ts`, #4010 S1′) seeds the #3251
companion's pre-state before `__vec_dp_value` delegates, so that a define
carrying no `[[Value]]` preserves the existing one (§10.1.6.3). It sourced that
pre-state from **`__vec_prop_get`** — which is **not** a bag read. Since #4176
its miss tail consults the prototype-property companions
(`protoIndexRecvGetMissInstrs`), so for a key the bag does not hold it answers
with `Object.prototype`'s / `Array.prototype`'s value. The seed then installed
that INHERITED value as an OWN companion entry, with `SEED_FLAGS` (w/e/c all
true, value present).

The seed lands **before** the incoming define is applied, and a define whose
flags specify neither a value nor any attribute is a no-op against an existing
entry — so the fabricated value SURVIVES. Measured, base sources:

```js
Object.defineProperty(Object.prototype, "zzz", { value: 7, writable: true, configurable: true });
var a = [1, 2];
Object.defineProperty(a, "zzz", { writable: false });
Object.getOwnPropertyDescriptor(a, "zzz")
//  vec receiver:  {value: 7,         writable:false, enumerable:true,  configurable:true}
//  plain object:  {value: undefined, writable:false, enumerable:false, configurable:false}   ← spec
```

`10.6-13-a-1` defines `Object.prototype.callee` FIRST, so #4243's callee seed
(`__defineProperty_value(args, "callee", <func>, 0x05)`) ran against a
pre-seeded entry holding the inherited `1` and became a no-op — `typeof
argObj.callee` answered `"number"`.

**This is NOT the kind-incompatible-carrier defect the issue's lead 1 pointed
at, and it does NOT share a root with the `length` half.** The pointer was worth
following; the discriminator that settled it (`.tmp/probes4/s5`): the same
program with `Object.prototype.callee = 1` written by plain ASSIGNMENT answers
`"function"` — correct. Only the `Object.defineProperty` spelling breaks it,
because only that spelling creates the proto-index companion entry
`__vec_prop_get`'s tail can find.

### Root 2 — `arguments` has no runtime brand (fixes `10.6-6-2`, `10.6-7-1`)

`arguments` shares the opaque `$Vec` representation with array literals, so
`__vec_gopd`'s `length` arm answered with §10.4.2's Array rules —
`configurable: false`, hard-coded. Right for `[1,2]`, wrong for an arguments
object, whose `length` is `{writable: true, enumerable: false, configurable:
true}` in BOTH CreateMappedArgumentsObject (§10.4.4 step 7) and
CreateUnmappedArgumentsObject (step 4). Measured: `{value: 0, writable: true,
enumerable: false, configurable: false}`.

`arguments-object-mop.ts` records why #4622 could not fix this: *"there is no
runtime brand to split them on"*, and it used a syntactic arm instead. A
syntactic arm cannot serve here — both rows hand the object to `verifyProperty`,
a harness FUNCTION, so the gOPD receiver is a dynamic value with no syntactic
connection to any `arguments` binding.

A `configurable: true` descriptor alone is also **not enough**, which is the
part that only shows up by running it: `propertyHelper.isConfigurable` decides
the attribute by `delete obj[name]` followed by `!hasOwnProperty(obj, name)`.
With the brand but no tombstone the delete answered `true` and `hasOwn` still
answered `true`, so both rows kept failing with the identical message.

### Root 3 — cross-type write to `arguments.length` — DECLINED (RESIDUAL 1)

## Fix

New leaf module **`src/codegen/arguments-length-brand.ts`**; the god-file
changes are call sites only.

1. **`vec-bag-seed.ts`** — gate the value seed on `__carrier_bag_has(vec, key)`,
   the own-only, tombstone-filtered, LOOKUP-not-ENSURE predicate for this
   substrate. Strictly NARROWS which keys are seeded, so #4010's bag→companion
   seam keeps every case it was written for (pinned).
2. **`OBJ_FLAG_ARGUMENTS = 0x40`** on the #3251 overlay COMPANION's
   `$Object.flags` — the same internal-slot channel as `OBJ_FLAG_RAWJSON`
   (#3176) and the #4120 callable/ctor brand; `object-runtime.ts`'s flag table
   listed `0x40+` as free. Set by a reserve-then-fill `__args_brand_mark` stub
   emitted from `emitArgumentsVecBody` (the one construction site all three
   arguments paths share).
   - **Gated on the same `shouldRegisterArgumentsWithHost` proof #4578 uses.**
     `__vec_overlay_ensure` APPENDS to a linearly scanned table, so branding
     every arguments object on every call would grow it unboundedly (the hazard
     `ensureOverlayCore` documents for per-exec RegExp match results). Where the
     proof says "observable", `arguments-callee.ts` has already created that
     companion; where it says "not observable", nothing is marked and no
     companion is created.
3. **`__vec_gopd` length arm** — `configurable` = brand AND NOT
   (sealed|frozen), so §7.3.14 SetIntegrityLevel still wins (pinned).
4. **`OBJ_FLAG_ARGS_LENGTH_ABSENT = 0x80`** tombstone. The vec has no per-key
   storage for `length` (`__vec_prop_set` refuses the key outright so the real
   vec length can never be shadowed), so a successful delete is recorded as a
   bit: set by a `__delete_property` arm placed AFTER the `configurable` gate
   (a sealed/frozen arguments object still refuses), read by **all four**
   own-property surfaces — `__hasOwnProperty` / `__object_hasOwn`,
   `__extern_has` (`in`), `__vec_gopd`, and `__extern_get`'s dynamic `length`
   read — and cleared by a store to `length`.
   - Wiring only some of them was tried and rejected mid-change: a delete that
     `hasOwnProperty` can see but `in` cannot is a NEW incoherence, not a fix.
     The compile-time `.length` fold on a vec-typed receiver is the one surface
     that cannot follow (RESIDUAL 4 below).

Every arm is `[]` when no arguments object was ever branded, so an Array-only
module is byte-identical.

### Hazard worth carrying forward

Assigning ONE `{name, type}` locals array to all four filled stubs made the
finalize type-remap rewrite that single `ValType` object once **per function**
while the `struct.get` immediates (built fresh) were remapped once each. The
module came out with `(local $comp (ref null 153))` beside `struct.get 159 4`
and V8 rejected it — attributed to `testcase`, because the stub had been
INLINED there, which is why the error named a user function that contains no
such code. `reference_shared_instr_object_dce_double_remap` governs local TYPE
objects too, not only `Instr`s.

## Acceptance

Scoped standalone sweep over `language/arguments-object` before AND after from
your own runs, with apparent flips/regressions re-verified serially; per-file
flip list; **zero regressions**. `tests/issue-4658.test.ts` pinning each fixed
shape — the pin must EXECUTE the write and read it back, and the descriptor
pins must call `gOPD` and assert the specific attributes — verified failing on
base by file-copy revert; `it.fails` pins for measured residuals with owners.
Record `## Root cause` / `## Fix` / `## Test Results` / `## Residuals` here.

## Test Results

All numbers below come from runs executed by this issue's owner on
`dev-4658-arguments-descriptors`, base `74389b417`, standalone lane, via
`.tmp/sweep-list.mts` / `.tmp/run-one.mts`. Arms were swapped with a file-copy
revert (`.tmp/ab.sh`), and `git diff --stat 74389b417 -- src/` was read
immediately before each arm — EMPTY for the base arm, exactly 6 files for the
branch arm — so neither arm measured a hybrid tree.

### Scoped standalone sweep — 1,075 rows, both arms

| arm | pass | fail | compile_error | driver_error |
| --- | --- | --- | --- | --- |
| base `74389b417` | 995 | 74 | 5 | 1 |
| this branch | **999** | 71 | 5 | 0 |

**Flips: 3. Regressions: 0. Other status changes: 0.**

```
language/arguments-object/10.6-13-a-1.js   fail -> pass   (was: typeof argObj.callee === "number")
language/arguments-object/10.6-6-2.js      fail -> pass   (was: length descriptor should be configurable)
language/arguments-object/10.6-7-1.js      fail -> pass   (was: length descriptor should be configurable)
```

A FOURTH apparent flip was rejected on serial re-run:
`built-ins/Object/seal/seal-asyncfunction.js` read `driver_error` on the base
arm with the symlink-farm `ENOENT`, and **passes on the base arm when run
serially** — an infrastructure failure, not a status. The three real flips were
re-verified serially on both arms after the sweep.

The 5 `compile_error` rows are identical on both arms: the same five
`language/arguments-object/gen-func-decl-args-trailing-comma-*` files hitting
the pre-existing "native generator lowering currently supports only sequential
numeric yields" limit.

### Sweep scope, and what was dropped

Sized from what the diff can reach — every consult site is `[]` unless a module
brands an arguments object, and root 1's gate can only change an answer where
`__vec_prop_get`'s prototype-companion tail had a value to fabricate:

| directory | rows | why it is in scope |
| --- | --- | --- |
| `language/arguments-object` | 263 | the issue's own rows |
| `built-ins/Object/defineProperty` (array/arguments receivers) | 325 | root 1's `__vec_dp_value` seed |
| `built-ins/Object/getOwnPropertyDescriptor` | 310 | root 2's `__vec_gopd` |
| `built-ins/Object/seal` + `freeze` | 147 | the §7.3.14 AND on the `configurable` bit |
| `built-ins/Array/length` | 30 | the `__extern_set` ArraySetLength arm + revive |

**Dropped, and why:** the rest of `built-ins/Object` (`keys`, `create`,
`assign`, `getPrototypeOf`, …) and all of `built-ins/Array/prototype`. Nothing
in the diff reaches them — no arguments object is constructed there, and the vec
arms are inert without a brand — and the merge queue re-validates the whole
corpus on the merged state anyway. The `defineProperty` cut to 325 is by
RECEIVER (`new Array` / `= []` / `= [<digit>` / `arguments`); the remaining
files define on plain objects, which root 1's gate cannot reach.

### Pins — `tests/issue-4658.test.ts`

`Tests 21 passed (21)` on this branch (`executed == total`; the file line
carries no `skipped`). On base, by file-copy revert: `Tests 7 failed | 12
passed (19)` at the time of the check — **exactly the seven cases that guard a
fix**; the twelve controls and the residual `it.fails` pins hold on both arms.
(The file has since grown to 21 with RESIDUAL 4 and its control, both measured
on both arms.)

The seven that fail on base:

```
root 1 > vec receiver: the new own property has value undefined, not the prototype's 7
root 2 > gOPD(arguments, 'length') reports writable+configurable, non-enumerable
root 2 > the same holds through a helper — the receiver is a dynamic value there
root 2 > delete arguments.length succeeds AND hasOwnProperty then answers false
root 2 > gOPD agrees with hasOwnProperty after the delete
root 2 > `in` and the DYNAMIC read agree with hasOwnProperty after the delete
root 2 > a later numeric write to length revives the property
```

### Scoped equivalence — per-file loop (the suite OOMs in one invocation)

12 files covering arguments objects, `Object.defineProperty` (4 files),
`delete`, `hasOwnProperty`, `Object.keys`, array push/pop and
define-property TypeErrors. **69 passed, 1 failed** — and that failure is
PRE-EXISTING, measured identical on both arms:
`tests/equivalence/arguments-nested-and-loops.test.ts` >
`for-loop with function declaration in body`, `expected 30 to be 33`,
`Tests 1 failed | 45 passed (46)` on base and on this branch alike.

## Residuals

All five measured on BOTH arms by the owner of this issue; none are fixed here,
and R1–R4 each carry an `it.fails` pin plus a positive control in
`tests/issue-4658.test.ts` so a later fix has something that flips.

### RESIDUAL 1 — a STRING write to `arguments.length` does not stick (the remaining half of `S10.6_A5_T4`)

Owner: the `[[ParameterMap]]` / descriptor-sidecar arguments representation
#3251 and #4622 both defer to.

§10.4.4 makes `length` an ORDINARY data property, so `arguments.length = "abc"`
must stick and read back as the string. It does not, and the two halves of why
are independent:

- the WRITE goes through `__extern_set`'s vec `length` arm, which is
  ArraySetLength-lite — a non-numeric value is a silent no-op (a NUMBER write
  DOES stick, which is the control; it sticks by RESIZING the vec, which is its
  own §10.4.4 divergence);
- a `.length` READ on a vec-typed receiver folds at compile time to a
  `struct.get` on the vec's length FIELD, so there is nowhere for a non-numeric
  length to live.

**Deliberately not half-fixed.** Storing the string in the #3537 bag and
teaching only the DYNAMIC read to find it would leave the static fold answering
the old numeric value — two surfaces disagreeing about the same property, which
is worse than the current coherent miss (absent-not-wrong).

### RESIDUAL 2 — `Array.isArray(arguments)` answers `true`

Owner: unclaimed. An arguments object is an ordinary Object, not an Array exotic
object, so this must be `false`. It answers `true` because the two share the
`$Vec` representation and `__is_vec` is the predicate behind `Array.isArray`.

**Load-bearing for whoever fixes it, and for reading this issue's own result:**
`propertyHelper.isWritable` branches on `__isArray(obj) && name === "length"` to
pick a NUMERIC probe value instead of the string `"unlikelyValue"`. That branch
is the only reason `10.6-6-2`'s `writable` check passes today. Fixing
`Array.isArray` sends that check down the string path, where it needs
RESIDUAL 1 first — so these two must land together or `10.6-6-2` regresses.

### RESIDUAL 3 — `arr["length"]` answers `arr[0]`

Owner: unclaimed. Found while building this change's Array controls;
**measured IDENTICAL on base `74389b417` and on this branch** (`RESULT: 1111`
from `.tmp/repro/arrget2.js` on both arms), so it is not caused here.

On an Array receiver the BRACKET form numeric-coerces the key
(`ToNumber("length")` is `NaN`, `trunc_sat` takes it to `0`) and the index lane
consumes it before any named-key lane sees it — the exact shape `vec-props.ts`
warns about in its `VEC_PROP_GET` header ("that is right for an ordinary index
and wrong for a §10.4.2.2 non-index key"). All three spellings answer `1` for
`[1, 2]`: a top-level `a["length"]`, a generic `get(o, n)` helper, and an inline
IIFE. The DOT form `a.length` is correct, which is why this hides.

### RESIDUAL 4 — after `delete args.length`, the compile-time `.length` fold still reads the field

Owner: same as RESIDUAL 1 (one representation, one fix).

All four *dynamic* own-property surfaces now agree that the property is gone
(`hasOwnProperty`, `in`, `gOPD`, `__extern_get`). A syntactic `arguments.length`
inside the same function still folds to `struct.get` and answers the live vec
length. Closing it needs the same representation change as RESIDUAL 1, not
another consult site.

### RESIDUAL 5 — the SYNTACTIC `delete arguments.length` records no tombstone

Owner: #4622, which introduced that arm; **unchanged by this work** — measured
`RESULT: 11` on base `74389b417` and on this branch alike
(`.tmp/repro/r5-syntactic.js`: the delete answers `true`, and
`arguments.hasOwnProperty("length")` still answers `true`).

`emitArgumentsOrdinaryNamedDelete` folds `delete arguments.length` to a constant
`true` at compile time when the arguments object provably cannot escape, and its
own header already records that "the property still SURVIVES". It does not set
the #4658 tombstone, so that one path keeps #4622's answer while every DYNAMIC
delete now records it. Not folded in here deliberately: the arm fires only when
`argumentsObjectMayBeReconfigured` proves the object is unreachable as a value,
so the two paths are disjoint by construction and this change makes nothing
worse — but a future slice that unifies them should set the bit there too.

## Successor for the unclaimed residuals (lead, 2026-08-24)

R1, R4 and R5 name their owners (the `[[ParameterMap]]` / descriptor-sidecar
representation behind #3251/#4622). R2 and R3 were unclaimed, so they are filed as
**[#4667](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4667-arguments-array-identity-vec-shared-rep)**
— together, deliberately, because R2 carries a landing-order hazard that is invisible
from either row alone: `propertyHelper.isWritable` takes its Array branch *because*
`Array.isArray(arguments)` wrongly answers `true`, and that branch is the only reason
`10.6-6-2` — a row this issue just fixed — passes. Fixing R2 without R1 trades one row
for another silently.
