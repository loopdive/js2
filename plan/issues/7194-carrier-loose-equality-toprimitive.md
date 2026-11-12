---
id: 7194
title: "Carrier loose ==/!= skips ToPrimitive on object operands (standalone and WASI IR, standalone legacy)"
status: ready
sprint: current
created: 2026-10-29
updated: 2026-11-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
parent: 7106
related: [7193, 7178, 7113, 7144, 7340, 7341, 7338, 7280]
---

# Carrier loose `==` / `!=` skips ToPrimitive on object operands

## Problem

IsLooselyEqual (§7.2.14) ToPrimitives an object operand compared against a
primitive. The boxed-any carrier's loose equality does not do this on any no-host
lane. This is pre-existing on base `95648287`; it was found while reviewing
[#7193](./7193-standalone-prepared-dynamic-helper-abi.md) (PR #6973).

- **Standalone IR:** `__extern_loose_eq` (`src/codegen/any-helpers.ts`,
  `ensureExternLooseEqHelper`) is `__any_from_extern` ×2 + `__any_eq`. Its
  results:
  - `({ valueOf() { return 2 } }) == 2` traps on an illegal cast;
  - `[2] == 2` traps;
  - `[2] != "2"` and `{ toString() { return "2" } } != "2"` answer `true`
    (node: `false`).

  An ordinary top-level function reproduces it:
  ```ts
  export function g(m: any): number { return m == 2 ? 1 : 0; }
  export function run(): number { return g({ valueOf: function () { return 2; } }); }
  // standalone, IR claims g → RuntimeError: illegal cast; experimentalIR:false → 1
  ```
  Legacy standalone is correct in this top-level shape: its inline arm calls
  `__to_primitive` before `__any_eq`.
- **Standalone legacy, planned member closure in `<module-init>`:** the #7193
  reviewer measured `{ valueOf(){return 2} } == 2` trapping. A
  parameter-operand probe (`if (m == 2)`) answered correctly in legacy, so the
  legacy trap is shape-dependent; pin it before fixing.
- **WASI IR (claimed in planned member closures today):** the #7193 reviewer
  measured the following, where legacy answers correctly:
  - `{ valueOf(){return 2} } == 2` traps;
  - `[2] != "2"` differs from node;
  - `m != 2` over mixed inputs traps.

  Shape:
  `subject.f = function (m, k) { if (k === 9) return; var r = m ? m : 1; if (r == 2) throw "e"; throw r; };`

**It is live in `<module-init>` on main** (measured 2026-11-12, main
`d9dd218bbf`). The containment below covers planned closures only. A script
var on the dynamic home compared in the script body is claimed and traps:

```js
var o = {};
if (o == 1) throw new Test262Error("x");   // <module-init> is IR; RuntimeError: illegal cast in __str_to_number
```

#7340 (`var s = new String("a"); s == "a"`) and #7341 (`new Object()`) put
more objects into carriers, so both wait for this issue.

## Current containment

`native-dynamic-loose-equality` (`src/ir/backend/legality.ts`) is WASI-only. It
admits carrier loose equality in planned closures on WASI only to keep main's
output. Standalone refuses it at select (`closure-carrier-helper-operator`).

Outside a planned closure nothing refuses it: `<module-init>` goes through
`selectorPrimitiveWrapperOrGenericBinary` and a function with a dynamic
parameter through the S5.P scan (`concreteDynamicEqualityOperandIsBuildable`),
and both admit a carrier against a number, string or boolean.

## Measurements

Base: `origin/main` `d9dd218bbf` (contains #7209 and #7210), exported with
`git archive` into a scratch tree. Standalone, original harness. 2026-11-12.

### The matrix

786 generated one-comparison files, each run with
`scripts/run-test262-paths.mts --standalone`; the expected answer is node's.

- Carrier values (13): `{}`, an object with `valueOf`, one with `toString`,
  `[2]`, a function, `new Number(2)`, `new String("2")`, `new Boolean(true)`,
  `null`, `undefined`, `"2"`, `2`, `true`.
- Other operand (9 literals): `2`, `0`, `"2"`, `""`, `"[object Object]"`,
  `true`, `false`, `null`, `undefined`; or a second carrier holding `2`,
  `"2"`, `true`, `null`, `undefined`, another `{}`, or the same value.
- `==` in both operand orders, `!=` with the carrier on the left.
- Shapes: `function f(c) { return c == <literal>; }` and
  `function f(c, d) { return c == d; }`, where the caller builds the value and
  `f` is the unit under test; and a script var compared in `<module-init>`.
- Routing ("is the comparing unit IR") was compiled for 407 cells and inferred
  for the rest from the same comparison with another value (0 disagreements
  among the cells measured both ways).

| shape | IR-claimed cells | trap | wrong answer | correct | not IR-claimed |
|---|---|---|---|---|---|
| one carrier against a literal, `==` | 208 | 64 | 12 | 132 | 26, all correct |
| one carrier against a literal, `!=` | 104 | 32 | 6 | 66 | 13, all correct |
| script var in `<module-init>`, `==` | 96 | 8 | 2 | 86 | 12, all correct |
| script var in `<module-init>`, `!=` | 48 | 4 | 1 | 43 | 6, all correct |
| two carriers, `==` | 169 | 36 | 12 | 121 | 0 |
| **total** | **625** | **144** | **33** | **448** | 57 |

Which cells fail, the same in every shape and in both operand orders:

| carrier holds | against a number or boolean | against a string | against `null` / `undefined` | against another object |
|---|---|---|---|---|
| `{}` | **trap** | wrong only where ToPrimitive would match (`"[object Object]"`) | correct | correct |
| object with `valueOf` / `toString`, array, `Number` / `String` wrapper | **trap** | **wrong** where ToPrimitive would match (`"2"`) | correct | correct |
| function, `Boolean` wrapper | **trap** | correct (no string in the matrix matches) | correct | correct |
| a number or boolean, against a carrier holding an object | **trap** | | | |
| `null`, `undefined`, string, number, boolean | correct | correct | correct | correct |

- The trap is `illegal cast in __str_to_number` (through `__extern_loose_eq`
  or `__any_eq`): the object is treated as a string.
- The 57 cells that are not IR-claimed are the loose comparisons against a
  literal `null`: 39 are refused at select (`move-only[concrete]`), and 18 in
  `<module-init>` are **claimed and then withdrawn** ("bare 'null' in
  non-reference context"). PR #7212's `nullishCompare` refuses those at
  select; this issue leaves them to it.
- Legacy is correct in every cell it compiles here.

### Other operators do not share the gap

104 cells with a carrier and a primitive under `<`, `>`, `<=`, `+` (number
and string, both orders), `-`, `*`: every one is correct, IR or legacy, for
all 13 carrier values. The one exception is unrelated: `f + 1` prints
`function () { [native code] }` for a function's source text.

### Prototype

In the scratch tree, `__extern_loose_eq` got a prelude: when exactly one
operand is an Object (a non-null `typeof "object"` value or a function) and
the other is neither an Object nor `null` / `undefined`, the Object operand is
replaced by `__to_primitive(operand, default)`; two Objects go to
`__extern_strict_eq`; then the unchanged `__any_from_extern` ×2 + `__any_eq`.
78 added lines in `any-helpers.ts`, no change in `src/ir/`.

| | trap | wrong | correct |
|---|---|---|---|
| main, 625 IR-claimed equality cells | 144 | 33 | 448 |
| prototype | 0 | 2 | 623 |

- The 2 left are `f(o, o)` with `o` an object literal that has a `valueOf` or
  `toString` method: the answer is `false`. Not an equality defect: legacy
  reifies such a struct to a fresh `$Object` at each `any` argument, so the two
  arguments are different objects before the comparison runs. Out of scope,
  see "Not covered".
- Routing is unchanged in every cell (the selector is not touched).

### Impact on ES5 test262 today

133 of the 8,591 compiling ES5 files have a loose equality in the test body
(27 of them IR-only). Run on main and on the prototype: **128 pass and 5 fail
on both**, the same five, all on the eval engine of the measuring box. No ES5
file changes its verdict, in either direction.

So the defect costs no ES5 row today. It costs the levers that depend on it:
#7340's prototype claims `built-ins/String/S15.5.2.1_A1_T3.js` and fails it
without this fix, and passes it with the fix.

```bash
P=<scratchpad>/plan-7194        # scripts/, cases/ and data/ of the measuring session
git archive origin/main src tests scripts package.json tsconfig.json | tar -x -C $P/base   # and $P/head
node $P/scripts/gen.mjs $P/cases                 # 786 cells
python3 $P/scripts/protoB.py $P/head             # the prelude; protoB2.py adds the identity step
bash $P/scripts/runmatrix.sh; bash $P/scripts/run2.sh
python3 $P/scripts/matrix.py                     # the tables above ($P/data/matrix.out)
python3 $P/scripts/impactall.py                  # the 133 ES5 files; verdicts in $P/data/impact-{base,head}.txt
```

## Implementation Plan

### Where the rule lives

In the provider, not in the IR. `__extern_loose_eq` is the one function that
receives both operands as raw carriers after both were evaluated, which is
exactly the input of IsLooselyEqual. from-ast boxes a concrete operand and
calls it (`tryLowerDynamicEq` → `dyn.eq` → `emitLooseEq`), so every IR shape
in the matrix reaches it: one carrier or two, either order, `==` or `!=`.

- The selector and from-ast do not change for the fix. There is nothing to
  keep in agreement: what is admitted today stays admitted and becomes
  correct.
- An IR-side rule ("ToPrimitive the carrier when the other operand is a
  concrete primitive") was prototyped for #7340 and fixes the one-carrier
  cells only. It would be a second definition next to legacy's, and it leaves
  the 48 two-carrier failures. Not taken.

### One definition of the operand conversion

Legacy already has steps 10 to 12, inline, in the externref arm of
`compileTypedBinaryDispatch` (`src/codegen/binary-ops-typed-dispatch.ts`,
the `#1910 R1` block): `typeof_object(l) != typeof_object(r)` → reduce both
with `__to_primitive`, with an explicit `"default"` hint on standalone
(#6774 S19) and the both-i31 fast path (#6973).

That block moves into one emitter and the helper calls it:

```
looseEqualityToPrimitive(ctx, left, right): Instr[]
  if exactly one of left / right is an Object
     and the other is neither an Object nor null / undefined:
       <that operand> = __to_primitive(<that operand>, "default")
```

- **Object** = `__typeof_object(v)` and not null, or `__typeof_function(v)`.
  Legacy's gate tests `__typeof_object` only, so a function operand is never
  reduced and `undefined` on the other side reduces an object it must not
  touch. The shared gate fixes both for legacy as well.
- Only the Object operand is converted. Legacy reduces both and relies on
  `__to_primitive` being the identity on a primitive; converting one is the
  same answer with one call less.
- Two Objects are never converted: identity (step 1). The helper delegates
  that pair to `__extern_strict_eq`, which has the `ref.eq` fast path (#3236:
  `__any_eq`'s tag-5 arm can content-compare two objects). Measured neutral
  on the matrix; it removes the dependence on that arm.

### Module placement

- **`src/codegen/loose-equality-to-primitive.ts` (new)**: the emitter above
  and nothing else. It needs `__to_primitive`, `__typeof_object`,
  `__typeof_function`, `__typeof_undefined` and the `"default"` hint
  constant; it ensures them before any index is captured (the #3219
  discipline `date-reflective-setters.ts` follows).
- **`src/codegen/any-helpers.ts`**: `ensureExternLooseEqHelper` puts the
  emitter in front of its existing body, on the host-free lanes.
- **`src/codegen/binary-ops-typed-dispatch.ts`**: the inline block becomes a
  call of the emitter (S3).
- **`src/ir/`**: nothing in S1. S2 touches
  `analysis/operand-admissibility.ts`, `select-planned-closure-operands.ts`
  and one `case` of `backend/legality.ts`.

### What it reuses

- `__to_primitive` (the object runtime's OrdinaryToPrimitive, with
  `@@toPrimitive`), the `__typeof_*` classifiers, `__extern_strict_eq`,
  `__any_from_extern`, `__any_eq`. No new runtime function, no host import.
- `dyn.eq` and `emitLooseEq` (`src/ir/integration.ts`) unchanged.
- The matrix generator of the measuring session as the test source.

### Duplicates it removes

1. **Legacy's inline reduce block** (`binary-ops-typed-dispatch.ts`, about 35
   lines) becomes a call of the shared emitter.
2. **A second copy of the helper's body.**
   `emitPreparedNativeMapGetEqualityFromStack` (same file) spells
   `__any_from_extern` ×2 + `__any_eq` inline "so the contract does not
   depend on a wrapper being inlined". After S1 that copy would be the one
   loose equality without the conversion. It calls `__extern_loose_eq`.
3. **The containment** (S2): `carrierLooseEqualityAdmissible`, its
   `closure-carrier-loose-equality` refusal, and the WASI-only arm of
   `native-dynamic-loose-equality` go once the helper is correct.

### Slices

Gates for every slice: the 786-cell matrix (0 traps, 0 wrong except the two
reified-struct cells), the 133 ES5 files unchanged, a seeded 300-file sample
of the IR-only ES5 files unchanged in routing and verdict, **0 gc binary
changes**, and the equivalence gate.

**S1: the emitter and the helper. Fixes 144 trapping and 31 wrong cells.**

- Create the module with the exact gate; `ensureExternLooseEqHelper` calls
  it and delegates two Objects to `__extern_strict_eq`.
- Host-free lanes only (`ctx.standalone || ctx.wasi`, or what #7090 leaves
  in their place). In a JS environment the helper keeps today's body: there
  `__to_primitive` and the classifiers are host imports, and a module must
  not gain one.
- Duplicate 2 in this slice: a caller left on the old sequence is a wrong
  answer waiting.

**S2: lift the containment.**

- `native-dynamic-loose-equality` answers for standalone as well as WASI
  (when #7212 is on main, with its `nativeRegimeInJs !== true` condition, so
  the JS environment does not move).
- Delete `carrierLooseEqualityAdmissible` and the
  `closure-carrier-loose-equality` arm; `carrierLooseOperator` stays as the
  lane gate.
- Re-run the #7193 shape (`subject.f = function (m, k) { … if (r == 2) … }`)
  on standalone and WASI, IR against legacy against node.

**S3: legacy reads the same definition.**

- The inline block calls the emitter (duplicate 1). Legacy's answers change
  only for a function operand and for an object against `undefined`; pin
  both with tests first.
- Pin the "standalone legacy, planned member closure" trap of the Problem
  section. It was not reproduced here: legacy is correct in every matrix cell
  it compiles. If it does not reproduce on main, record that and drop it from
  the title.

### Evaluation order

- Both operands are evaluated left to right and boxed before the helper is
  called. The conversion runs inside the helper, so it is always after both
  operand values exist (§13.11.1 evaluates both, then IsLooselyEqual).
- At most one operand is converted, so there is no order between two
  conversions to preserve.
- `__to_primitive` with hint `"default"` runs user code: `@@toPrimitive`,
  then `valueOf`, then `toString` (`toString` first for a Date). A throw
  propagates out of the helper as a catchable exception, and a result that
  is still an object is a TypeError.
- No conversion when the other operand is `null` or `undefined`: the answer
  is `false` and `valueOf` must not run. No conversion for two Objects.
- After the conversion the comparison is `__any_eq`'s, unchanged: number
  against string by ToNumber, boolean by ToNumber, and so on.

### Refusal at selection

Nothing new is refused, and nothing that is refused today is admitted by S1.
Shapes that stay out, with their existing reasons:

- a carrier against a literal `null` under `==` / `!=`:
  `move-only[concrete]` in a function, and `expr-binary-operand-families`
  in `<module-init>` once #7212's `nullishCompare` lands (today it is claimed
  and withdrawn: 18 cells). The helper would answer these correctly, but
  from-ast folds a `null` operand before `dyn.eq`; admitting the fold is its
  own change.
- a fresh wrapper under `==` against a string or another wrapper:
  `expr-wrapper-equality`, unchanged (#7340 revisits it).
- carrier loose equality in a planned closure on a lane without the
  capability: `closure-carrier-helper-operator`, until S2.

### Collisions

- **PR #7212** (#7338) edits `selectorPrimitiveWrapperOrGenericBinary` and
  `binaryOperandFamily` in `select.ts` and adds `nativeRegimeInJs` to
  `legality.ts`. S1 touches neither file. S2 edits one `case` in
  `legality.ts`: land it after #7212 and use its field.
- **#7209 / #7210** (on main) changed compound assignments and write
  identity in `select.ts`; no overlap.
- **#7090** (open) folds the `ctx.standalone` arms. The lane test in S1 is
  one line; rebase it onto whatever name survives.

### Tests to add

`tests/issue-7194.test.ts`, standalone and WASI, IR and `experimentalIR:
false`, each row against node's answer:

- the matrix, as a table-driven test: the 13 carrier values against the 9
  literals and the 7 second carriers, `==` and `!=`, both orders;
- `valueOf` that throws: the error surfaces, and it does not run against
  `null`, `undefined` or another object;
- `valueOf` returning an object and `toString` returning a primitive (the
  second is used); both returning objects is a TypeError;
- an object with `@@toPrimitive`; a Date against its string;
- `<module-init>`: `var o = {}; o == 1`, `o == "[object Object]"`,
  `o != true`;
- S2: the #7193 planned-closure shape on both lanes;
- the gc lane: a binary-hash row showing the helper's bytes unchanged.

### Acceptance criteria

Correctness:

- Every equality cell of the matrix answers as node on standalone, IR and
  legacy, except the two reified-struct identity cells, which are listed with
  their reason.
- The same on WASI for the cells WASI can run.
- The 133 ES5 files with a loose equality and the 300-file IR-only sample
  keep routing and verdict.
- JS-environment binaries byte-identical on the playground examples and the
  133 files.
- After S2 the string-only rule and its refusal are gone, with the #7193
  shape passing on both lanes.
- ES5 is a completed edition: no ES5 row may regress in the merge group.

Code quality:

- One definition of steps 10 to 12 in `src/`: the new module. No
  `__to_primitive` call for loose equality remains in
  `binary-ops-typed-dispatch.ts`, and no inline `__any_from_extern` ×2 +
  `__any_eq` sequence outside `ensureExternLooseEqHelper`.
- `binary-ops-typed-dispatch.ts` ends smaller than it starts.
- No change in `src/ir/select.ts` or `src/ir/from-ast.ts`.
- No loc or func budget grant; `check:dead-exports` clean after S2.

## Risks and unverified assumptions

- **WASI was not run.** The prototype's lane test includes it, the
  measurements are standalone only.
- **The JS-environment lane was not measured.** Whether it has the same
  trap is unknown. It keeps today's helper body by design; if it traps too,
  that is a separate decision, because the fix there needs host imports.
- **The hint.** The prototype passed a null hint; legacy passes the string
  `"default"` on standalone (#6774 S19, Symbol results). The plan takes
  legacy's. Not re-measured with it.
- **The i31 fast path** (#6973, `unlessBothI31`) wraps legacy's block. The
  helper's operands are externref carriers; whether the same skip applies was
  not checked. Keep it at the legacy call site only unless it measures as a
  win.
- **Index stability.** The prototype ensures the object runtime and reads
  the four function indices inside `ensureExternLooseEqHelper`. It worked on
  every compile of the matrix and the 133 files; the late-import discipline
  was not audited.
- **`__any_eq` reached without the helper.** Legacy's `any == any`
  (`emitLooseEq` in `coercion-engine.ts`) boxes to `$AnyValue` and calls
  `__any_eq` directly. No matrix cell compiled that way was wrong, but the
  matrix has no legacy two-`any` function. If S3 finds one, route it through
  `__extern_loose_eq` as #3236 routed the strict case.
- **Cost.** Four classifier calls per carrier loose equality. Not measured.

## Not covered

- An object literal with a `valueOf` or `toString` method passed twice as an
  `any` argument is two different objects (`f(o, o)` with `c == d` is
  `false`, on main and with the fix). The identity is lost at the call
  boundary, where legacy reifies the struct per argument. Not filed.
- `Function.prototype.toString` answers `function () { [native code] }` for
  a source function.
- Loose equality against a literal `null` in the IR (above).
- The JS-environment lane.

## Acceptance (original, 2026-10-29)

- The carrier loose-equality helper ToPrimitives an object / array operand
  (hint "default") before the primitive comparison, on standalone and WASI.
- IR = legacy = node on objects with `valueOf` / `toString`, arrays, and
  primitives across types.
- Once that holds, admit standalone and drop the string-only rule in
  `carrierLooseEqualityAdmissible`, with tests.
