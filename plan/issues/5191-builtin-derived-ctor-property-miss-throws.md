---
id: 5191
title: "A class extending a builtin has NO class-object singleton, so its own name evaluates to null (C == null is true; blocks the Temporal polyfill's module init)"
status: done
sprint: current
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: classes
goal: core-semantics
related: [4628, 661]
---

# #5191 — a builtin-derived class evaluates to `null` as a value

## Problem

A class whose `extends` clause names a **builtin** constructor (`Array`,
`Error`, `Map`, …) gets **no class-object singleton**, so its own name
evaluates to `null` whenever it is read as a first-class value:

```js
class C extends Array {}
C == null;      // spec: false.  js2wasm: TRUE
Boolean(C);     // spec: true.   js2wasm: FALSE
C.zzz;          // spec: undefined. js2wasm: throws
                //   TypeError: Cannot access property on null or undefined
```

That last one is a *consequence*, not the defect: the property access throws
because the receiver it loaded is `null`.

Plain classes, classes derived from a **user** base, ordinary functions and
object literals are all correct — the defect is specific to builtin-derived
classes.

Measured on `origin/main` @ `279ce9a4f2`, 2026-08-29, with the test262 runner's
compile options (`allowJs: true, skipSemanticDiagnostics: true, sourceMap:
true`) and `WebAssembly.instantiate(result.binary, result.importObject)`:

| Receiver | `C == null` (expect `false`) | `C.zzz === undefined` (expect `true`) |
| --- | --- | --- |
| `class C {}` | false ✓ | true ✓ |
| `class B {}; class C extends B {}` | false ✓ | true ✓ |
| `function C(){}` | false ✓ | true ✓ |
| `const C = {}` | false ✓ | true ✓ |
| `class C extends Array {}` | **true ✗** | **throws** |
| `class C extends Error {}` | **true ✗** | **throws** |
| `class C extends Map {}` | **true ✗** | **throws** |

`Boolean(C)` is `false` for `class C extends Array {}`. Identity (`const v = C;
v === C`) reports `true` only because `null === null`.

What masks it: `typeof C === "function"` and `C.name === "C"` both answer
correctly, and `new C()` works — those are served by static arms that never
materialise the constructor object. So the binding looks fine until something
reads it as a value.

Adjacent symptoms, same root cause:

| Shape | Result |
| --- | --- |
| `class C extends Array {}; C.a = 1; Object.getOwnPropertyNames(C).length` | throws **TypeError** |
| `class C extends Array {}; C.a = 1, C.b = 2; C.b` | throws |

Useful for bisecting: `"a" in C` answers correctly, a single statically-paired
write+read (`C.a = 1; C.a`) returns `1`, and the same two writes as *separate
statements* return `2`. Only shapes that leave the statically-resolved arm and
load the constructor object as a value degrade.

## Root cause — located

`src/codegen/class-bodies.ts` (~L1188), where the class-object singleton is
registered:

```ts
// (#1395) Register a class-object singleton global … Skip for
// externref-backed builtin subclasses (#1366a) — those don't have a
// `$ClassName` WasmGC struct.
if (!ctx.classBuiltinParentMap.has(className)) {
  … ctx.classObjectGlobals.set(className, classObjectGlobalIdx);
}
```

Builtin-derived classes are deliberately excluded. The consumer,
`emitLazyClassObjectGet` (`src/codegen/expressions/extern.ts:362`), returns
`false` when `classObjectGlobals` has no entry — so the identifier read in
`src/codegen/expressions/identifiers.ts:1350` falls through every subsequent
registry and ends at a null.

The exclusion is not gratuitous: `emitLazyClassObjectGet` builds the class
object as a `struct.new` of the `$ClassName` WasmGC struct, which an
externref-backed subclass does not have. **So the fix is not "delete the
guard"** — it needs a different carrier for the class object on this lane.
`src/codegen/builtin-static-globals.ts:144` ("#3006 — emit a GENUINE,
identity-stable reified builtin-constructor object") is the closest existing
precedent and the natural place to start.

Whatever carrier is chosen has to keep `new C()`, `C.prototype`, static
methods, `instanceof` and the standalone lane working, which is why this is
`feasibility: hard` rather than a one-line change.

## Why it matters now

This is the **first thing the compiled `@js-temporal/polyfill` bundle hits at
runtime**, and it is what blocks [#4628](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4628-temporal-runtime-object-spike)
step 3. `jsbi@4.3.0` — the polyfill's single dependency — is
`class JSBI extends Array`, and its **second top-level statement** is one long
comma sequence of static-table assignments:

```js
JSBI.__kMaxLength=33554432,JSBI.__kMaxLengthBits=JSBI.__kMaxLength<<5,…
```

Bisecting the linked 157,541-byte bundle by top-level-statement prefix
(9 compiles, `.tmp/probe-bisect.mts` in the #4628 branch) puts the first
instantiate failure at exactly statement 2 of 341: prefix 1 instantiates,
prefix 2 throws. So the whole Option-A path — `Temporal` installed from the
compiled polyfill's exports — is gated on this one defect. A module whose init
throws has no exports to install, and no wiring choice routes around that.

## Reproduce

```bash
npx tsx -e "
import {compile} from './src/index.ts';
const r = await compile('class C extends Array {}\nexport function probe(){ return C == null ? 1 : 0; }',
  {fileName:'t.js', allowJs:true, skipSemanticDiagnostics:true, sourceMap:true});
const {instance} = await WebAssembly.instantiate(r.binary, r.importObject);
r.importObject.__setInstance?.(instance);
console.log(instance.exports.probe());   // expect 0; today: 1
"
```

Swap the body for `C.zzz === undefined ? 1 : 0` to see the derived symptom (a
thrown `TypeError: Cannot access property on null or undefined`, read off the
module's `__exn_tag` export).

## Acceptance criteria

1. `C == null` is `false` and `Boolean(C)` is `true` for every builtin base in
   the table (`Array`, `Error`, `Map`), matching the plain-class rows.
2. `C.zzz === undefined` is `true` for those same receivers.
3. `Object.getOwnPropertyNames(C)` on a builtin-derived class returns its own
   static keys instead of throwing.
4. The comma-sequence static-write shape (`C.a=1, C.b=C.a<<5;` at module top
   level on a `class C extends Array`) instantiates and reads back correctly.
5. `tests/dogfood/temporal-polyfill-harness.mjs --no-umd` advances past
   statement 2 — i.e. the reported `moduleInitError` changes or clears. (It is
   NOT a criterion that the whole polyfill init succeeds; later statements may
   surface further defects, which get their own issues.)
6. `new C()`, `C.prototype`, static methods and `instanceof` are unregressed on
   builtin-derived classes, on both the host and standalone lanes.
7. No regression in the Temporal bucket or the class/subclass equivalence
   tests.

## Notes

Reference behaviour to converge on is the working `class C extends B {}` path.
Related code besides the two sites named above:
`src/codegen/builtin-proto-constructor.ts`,
`src/codegen/standalone-subclass-ctors.ts`,
`src/codegen/class-static-metadata.ts`.

The `classBuiltinParentMap` guard has been there since #1366a, so this has
presumably been wrong for every builtin-derived class since — the reason it
went unnoticed is the masking described above (`typeof`, `.name` and `new C()`
all answer correctly). Expect the blast radius of a fix to be wider than the
Temporal bucket, in both directions.

## Fix — carrier decision and evidence

**Carrier chosen: the existing `$ClassName` struct singleton. No new carrier
was added, and no code was written for one.** The change is that
`class-bodies.ts` now registers the `__class_<Name>` global for
`classBuiltinParentMap` members too, instead of skipping them.

### Why the #1366a guard could simply go

The guard's stated ground — externref-backed builtin subclasses "don't have a
`$ClassName` WasmGC struct" — is **factually false**, and that is the whole
finding. `ctx.structMap.set(className, structTypeIdx)` runs at
`src/codegen/class-bodies.ts:982`, ~200 lines *above* the registration site and
**unconditionally**: the type index is allocated and `commitClassStructLayout`
commits the layout before any builtin-parent branch is consulted. So
`emitLazyClassObjectGet`'s `structMap` / `structFields` lookups have always
succeeded for these classes; nothing was ever going to emit a `struct.new` for
a type that does not exist.

What an externref-backed subclass actually lacks is struct **instances** — its
objects are host-created externrefs (`isExternrefBackedClass` makes the
constructor return `externref`). That makes the `$ClassName` struct *dead* for
these classes, which is exactly what makes it a **safe** singleton carrier
here: no instance can ever be confused with the class object, so the identity
question the carrier exists to answer stays unambiguous.

### Why not a `__new_plain_object` carrier

`src/codegen/builtin-static-globals.ts:144` (`emitBuiltinConstructorIdentity`,
#3006) was the named precedent — a plain `$Object` carrier for reified builtin
constructors. It was rejected here for two reasons:

1. **It would create a second class-object SHAPE.** Everything
   `emitLazyClassObjectGet` does after `global.set` —
   `__register_class_object` (the gOPD own-key allowlist),
   the #4616 `.name` stamp, `__register_class_static_method` (#4371) and
   `__register_class_ctor` (#4618, the host `[[Construct]]` bridge) — is
   written against the class object's **closed-struct identity**; #4371's own
   comment says so explicitly. A plain `$Object` carrier would need every one
   of those consumers taught a second case, on a lane with no test coverage
   for them.
2. **It buys nothing.** The struct carrier already produces correct behaviour
   on all 16 measured shapes, on both lanes. A second mechanism would be
   strictly more code for the same result.

### Measurements (base = `origin/main` @ `279ce9a4f2`, A/B by file copy)

Deltas below are from probe runs executed in both directions, not inferred.
Every builtin-derived row changed; **no row regressed**, on either lane.

| Shape (`class C extends Array` unless noted) | base | fix |
| --- | --- | --- |
| `C == null` | true | **false** |
| `Boolean(C)` | false | **true** |
| `C.zzz === undefined` | **throws** | true |
| `class A/B extends Array; A === B` | true (both null) | **false** |
| `C.a=1; C.b=2; C.b` | **throws** | 2 |
| jsbi comma sequence `J.__kMaxLengthBits` | **throws** (host) / NaN (standalone) | 1073741824 |
| `Object.getOwnPropertyNames(C).length > 0` | **throws** | true |
| `class C extends Int8Array` non-null | false | **true** |
| `class D extends C` (C builtin-derived) non-null | false | **true** |
| `typeof C`, `C.name`, `new C()`, `C.prototype`, `instanceof`, `Array.isArray(new C())`, static methods (direct / via variable / inherited), `extends Error` throw+catch, `extends Map` get/set | correct | correct (unchanged) |

Two residuals are **pre-existing and NOT builtin-specific** — a plain `class C
{}` control behaves identically before and after, so they are out of scope
here: `(C as any).name` reads `undefined`, and a write spelled through a cast
(`(C as any).a = 1`) reads back `NaN` where the uncast `C.a = 1` reads `1`.
The fix improved both from *throwing* to *wrong value*; neither is a
regression. The uncast spelling — which is what jsbi actually is, since jsbi is
JavaScript — is correct.

### Temporal harness — the blocker MOVED (acceptance criterion 5)

`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs`, run with the
instrumented harness from PR #5239's branch (this PR does not modify the
harness), esm linked lane:

| | `moduleInitRuns` | `moduleInitError` |
| --- | --- | --- |
| base | false | `WebAssembly.Exception thrown from module init (payload unreadable: no instance, so no __exn_tag)` |
| fix | false | `TypeError: cannot marshal opaque compiled value to host Float64Array constructor` |

The opaque Wasm exception was the null-receiver `TypeError` at jsbi's statement
2. It is gone; module init now advances into the polyfill proper and stops at a
**new, later, and legible** blocker: a compiled value being handed to the host
`Float64Array` constructor without a marshalling path. That is a distinct
defect in the compiled-value → host-constructor boundary and needs its own
issue (it was **not** filed here — `claim-issue.mjs --allocate` refused with
exit 6 because the open-PR id scan could not reach `gh` from this container,
and reserving an unverifiable id would burn a hole in the sequence).

`moduleInitRuns` is still `false`, so #4628 Option A remains gated — on the new
blocker, not on this one. The umd/ES5 lane is unchanged and still fails
`WebAssembly.compile()` on `__closure_35` (`expected externref, got i32`),
which predates this change.

### Validation run

- `tests/issue-5191-builtin-derived-class-value.test.ts` (new): **29 passed**
  with the fix; **21 failed / 8 passed** on base. The 8 that pass on base are
  the deliberately-included masking arms (`typeof`, `.name`, `new C()`,
  `instanceof`, static methods) — they are there so a fix that made `C == null`
  false by breaking construction could not pass.
- Scoped class suites, all green:
  `issue-661`, `classes`, `inheritance`, `class-expression`,
  `class-expressions`, `class-methods`, `class-method-calls`,
  `class-method-struct-new`, `abstract-classes`, `class-elements-619`,
  `class-static-private-this` (71 tests); plus
  `issue-2029-error-subclass-get-undefined-standalone`,
  `issue-2029-primitive-wrapper-subclass-standalone`,
  `issue-2029-subclass-builtin-standalone-emit`,
  `issue-2101a-externref-subclass-ownfield`,
  `issue-2158-class-identity-standalone`,
  `issue-2620-extends-set-standalone-refusal`,
  `issue-2620-gc-host-inherited-collection-methods`,
  `issue-2623-promise-subclass-identity`,
  `issue-2917-standalone-extends-builtin`,
  `issue-3239-standalone-subclass-typedarray-native-ctor`,
  `issue-3201-inherited-length` (116 tests).
- `tests/issue-2726-inherited-delete-noop.test.ts` fails — **also on base**,
  verified by re-running it against the reverted files. Pre-existing.
- `scripts/equivalence-gate.mjs` shards 1–8: no new regressions.
- Ratchet gates all exit 0: `check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`. The
  comment block was written to fit under the `class-bodies.ts` LOC and
  `collectClassDeclaration` func ceilings rather than take an allowance, which
  is why the long rationale lives on `emitLazyClassObjectGet` in
  `src/codegen/expressions/extern.ts`.
