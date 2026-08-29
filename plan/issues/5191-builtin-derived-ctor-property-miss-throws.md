---
id: 5191
title: "Reading an absent property off the constructor of a builtin-derived class throws instead of yielding undefined (blocks the Temporal polyfill's module init)"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
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

# #5191 — property miss on a builtin-derived class constructor throws

## Problem

For a class whose `extends` clause names a **builtin** constructor (`Array`,
`Error`, `Map`, …), reading a property that is not present on the *constructor
object* throws a WasmGC exception instead of evaluating to `undefined`.

```js
class C extends Array {}
C.zzz === undefined; // spec: true.  js2wasm: throws
```

Plain classes, classes derived from a **user** base, ordinary functions and
object literals all behave correctly — so the defect is specific to the
builtin-derived constructor object, not to expando statics in general.

Measured on `origin/main` @ `279ce9a4f2`, 2026-08-29, with the test262 runner's
compile options (`allowJs: true, skipSemanticDiagnostics: true, sourceMap:
true`) and `WebAssembly.instantiate(result.binary, result.importObject)`:

| Receiver | `C.zzz === undefined` |
| --- | --- |
| `class C {}` | `1` (correct) |
| `class B {}; class C extends B {}` | `1` (correct) |
| `function C(){}` | `1` (correct) |
| `const C = {}` | `1` (correct) |
| `class C extends Array {}` | **throws** |
| `class C extends Error {}` | **throws** |
| `class C extends Map {}` | **throws** |

Two adjacent symptoms share the receiver and are almost certainly the same
root cause:

| Shape | Result |
| --- | --- |
| `class C extends Array {}; C.a = 1; Object.getOwnPropertyNames(C).length` | throws **TypeError** |
| `class C extends Array {}; C.a = 1, C.b = 2; C.b` | throws |

Not affected, and useful for bisecting the dispatch: `"a" in C` returns the
right answer, a *single* statically-paired write+read (`C.a = 1; C.a`) returns
`1`, and the same two writes as **separate statements** (`C.a=1; C.b=2;`)
return `2`. Only the comma-sequence form degrades — i.e. the failure appears
once the access leaves the statically-resolved arm and reaches the generic
constructor-object dispatch.

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
const r = await compile('class C extends Array {}\nexport function probe(){ return C.zzz === undefined ? 1 : 0; }',
  {fileName:'t.js', allowJs:true, skipSemanticDiagnostics:true, sourceMap:true});
const {instance} = await WebAssembly.instantiate(r.binary, r.importObject);
r.importObject.__setInstance?.(instance);
console.log(instance.exports.probe());   // expect 1; today: throws
"
```

## Acceptance criteria

1. All seven receiver rows in the table above yield `1`.
2. `Object.getOwnPropertyNames(C)` on a builtin-derived class returns its own
   static keys instead of throwing.
3. The comma-sequence static-write shape (`C.a=1, C.b=C.a<<5;` at module top
   level on a `class C extends Array`) instantiates and reads back correctly.
4. `tests/dogfood/temporal-polyfill-harness.mjs --no-umd` advances past
   statement 2 — i.e. the reported `moduleInitError` changes or clears. (It is
   NOT a criterion that the whole polyfill init succeeds; later statements may
   surface further defects, which get their own issues.)
5. No regression in the Temporal bucket or the class/subclass equivalence
   tests.

## Notes

Start at the constructor-object property-access dispatch
(`src/codegen/property-access-dispatch.ts`) and the builtin-derived class
paths (`src/codegen/builtin-proto-constructor.ts`,
`src/codegen/standalone-subclass-ctors.ts`,
`src/codegen/class-static-metadata.ts`). The working `class C extends B {}`
case is the reference behaviour to converge on: something in the
builtin-extends arm makes an unresolved key trap rather than fall through to
the `undefined` result.
