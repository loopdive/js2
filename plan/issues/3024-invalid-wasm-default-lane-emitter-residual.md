---
id: 3024
title: "codegen: invalid Wasm binary emission residual — default (JS-host) lane (~131 fails, externref/f64 type-mismatch emitter bugs)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: codegen-correctness
goal: correctness
test262_category: language/expressions/object/dstr, built-ins/AsyncFromSyncIteratorPrototype, language/expressions/in
test262_ce: 131
related: []
---

# #3024 — invalid Wasm binary emission residual (default lane)

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). **131**
official tests compile to a Wasm module that fails validation. Unlike the
several `standalone-invalid-wasm-*` issues already tracked (#2039, #2878,
#2934 — all standalone-target-specific), this bucket is on the **default
`gc` target**, so it's a distinct residual not covered by those.

## Breakdown by validator error

| reason | count |
|---|--:|
| `call[N]` expected `(ref null T)`, found other | 14 |
| `struct.new` — not enough args | 11 |
| `local.set` expected `(ref null T)` | 7 |
| `fN.ne`/`fN.trunc` expected `fN`, found `externref` | 13 (7+6) |
| `array.set` type error inside `__vec_from_extern` | (part of remainder) |
| other/remainder | ~76 |

Failing function names cluster around `test` (64 — top-level test body),
`testCompoundAssignment` (11), `__closure_*` (async-gen closures),
`__vec_from_extern_*`, `__obj_meth_tramp_*` (object-method trampolines).
Root cause is an externref-vs-f64/ref-null type mismatch at emit time in (a)
async-generator destructuring, (b) compound assignment operators, (c) the
"vec from extern" array-materialization helper.

## Sample failing files

- `language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-ary-elision.js`
- `built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
- `language/expressions/in/private-field-rhs-non-object.js`

## Suggested approach

1. Start with `testCompoundAssignment` (11 fails, single named function) —
   smallest, most concentrated sub-bucket; likely one type-coercion bug in
   compound-assignment codegen (`x += y` where `x`/`y` cross the
   externref/f64 boundary).
2. `__vec_from_extern_*` `array.set` type errors — check the element-type
   assumed by the array-materialization helper against the actual value
   representation of the source (likely a boxed-any vs. typed-element
   mismatch, similar in shape to the already-fixed #2379
   `new-array-n-boxed-any-elem-rep`).
3. Async-gen destructuring `__closure_*` failures — trace one repro through
   `-O0` unoptimized output (`--target gc` with binaryen disabled) to see
   the exact instruction sequence at the reported `call[N]`/`local.set` site.

## Acceptance criteria

- `wasm-validate`-class compile errors on the default `gc` target drop
  materially below the 131 recorded here.
- No regression in the standalone-lane invalid-Wasm counts (#2039/#2878/#2934)
  — this issue is scoped to the default target only.

---

## Banked root-cause: the `testCompoundAssignment` / numeric-operator sub-bucket (sr-interp, 2026-07-03)

Measure-first reduction of the **11-fail `testCompoundAssignment`** cluster (and,
by shared mechanism, the **`fN.ne`/`fN.trunc` expected fN found externref** rows,
13). Verified on default `gc` lane (`compile(src, {})`, `WebAssembly.compile`).

### Minimal repro (default gc lane → invalid Wasm)
```ts
export function test(): number { var x = 3; x = x * eval("var x = 2;"); return x; }
// → f64.mul[0] expected type f64, found local.tee of type externref
```
`x *= eval("var x = 2;")` fails identically (compound-assign desugars to `x = x * …`).

### Discriminators (why the bucket is narrow — all verified)
| variant | result |
|---|---|
| `x * eval("var x = 2;")` (same-name var-declaring eval) | **INVALID** |
| `x * eval("var y = 2;")` (different name) | VALID |
| `x * eval("2")` (eval, no var-decl) | VALID |
| `x += eval("var x = 2;")` (`+` / `+=`) | VALID |
| `eval("var x = 2;"); x *= 4;` (eval as separate stmt) | VALID |
| `x * e()` where `e():any` (any RHS, no eval) | VALID |

So the trigger is precisely: a **non-strict direct `eval` that declares a `var` of
the SAME name** as a numeric local used as an operand of a **numeric-only**
operator (`*`,`-`,`/`,`%`; unary `fN.ne`/`fN.trunc`). `+`/`+=` is immune (its
string-or-number lowering coerces the operand); a separate-statement eval is
immune (only the operand of the SAME expression is mis-typed).

### Root cause (representation vs static-type DESYNC)
`eval("var x = …")` promotes the binding `x`'s **slot** to `externref` (the
dynamic / eval-reachable representation, so the eval can read/redefine it), while
the TS checker still types `x` as `number`. The numeric-operator codegen emits a
raw `local.get`/`local.tee` of the externref slot but treats the operand as `f64`
(its static type), so **no `externref → f64` coercion is inserted** and it bakes
`f64.mul`/`f64.ne`/… directly on an externref → `expected fN, found externref`.

### Fix LOCATION (verified by elimination — turnkey)
- **NOT `compileBinaryNumeric`** (binary-ops.ts ~156): it `return null`s on the
  `any` guard (L169) because the eval RHS is typed `any`, so the multiply is NOT
  emitted there. I applied the slot-type-trust fix there and it did **not** change
  the repro — confirming the emit is elsewhere. (Reverted; do not re-attempt there.)
- **The emit is in the general `compileBinaryExpression`** (binary-ops.ts ~254,
  the mixed `number × any` arithmetic path — note the pre-existing "the receiver
  `id` is typed `number`/`any`, so the operand's *TS* type…" desync comment at
  ~L1141). The fix mirrors the **`in`-operator precedent** (binary-ops.ts
  ~L605-618, "Trust the ACTUAL slot type: if the receiver is an identifier whose
  local slot is externref/anyref…"): before emitting the numeric op, if an
  identifier operand's **actual** `fctx` slot type is `externref`/`anyref` (even
  though its TS type is `number`), route it through the existing
  `externref → f64` coercion (`coerceType(…, {kind:"f64"}, "number")`).

### Blast radius (why this is banked, not landed, at 4% budget)
This is a **shared desync class**, not one operator: the same "static type says
`number`, slot is `externref` (eval-promoted / dynamically boxed)" mismatch is the
likely root of the issue's other rows — `fN.ne`/`fN.trunc` externref (13),
`local.set expected (ref null T)` (7), and possibly `call[N] expected (ref null T)`
(14). A root fix (make identifier compilation report the true slot type, or coerce
at every numeric consumer) would clear multiple buckets but is **broad-impact
codegen** requiring full test262 CI validation — not safe to land + verify at 4%
budget. Banked as a turnkey next step; the `in`-operator precedent makes the
localized `compileBinaryExpression` fix low-risk for a fresh window.

### Not started (roll forward)
- The `__vec_from_extern_*` `array.set` bucket and async-gen `__closure_*` buckets
  (issue's approach steps 2–3) are un-investigated here.

---

## Landed: eval-var-promotion numeric-operand desync (dev-selfserve-1, 2026-07-04)

**PR:** `issue-3024-numeric-slot-desync` — fixes the `testCompoundAssignment` /
numeric-operator eval sub-cluster (the `x op eval("var x = …")` shape).

### The banked "trust slot type at the numeric path" fix is UNSAFE — disproven
The sr-interp banked plan (mirror the `in`-operator precedent: at the numeric
emit, if an identifier operand's slot is externref, coerce) **cannot work as
written**. Instrumentation on current `main` shows both the failing case
(`x * eval("var x = 2;")`) and the passing control (`x * eval("var y = 2;")`)
report `leftType = f64` at the numeric path, and in BOTH the slot is externref
by the time the op emits. So slot-kind + reported-type at the emit point does
**not** discriminate a stale-boxed operand from a genuinely-unboxed f64 — a naive
"slot is externref ⇒ coerce" would double-unbox the already-correct unbox that
`compileIdentifier` emits for a `number`-narrowed externref local.

### True root cause (verified by WAT diff + `compileIdentifierCore` instrument)
It is a **timing / mid-expression slot-promotion** bug, not a numeric-path bug:
1. `x` starts as an `f64` local. In `x * eval("var x = 2;")`, the LEFT operand
   `x` compiles first → emits a raw `local.get` of the f64 slot, no unbox.
2. The RIGHT operand `eval("var x = 2;")` is a constant string, so
   `tryStaticEvalInline` inlines the body. Compiling the inlined `var x = 2`
   (a foreign `ts.createSourceFile` node the checker cannot type ⇒ `wasmType`
   resolves to `externref`) hits the re-declaration re-type at
   `statements/variables.ts` (~L1071–1072) and **flips `x`'s slot f64 → externref**.
3. The already-emitted `local.get` now loads an externref, feeding `f64.mul`/
   `f64.sub`/… → `expected fN, found externref`. Compound `x *= …` is worse: the
   pre-RHS `local.get` (no coerce) AND the post-op `local.tee` (f64 into an
   externref slot) are both invalidated.

### The safe fix (byte-inert, proven)
Detect the **primitive→externref slot flip across operand compilation** by
snapshotting the identifier operand's slot kind before compiling and comparing
after — a flip only ever happens on this eval-redeclaration path, so ordinary
code is untouched.
- `src/codegen/binary-ops.ts` (`compileBinaryExpression`): snapshot
  `leftSlotBefore`/`rightSlotBefore`; if an operand flipped primitive→externref,
  re-label its type `externref` so the existing numeric externref-unbox path
  (~L2255) inserts the coercion.
- `src/codegen/expressions/assignment.ts` (`compileCompoundAssignment`, local
  path): re-read the slot after the RHS; on a flip, unbox the buried left
  operand (save RHS / coerce left / restore RHS) and switch the writeback to the
  externref re-box path.

**Proofs:** repro + discriminators pass (`x*`, `x*=`, `x-`, `x/` eval-redeclare
→ VALID; `var y` / `eval("2")` / plain arithmetic controls unchanged); runtime
output matches Node (NaN/NaN, 21/21); inject-throw shows each guard fires ONLY on
its promotion case and on NO control; a 10-program corpus (arithmetic, compound,
loops, strings, objects, any, bitwise, for-of) is **byte-identical** (sha256) to
`origin/main`; `issue-2923`, `compound-assignment-property/-unresolvable`,
`issue-2045` suites (38 tests) pass.

### Still open (roll forward — NOT this PR)
- `{} << 0` / non-object numeric operands (`private-field-rhs-non-object.js`) —
  a DISTINCT root cause (object left operand of a shift, no eval involved).
- `__vec_from_extern_*` `array.set`, async-gen `__closure_*`, `struct.new` arg
  count. The 131 bucket has multiple independent root causes; this PR clears the
  eval-redeclaration numeric/compound sub-cluster only.

## Investigation (2026-07-05, dev-3023) — `struct.new (need N, got N-1)` sub-cluster

Isolated the largest identifiable remaining sub-cluster (9 files, one root
cause): **nested object binding pattern WITH a default value** —
`*-obj-ptrn-prop-obj.js` across `var`/`let`/`const`/`for`/`function`/
`generators`/`async-generator` dstr. Minimal untyped repro (compiles to
invalid Wasm — `struct.new (need 3, got 2)`):

```ts
const { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } };
```

Isolation matrix (confirmed against current main, `skipSemanticDiagnostics`):
- `{ w = {x:4,y:5,z:6} }` (default, **no nesting**) → OK.
- `{ w: {x,y,z} }` (nested, **no default**) → OK.
- `{ a = {x:4,y:5,z:6} }` (3-field literal default, no nesting) → OK.
- ONLY `{ w: <object-pattern> = <object-literal-default> }` fails (both 3- and
  2-field defaults).

**Root cause** (retro-patch coverage gap, `#2544`-class): the RHS property value
`{x:undefined, z:7}` is compiled FIRST and registers the anon struct with its 2
present fields `{x, z}`; the nested default `{x:4,y:5,z:6}` then unifies into the
SAME anon-struct family and **appends the missing field `y`**, growing it to 3
fields `{x, z, y}`. Growing a struct fires `patchStructNewForAddedField`
(`src/codegen/expressions/late-imports.ts:716-814`) which must retro-pad every
already-emitted `struct.new` of that type with a default for the new field — but
the failing `struct.new` sits in a buffer the walk does not reach (the walk
covers `ctx.mod.functions` + `fctx.body` + `fctx.savedBodies` + `ctx.liveBodies`
(added by #2544), yet this repro still fails, so a buffer is still uncovered OR
the growth happens after the patch pass). Emission sites:
`destructureParamObject` (`src/codegen/destructuring-params.ts:1089-1116`,
default at `:1102-1110`) → `emitNestedBindingDefault`
(`src/codegen/statements/destructuring.ts:453-527`, detached `if.then` buffer via
`collectInstrs` at `:464-470`) → `compileObjectLiteralForStruct`
(`src/codegen/literals.ts:1717`, `struct.new` at `:2208`).

NOT attempting a blind fix here — retro-patch coverage is subtle and a mis-fix
risks silent operand corruption. Needs a targeted trace of which buffer holds
the short `struct.new` at growth time and why the `patchStructNewForAddedField`
walk misses it (candidate: register the `emitNestedBindingDefault` detached
buffer into the patch's traversal set, or defer the field-growth until after the
struct.new is spliced into `fctx.body`). Related fixed siblings: #2544, #2565,
#2587.
