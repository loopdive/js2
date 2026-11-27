---
id: 7579
title: "Prepared path: array literals and computed member keys (array PR B)"
status: done
completed: 2026-11-27
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7352]
related: [7352, 7561, 7574, 7354]
---

# #7579 — Prepared path: array literals and computed member keys

## Problem

Array PR A (#7352, branch `claude/7352-arrays-a`) made `Array` a realm value on the Prepared whole-program path
(`Array(…)`, `Array.isArray`, `length`, constant index keys). Two shapes that almost every test262 body and the
harness (`propertyHelper.js`, `compareArray.js`) use still stop the path:

- an array literal: `var a = [1, 2]` refuses at module level ("mixed-type array literal"), and aborts inside a
  function (its function's abort body);
- a computed member key: `a[i]`, `o[k] = v` refuse on every receiver ("dyn.member_get with a computed key").

Specification: #7352's "Re-build on #7561", the part on PR B, and the requirements carried from A1a's reviews r1/r2
(`origin/claude/7354-a1`, #7354's file).

## Implementation Plan

### Target structure

- **The literal** (`src/ir/prepared-array-literal.ts`, new, mined from A1a): the front end evaluates the elements
  left to right and emits ONE helper call, `__ir_array_literal`, typed dynamic. Its operands are the literal's length
  (an f64: holes and a trailing elision counted, a trailing comma not) and then each present element's index key and
  value. No length or index in the symbol text, no parser. A spread element refuses by name.
- **from-ast** keeps one arm: `lowerArrayLiteral` hands a literal the Prepared resolver owns
  (`preparedRealmLiteral`, the renamed `preparedOrdinaryObjectLiteral`, one predicate for both literal kinds) to the
  new module; the empty-literal vec inference is skipped for it. `from-ast.ts` does not grow.
- **The legalization** (`dynamic-array-constructors.ts`): the helper call is written with PR A's `arrayOf`, now taking
  key/value pairs, so `Array(…)` and the literal share the one ArrayCreate-then-CreateDataProperty helper
  (CreateDataProperty, never [[Set]]: no setter on `Array.prototype` runs, no user `Array` is called).
  `isArrayLiteralCall` sits beside `realmConstructorOf` in `dynamic-realm-calls.ts`; `carrierKindOf` and
  `knownKinds` read the call as an object.
- **Holding**: `source-plain-objects.ts` adds the array family for a literal (one line, what `constructorRead`
  does for `Array`).
- **Computed keys** (`dynamic-member-access.ts`): `computedAccess`, an `Access` of the same shape as the constant
  read and write, written over the key's kinds. A string key is the key; a number, boolean, `undefined` or `null` key
  is the program's ToString (`stringOf`, the same Number::toString a constant number key's `constantKey` uses — one
  canonicalisation); an object or function key is the run-time abort (its ToPrimitive is observable). A primitive
  receiver is the run-time abort. The constant write's `putValue` becomes a shared function both writes use.
- **Partial objects under a computed key**: settled by measurement in the result section. Plan: keep #7561's pin
  rule for constant keys; for a computed key no member is pinned, and a [[Get]] miss on a key that may name a member
  the realm did not materialise is the run-time abort (`is-partial`'s question, answered without a call where the
  answer is the same for every chain).

### Reuses / removes

- Reuses `arrayOf`, `constantKey`'s canonical string, `memberAccess`, `typeErrorThen`, `stringOf`, `toNumber`,
  `OBJECT_PROTOTYPE_ACCESSOR_KEYS` / `FUNCTION_PROTOTYPE_ACCESSOR_KEYS`, `dynamicStoreOperand`.
- Removes: from-ast's `191` (`FULL_DATA_DESCRIPTOR`); the two `putValue` closures become one; PR A review findings
  folded (refusal-text assertions in `tests/issue-7352-arrays.test.ts`, `HeldFamily.throws` single user, the `A1b`
  history comment in `ordinary-to-primitive.ts`, `CARRIER` / `BOOLEAN` imported from two modules in
  `dynamic-prototype-methods.ts`).

### Acceptance

1. Literals and computed keys agree with node (fresh realm, each agreement with a wrong twin) at module level and in
   functions; 0 wrong, 0 invalid Wasm, 0 exceptions out of `compile()`.
2. Out of scope keeps refusing or aborting: for-in / for-of over arrays, spread, destructuring, `Array.prototype`
   method bodies, `Array.from` / `of`, `Object.getOwnPropertyNames` / `keys` on arrays, `JSON`, `arguments`,
   `Function` / `call` / `bind`; ToPrimitive of an array aborts before reading `toString` / `valueOf`.
3. Code quality: one literal helper symbol carried by operands; one `arrayOf`; one key canonicalisation; computed
   access an `Access` like its constant siblings; no new IR→runtime import edge (10); `from-ast.ts` ≤ 17,395 lines.
4. Ordinary pipeline byte-identical; a Prepared program with no literal and no computed key byte-identical.
5. test262 (own runner): the 91 ES5 `built-ins/Array` no-include files and `mw-00` (87 rows), base vs head, no pass
   lost.

## Result (2026-11-27, branch `claude/7579-arrays-b`, base `claude/7352-arrays-a` `a851be4a78`)

**Built** (+291 / −116 under `src/`; one new module, 37 lines):

- `prepared-array-literal.ts`: the literal as one `__ir_array_literal` call over operands (length, then key/value per
  present element), mined from A1a and kept as it was there, minus its defensive null check.
  `dynamic-array-constructors.ts`: `arrayOf` takes the values and a key builder, so the literal and `Array(…)` share
  it (the `Array(…)` instructions and value numbering are those of the base: the same bytes).
- `dynamic-member-access.ts`: `constantKey` answers `undefined` for a computed key, which `computedAccess` (an
  `Access` like the constant read and write) serves; `putValue` is one function for both writes.
- from-ast: `dynamicNamedMember` is `dynamicMember` and takes an element access too, so `a[i] += v` / `a[i]++` are
  the named compound's code; a dynamic receiver's element read lowers its key as the dynamic value (it was lowered with
  an f64 hint: `f(o, k) { return o[k]; } f({a: 1}, "a")` would have read key `"NaN"`, the old C5 refusal's reason).
  The `ArrayLiteralExpression` dispatch and the element-read arm lost their stale comments. `191` is
  `FULL_DATA_DESCRIPTOR`. `preparedOrdinaryObjectLiteral` is `preparedRealmLiteral`.
- `source-plain-objects.ts`: a literal holds the array family. `scripts/compiler-boundaries.json`: the new module.

**Partial objects under a computed key (the open question), decided by measurement.** `is-partial` (on
`origin/claude/7354-a1b`) is not on this base, and it answers for one object; a [[Get]] miss is a question about the
whole chain, which ends at Object.prototype, which every realm holds partially. So for an ordinary object
`is-partial` would answer "may be partial" on every miss: the same answer as a test of the key alone, with a runtime
body and a chain walk the legalization cannot write (no loops). What is built: no member is pinned for a computed key;
a string key the receiver's chain lacks (`js.object.has`) is the run-time abort, except a canonical numeric string
(ToString(ToNumber(k)) is k), which no built-in member is named, and which a read answers as absent and a write
creates. The same rule covers writes: a computed write to an own member a built-in prototype holds unmaterialised
(`Array.prototype[k] = f`, k = "join") would create an enumerable property where the specification overwrites a
non-enumerable one, and it aborts. Bytes, `var a = [1, 2]; var i = 1; var out = a[i];`: 43,919 B as built; 73,048 B
with the pin rule extended to computed `get` / `set` / `has` (all 38 Array.prototype rows: +29.1 KB). Cost of this
choice: `o[k] = v` with a new non-numeric name aborts. `is-partial` with #7557's realm-object table would admit
those writes (an own miss on a receiver that is no partial realm object): the one place to change is `computedAccess`'s
string arm.

**Works** (each agreement in `tests/issue-7579-array-literals.test.ts` with a wrong twin):

- literals: `[]`, `[1, "a", o]`, nested, holes `[1, , 3]`, `[1, ].length` 1, `[, ].length` 1, elements in order, a
  throwing element leaves the binding, a new array per evaluation, `Array.isArray([])`, `"[object Array]"`,
  `instanceof`, `constructor`; `var Array = f; [1, 2]` makes a real array; no setter on `Array.prototype` runs; a hole
  reads through `Array.prototype` (`Array.prototype[0] = "p"; [ , ][0]`);
- computed keys: `a[i]`, `a[i] = v`, `a[i] += v`, `a[i]++` (module and function); negative, fractional, NaN,
  2**32−1 (a plain property), `"1"`, `"length"`, held names, `true` / `null` / `undefined` (their strings), objects and
  functions as receivers, keys through parameters, `0.1 + 0.2` and `1e21` equal to the constant key's canonical
  string, nullish receivers' TypeError, strict / sloppy writes to read-only indices and frozen `length`.

**Aborts or refuses as on the base** (each a test row): ToPrimitive of an array (`o[[1]]` aborts brand-first;
`[1] + ""` and `[] == 0` refuse in from-ast / the legalization), an object key (abort), a primitive receiver (abort),
any receiver where a String object may exist (abort), an absent non-numeric name and a new non-numeric name (abort),
`__proto__` (abort), method calls on a literal (abort), for-of / for-in over a literal (abort in a function, refuse at
module level), spread (refuses by name), destructuring, `Array.of`, `Object.getOwnPropertyNames([1])`, `JSON`, `bind`
(refuse), `arguments` (abort). `Object.prototype[0] = …` refuses (`Object` is not in scope).

Not reached, base gaps found on the way (not this slice's): a function-local object literal is a raw externref, so
`o[k]` on one in a function aborts (A1a r1 follow-up); a closure that captures a local object aborts; `x + y` where
TypeScript types an operand `undefined` (`[ , ][0] + "x"`) refuses in from-ast; compound assignment to an undeclared
global from a closure refuses.

**Proof** (local node 22, load 2–7 from the other agent):

- Probes vs node in a fresh realm: 70 programs; 38 right (each with a failing wrong twin), 2 right without a twin
  (out-of-scope rows that answer), 18 aborted, 12 refused, wrong 0, invalid 0, exceptions 0.
- test262 (own runner, `assert.js` + `sta.js` + includes): the 91 ES5 `built-ins/Array` no-include files: pass 23 →
  23, fail 53 → 53, compile error 15 → 15 (these files hold no literal); `mw-00` (87 rows): pass 18 → 20 (`S15.4.5.2_A1_T1`,
  `length/S15.4.5.1_A1.1_T2`), fail 11 → 12 (`toString/S15.4.4.2_A3_T1`, was a compile error: a method body), compile
  error 58 → 55; no pass lost. Base rows: PR A's own runs of the same lists on the base head.
- First stops that remain, `mw-00`: eval without a provider 25, run-time abort 12 (method bodies), direct call with no
  AST-site plan 6, unknown class (`Date`, `RegExp`) 5, identifier not in scope (`Object`, `Function`, `Math`, `JSON`)
  5. The 91 Array files: run-time abort 53 (method bodies), `+` with an unprovable operand 3, `Function` 2.
- Prelude (`assert.js` + `sta.js` + one assertion): 90,242 → 92,129 B (+1.9 KB: `compareArray` lowers now); median of
  3 compiles, base and head interleaved, 6.9 / 6.6 s → 6.6 / 7.6 s (load 5–7): within noise, mean of medians +0.3 s.
- First literal: `[1, 2]` 27,434 B against `Array(1, 2)` 27,578 B. First computed key: +16.5 KB (43,919 B), nearly all
  Number::toString (`String(i)` beside `Array(1, 2)`: 46,674 B).
- Bytes: ordinary pipeline 30 programs × 2 targets identical; Prepared corpus 19 programs identical but the three
  preludes (they read `a[i]`).
- `src/ir/from-ast.ts` 17,395 → 17,385. Gates at the merge base all pass (import-cycles, ir-layering unchanged; IR →
  runtime edges unchanged); with `LOC_GATE_BASE=origin/main` the LOC and function budgets fail only on files this
  branch does not touch (`src/codegen/declarations*.ts`, `nested-declarations.ts`, `array-methods.ts`, `closures.ts`,
  `property-access.ts`, `eval-inline.ts`, `calls.ts`): main moving.

**From the other lane (2026-11-27), acceptance cohort: the 11 ES5 files of `language/expressions/array/`** (no
spread): base 0 pass / 11 compile errors (first stops: "array literal with elision not in #1804 scope" 6, "resolver
cannot register vec for array literal" 4, "empty array escapes before its element type is closed" 1) → head 11 pass.

- `a[i] === undefined` / `!==`: from-ast refused an unproven indexed read compared with `undefined` ("unproven indexed
  read cannot be compared with undefined"); a read off a dynamic binding (`tryLowerUndefinedCompare`, one condition
  more) is the carrier now and takes the existing tag test, so the actual value decides: `null`, an explicit
  `undefined`, a hole, a hole inherited through `Array.prototype[i]`, an out-of-bounds index; the bounds proof stays
  for unboxed vec reads. Probes at module level and in a function agree with node; test rows added. Ordinary pipeline
  bytes unchanged.
- Method identity through an instance (`[1].toString === Array.prototype.toString`, `a.join`, `a.push`) was already
  right on this base: the constant read pins the member and [[Get]] finds it on the chain; calling it still aborts.
  Test row added.

**PR A findings folded**: refusal-text assertions in `tests/issue-7352-arrays.test.ts` (now "refuses" only); the
`A1b` history comment in `ordinary-to-primitive.ts`; `dynamic-prototype-methods.ts` imports `BOOLEAN`, `CARRIER`
from `dynamic-value-types.ts`. Kept, with the reason: `HeldFamily.throws` (one user). Making it plain means the
Error family's row testing "is the Array family used", which re-derives the used-family test `heldFamilies` already
makes once; a field read by that one test is the smaller code.

**Tests moved** (each a shape this slice changes): `issue-7352-arrays` (literal and computed rows left it),
`issue-7354-o3`, `-o4`, `-o7`, `-m-refusals`, `-d1`, `-h-script-var` (computed keys and literals run now),
`-x-dynamic-throw` (the vector-store row), `-c2` (a spread argument refuses one step later), `-u-abort-bodies` (its
"legalization refusal" stand-in is loose equality now), `-u-prelude` (`compareArray` lowers; the abort row became an
agreement), `-f0` (the kept-binding `+` row converts a spread literal). Run alone, each passes, and so do
`issue-7354-o1`, `-o2`, `-m-prototype-premise`, `-t2`, `issue-7500`, `issue-7499`, `issue-7434`, `issue-3518`, and
`issue-7561-wrappers` sliced (`-t "real harness prelude|leaves out"`; the full file exceeds 9 minutes here).
`issue-7363-prepared-eval-refusal` has one failure ("does not take a block function"), identical on the base.
