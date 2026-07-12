---
id: 3024
title: "codegen: invalid Wasm binary emission residual — default (JS-host) lane (~131 fails, externref/f64 type-mismatch emitter bugs)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-11
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
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
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

| reason                                              |               count |
| --------------------------------------------------- | ------------------: |
| `call[N]` expected `(ref null T)`, found other      |                  14 |
| `struct.new` — not enough args                      |                  11 |
| `local.set` expected `(ref null T)`                 |                   7 |
| `fN.ne`/`fN.trunc` expected `fN`, found `externref` |            13 (7+6) |
| `array.set` type error inside `__vec_from_extern`   | (part of remainder) |
| other/remainder                                     |                 ~76 |

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
export function test(): number {
  var x = 3;
  x = x * eval("var x = 2;");
  return x;
}
// → f64.mul[0] expected type f64, found local.tee of type externref
```

`x *= eval("var x = 2;")` fails identically (compound-assign desugars to `x = x * …`).

### Discriminators (why the bucket is narrow — all verified)

| variant                                                 | result      |
| ------------------------------------------------------- | ----------- |
| `x * eval("var x = 2;")` (same-name var-declaring eval) | **INVALID** |
| `x * eval("var y = 2;")` (different name)               | VALID       |
| `x * eval("2")` (eval, no var-decl)                     | VALID       |
| `x += eval("var x = 2;")` (`+` / `+=`)                  | VALID       |
| `eval("var x = 2;"); x *= 4;` (eval as separate stmt)   | VALID       |
| `x * e()` where `e():any` (any RHS, no eval)            | VALID       |

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
  `id` is typed `number`/`any`, so the operand's _TS_ type…" desync comment at
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

---

## Landed: nested-object-destructuring shared-struct `struct.new` sub-cluster (dev-3024, 2026-07-04)

**PR:** `issue-3024-dstr-nested-objlit-structnew` — clears the `struct.new` "not
enough arguments" cluster (9 test262 files) whose shape is a nested object
pattern with an object-literal default, e.g.
`const { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: undefined, z: 7 } }`.

### Root cause (orphaned buffer misses the field-pad patch — verified by instrument)

An anonymous struct registered for the RHS (or param OUTER-default) **sub-object**
`{ x, z }` (2 fields) is later **grown** to 3 fields by the nested pattern's
DEFAULT literal `{ x, y, z }`: both resolve to the SAME `__anon_N`, and when the
larger default compiles, `ensureComputedPropertyFields` (literals.ts) appends the
missing field `y` and calls `patchStructNewForAddedField` to pad every already-
emitted `struct.new` of that type with a default operand.

That pad walks only `mod.functions` + `fctx.body` + `fctx.savedBodies` +
`ctx.liveBodies`. The RHS/param-default `struct.new` sits in an **orphaned outer
body** — swapped off `fctx.body` by a plain JS-local swap that never lands on
`savedBodies` (the destructure helpers descend into detached branch buffers to
compile the nested default). So the pad could not reach it and left it one operand
short of the grown 3-field type → `struct.new (need 3, got 2)` invalid Wasm.
Instrumentation confirmed `reach=0, orphanBufs=1, saved=2, live=0` at patch time.

Same bug **class** as the #2503 / #2158 / #779d param-branch late-shift fixes, but
for the field-pad patch and for the **outer** destructuring/param-default body.

### Fix (register the orphaned body in `ctx.liveBodies` for the destructure window)

Byte-inert, mirrors the existing `liveBodies` precedents. Three call-sites, each
registering the current (outer-materialization-holding) `fctx.body`/`liftedFctx.body`
around the destructure that compiles the nested default, then removing it:

- `src/codegen/statements/destructuring.ts` (`compileObjectDestructuring`) — the
  variable-declaration path (`const/let/var/for` object destructuring).
- `src/codegen/function-body.ts` — top-level function-declaration params.
- `src/codegen/statements/nested-declarations.ts` (both param loops) — hoisted /
  nested function declarations (covers the `function`/`generators`/`async-generator`
  `dflt-obj-ptrn-prop-obj` cases, which route through `compileNestedFunctionDeclaration`).

### Proofs

- Repro + discriminators VALIDATE (`WebAssembly.compile`): `x`-only, `default-fires`,
  `full-object-bypass` all VALID; the `rhs-has-all3` / `default-2fields` controls
  were already valid and stay valid.
- **All 9 real test262 files PASS end-to-end** via `runTest262File` (oracle-checked,
  not merely valid): `{const,let,variable}/dstr/obj-ptrn-prop-obj`,
  `for/dstr/{const,let,var}-obj-ptrn-prop-obj`,
  `{function,generators,async-generator}/dstr/dflt-obj-ptrn-prop-obj`.
- Full 198-file default-lane invalid-Wasm harvest re-run: **STILL-invalid 113 → 104**
  (net −9, exactly this cluster), **zero new invalid signatures**.
- **Byte-identical** (sha256) output vs base across a 14-program corpus (plain /
  default / nested / param destructuring, arrays, classes, strings, closures,
  for-of, spread, optional-chaining) — the fix only toggles `liveBodies` around the
  destructure and is a no-op for code that does not grow a shared struct.
- 71 adjacent destructuring/param unit tests pass (default-params, issue-1025/1128/
  1553a/b/c/1372, fn-param-dstr-rest, class-dstr-rest, generator-method-dstr) plus
  the new `tests/issue-3024.test.ts` (4 tests).

### Still open (roll forward — NOT this PR)

- The remaining ~104 default-lane invalid-Wasm files are scattered across ~40
  distinct signatures (mostly singletons): `f64.local.tee`/`externref.local.get`
  numeric/eval residue, `__cb_0` / `Parent_new` / iterator-close shapes, the
  `Array.from` source-object-iterator pair, `class super in-static-methods`,
  `AsyncFromSyncIteratorPrototype`. These are independent root causes tracked under
  this same issue; this PR clears the largest _concentrated_ remaining cluster only.

---

## Fresh measurement + banked root-cause (opus-3024, 2026-07-06)

Re-harvested the 214 stale-cache invalid-Wasm candidates against **current
`origin/main`** via `runTest262File` (default gc lane, oracle path). **The stale
cache badly overstates** — the two biggest cache clusters are already fixed on
main and must NOT be re-chased:

- `extern.convert_any expected shared anyref, found array.get` (cache 53) — now
  mostly **Temporal `skip`** (not a real default-lane floor loss).
- `struct.new expected f#, found ref.as_non_null of type (ref N)` (cache 34) — the
  `object/dstr` array-pattern method-destructuring family; on current main these
  **compile validly** (now `pass` or plain oracle-fail), cleared by #2666 + follow-ons.

### Actual current-main residual: **102 files across ~40 signatures, largest 7**

No concentrated cheap slice remains. Top real signatures (function `test` dominates, 54):

| reason (numbers normalised)                                      |                       count |
| ---------------------------------------------------------------- | --------------------------: |
| `call[#] expected (ref null #)` (loose group, mixed root causes) |                          12 |
| `fN.ne expected fN, found local.tee of type externref`           |                           7 |
| `array.set expected i#, found call of externref`                 |                           4 |
| `array.set expected externref, found local.get of f#`            |                           4 |
| `call expected fN, found if of (ref null #)`                     |                           4 |
| `struct.set expected (ref null #)`                               |                           4 |
| `call expected externref, found ref.func of (ref #)`             |                           4 |
| `type error in fallthru (expected externref, got (ref null #))`  |                           4 |
| `call expected externref, found fN.mul of fN`                    |                           4 |
| everything else                                                  | ≤3 each (mostly singletons) |

### The largest real cluster (`fN.ne`, 7) is the #2657 family — CROSS-STATEMENT variant

All 7 are `language/line-terminators/S7.3_A7_T1..T7`. Despite the `line-terminators`
name, the trigger is the **eval-var-promotion desync of #2657**, in the variant
#2657 explicitly left open ("separate-statement eval → thought immune"):

Minimal repro (default gc lane → INVALID; `f64.ne[0] expected f64, found local.tee externref`):

```ts
function test() {
  var y = 2,
    z = 3;
  var x = y + z;
  if (x !== 5) throw 1; // fN.ne read of x's slot emitted HERE (f64)
  eval("var x = y+z; r=x;"); // LATER stmt: inlined var x re-decl flips x slot f64→externref
}
test();
```

Discriminators (verified): plain `var x` redeclaration (no eval) → VALID; eval with
no prior `var x`+`x!==5` → VALID; top-level (unwrapped) → VALID (only fails inside the
harness `test()` fn, where `x` is a function local). So the precise trigger is: a
**function-local numeric `var x`** consumed by a numeric-only op (`fN.ne`/`!==`), then a
**later** direct `eval("var x = …")` whose static-inline re-declaration
(`statements/variables.ts` ~L1071 re-type) flips the shared hoisted slot to externref,
**retroactively invalidating the already-emitted f64 read in the earlier statement**.

### Why banked, not landed (blast radius; no bounded byte-inert slice exists)

#2657's landed fix is a **within-expression** before/after slot snapshot — it cannot
cover this case because the flip happens in a _later statement_ than the read, so
there is no consumer-side "after" to snapshot. The only fixes are (a) suppress the
spurious f64→externref downgrade at the redeclaration re-type when the inlined
initializer is statically numeric (an _untypeable foreign AST node_ ≠ a genuinely
dynamic binding), or (b) a post-emit patch that re-coerces prior reads when a slot
flips. **Both are broad-impact codegen** and (a) directly touches the promotion
contract #2657 _relies on_ (its coercion depends on the flip firing) — so it needs
full test262 CI, not a low-budget land. Turnkey next step for a fresh window:
option (a) in `src/codegen/statements/variables.ts` (redeclaration re-type), gated
to "existing slot is concrete numeric AND new type is externref _only_ via
untypeable-node fallback", validated against the #2657 suite + these 7 files.

Everything below the top cluster is ≤4 files/signature — genuine independent
singletons (iterator-close `__cb_N`, `__vec_from_extern` element-rep, async-gen
`__closure_N`, `Parent_new` super-in-ctor, `__obj_meth_tramp_*_valueOf`), each its
own root cause. No cheap concentrated default-lane slice exists at this point;
future work on #3024 is per-root-cause, not per-cluster.

---

## Landed: inc/dec element write-back rep coercion + `__vec_from_extern` i64 arm (fable-wasm, 2026-07-11)

**Fresh measurement (2026-07-11, current main, `runTest262File` over the 214
stale-cache candidates): 86 still-invalid** (opus-3024's 102 had drifted down
further via unrelated merges). This slice clears the two `array.set`
element-rep clusters (8 files, all prefix/postfix-inc/dec) → **78 remain**,
zero new invalid signatures.

### Root cause 1 — inc/dec vec write-back stores the raw numeric local

`compileMemberIncDec` vec arm (`src/codegen/expressions/unary-updates.ts`):
the READ coerces `elemType → f64`, but the WRITE-BACK passed the raw
f64/i32 `newTmp` local to `emitBoundsGuardedArraySet` with **no
f64→elemType coercion**. On an externref-element array (`arguments[i]++`,
`any[]` element inc/dec) the emitted `array.set` got
`expected externref, found local.get of type f64` — the `testcase`
cluster (`11.3.1-2-3` / `11.3.2-2-3-s` / `11.4.4-2-3-s` / `11.4.5-2-3-s`,
4 files, now **pass** end-to-end). Fix: route the new value through
`coerceType({kind:numType} → elemType)` into a properly-typed store local
(`makeStoreLocal`); also widen a non-fast i32 element read via
`f64.convert_i32_s` before the f64 arithmetic (same desync, read side).
Byte-inert when `elemType === numType` (the only previously-valid shapes).

### Root cause 2 — `buildElemCoerce` had no i64 arm

`buildVecFromExternref` (`src/codegen/type-coercion.ts`): BigInt (i64)
element arrays fell through to the empty terminal case, leaving the
externref element on the stack where the i64 `array.set` expects an i64 —
the `__vec_from_extern_*` cluster (prefix/postfix-inc/dec `bigint.js`,
4 files, now **valid Wasm**; runtime BigInt semantics remain #1349-gated
so they are plain oracle-fails, not compile errors). Fix: i64 arm —
`__to_bigint` when registered (§7.1.13 ToBigInt, precision-preserving),
else `__unbox_number` + `i64.trunc_sat_f64_s`, else drop/`i64.const 0`.

### Proofs

- Repro probes: `arguments[1]++/--/++prefix`, `any[]` inc/dec, `[0n]`
  element inc/dec all VALID (were INVALID); controls unchanged.
- All 4 `testcase`-cluster test262 files **pass** via `runTest262File`;
  all 4 bigint files validate (fail only on BigInt semantics).
- Full 214-candidate re-harvest: 86 → **78**, exactly the 8 target files,
  no new signatures.
- 12-program corpus (arrays, loops, obj-prop/local inc-dec, strings,
  closures, classes, for-of, typed-i32-fast, compound-elem, nested-dstr)
  **byte-identical** (sha256) to current main.
- New `tests/issue-3024-incdec-element.test.ts` (8 tests) passes; adjacent
  suites (issue-3024, 1720, 2656, 2666, 2675, 2831, 1135, 2162b — 61
  tests) show zero NEW failures (the 2 fails are pre-existing on main,
  verified by control runs).

### Still open (roll forward)

The remaining 78 are the scattered per-root-cause singletons listed above
(largest: the 7-file `fN.ne` cross-statement eval-promotion family — banked,
broad-impact, needs a full-CI window; then the 6-file `object/dstr`
`meth-ary-ptrn-(rest-)elision` `call[#] expected (ref null #), found f#`
cluster).

---

## Landed: capturing-fn call after method capture promotion (fable-wasm, 2026-07-11, slice 2)

**PR:** `issue-3024-promoted-capture-call` — clears the 6-file `object/dstr`
`{meth,gen-meth,async-gen-meth}-ary-ptrn-(rest-ary-)elision` cluster
(`call[#] expected (ref null #), found local.get of type f#` in `test`).
Post-slice-1 harvest: 78 → **72**, zero new signatures.

### Root cause (stale `boxedCaptures` branch after #3121 promotion)

The trigger is NOT destructuring: it is a local that is (a) closure-MUTATED by
a nested function (boxed to a ref cell, `fctx.boxedCaptures`) and (b) also
referenced by an object-literal METHOD. Compiling the object literal runs the
accessor/method capture promotion (#2029/#3039/#3121, `closures.ts`): the
shared cell is aliased into a module global (`ctx.capturedBoxGlobals`) and the
`localMap` binding is DELETED (closures.ts ~L609) so post-promotion enclosing-
function code routes through the global. But the direct-call capture-prepend
(`compileCallExpression`, calls.ts ~L15260) checked `boxedCaptures` FIRST and
resolved `fctx.localMap.get(name) ?? cap.outerLocalIdx` — the stale pre-boxing
RAW f64 slot — baking `local.get <f64>` where the callee signature expects the
ref cell. The correct `capturedBoxGlobals` arm existed (#2029 family A) but was
unreachable behind the `boxedCaptures` branch.

Verified by instrument: at the `g2()` call, `localMap=undefined boxed=true
boxGlobal=true` → fallback to `cap.outerLocalIdx` (the raw f64).

### Fix (calls.ts, narrow)

Before the `boxedCaptures` branch: when `localMap.get(cap.name)` is undefined
AND `ctx.capturedBoxGlobals` has the name, source the SAME shared cell from
the promotion global (`global.get` + `ref.as_non_null`). Live write-through is
preserved — the callee mutation, the method body, and the enclosing function
all share one cell (proven at runtime: g2 `+=1` → method reads 1 → method
`+=10` → enclosing reads 11). The old fallback in this configuration was
ALWAYS invalid Wasm, so no valid module changes shape.

### Proofs

- 13 discriminator probes VALID (generator/non-generator mutator, normal and
  destructuring method params, elision/binding patterns); all previously-valid
  controls unchanged.
- test262: 3 of the 6 files now **pass** end-to-end
  (`*-rest-ary-elision.js`); the 3 `*-ptrn-elision.js` flip CE→plain fail on a
  DISTINCT bug (the param-elision destructure advances the iterator twice —
  `assert.sameValue(second, 0)` fails; see roll-forward below).
- Full 214-candidate re-harvest: 78 → **72**, exactly this cluster, no new
  signatures.
- 12-program corpus **byte-identical** (sha256) to main.
- New `tests/issue-3024-promoted-capture-call.test.ts` (5 tests, runtime
  write-through assertions) passes; adjacent promotion suites (issue-3121,
  issue-3039, issue-2029-tagged-template-capture-local-index,
  issue-3024-incdec-element — 30 tests) pass.

### Still open (roll forward)

- **NEW (distinct root cause):** array-binding-pattern ELISION in a method
  param over-steps the iterator (one extra IteratorStep) — turns the 3
  `*-ptrn-elision.js` files into semantic fails now that they validate.
- The remaining 72 invalid-Wasm files: 7-file `fN.ne` cross-statement
  eval-promotion family (banked, broad-impact), then ≤4-file singletons
  (`__obj_meth_tramp_*_valueOf`, `struct.set (ref null #)`, `call expected
externref found ref.func`, Atomics `__cb_#` fallthru, `i#.lt_s` …).

---

## Landed: static-method-named-`constructor` as a value (fable-wasm, 2026-07-11, slice 4)

**PR:** `issue-3024-static-ctor-genmeth` — clears the 4-file
`grammar-static-ctor-{gen,async-gen}-meth-valid` cluster
(`language/{expressions,statements}/class/elements/syntax/valid/`;
`call[N] expected externref, found ref.func of type (ref M)` in `test`).

### Root cause (funcref through `extern.convert_any`)

A class may declare a STATIC method literally named `constructor`
(`static * constructor() {}` — legal ES, distinct from the instance
constructor). Reading it as a value (`C.constructor`, e.g. the harness'
`assert.notSameValue(C.prototype.constructor, C.constructor)`) must box it like
any other static method: a closure struct → `extern.convert_any` (the
`emitFuncRefAsClosure` arm at property-access.ts ~5005). But the
`ClassName.constructor` arm (property-access.ts ~4980) fired FIRST and took a
raw path — `ref.func <C_constructor>` + `extern.convert_any`. A funcref is NOT
in the anyref hierarchy, so `extern.convert_any` on a funcref is invalid, and
the invalid value surfaced at the CONSUMER as `call[N] expected externref,
found ref.func of (ref M)`.

### Fix (property-access.ts)

Guard the raw ctor-ref arm with `&& !ctx.staticMethodSet.has(fullName)` so a
class that owns a static `constructor` method falls through to the
static-method closure arm (correct funcref → closure-struct → externref
boxing). Plain classes (no static `constructor`) are unaffected — byte-inert.

### Proofs

- Repro (`sink(C.constructor)` with `static * constructor`) VALIDATES; plain-class
  `C.constructor` and ordinary static-method-value controls unchanged.
- All 4 target test262 files flip CE → valid Wasm (they now fail only on a
  distinct `C.prototype.hasOwnProperty('constructor')` semantic, not a compile
  error).
- Full 214-candidate re-harvest: the 4 `ref.func` files cleared, zero new
  invalid signatures (72 → 68 on the slice-1+2 base).
- 12-program corpus **byte-identical** (sha256) to main.
- New `tests/issue-3024-static-ctor-method-value.test.ts` (4 tests); adjacent
  class-static-method suites (issue-1394, 2933-reflect-static-method-value,
  3133-instance-constructor-identity, 846-class-static-prototype, 2587,
  test262-runner-static-gen-yield — 51 tests) pass. The class-elements-619
  failures are PRE-EXISTING on main (verified by control run).
- `loc-budget-allow` granted for `property-access.ts` (#3131; +11 net).

### Still open (roll forward)

The remaining invalid-Wasm files: the banked 7-file `fN.ne` cross-statement
eval-promotion family (broad-impact) and ≤4-file per-root-cause singletons
(`struct.set (ref null #)`, Atomics `__cb_#` fallthru, `i#.lt_s`,
`__vec_from_extern` element-rep, async-gen `__closure_#`).

---

## Landed: anon object-literal method stable-handle pre-mint (fable-wasm, 2026-07-11, slice 3)

**PR:** `issue-3024-anon-method-stable-handle` — clears the 4-file
`__obj_meth_tramp_*_valueOf` cluster (`built-ins/Array/prototype/{pop,push,
shift,unshift}/S15.4.4.x_A2_*`; `call[0] expected externref/f64, found if of
type (ref null N)` in the trampoline). Harvest: 4 files flip CE → valid Wasm
(they now fail only on a distinct ToPrimitive/array-like-receiver semantic, not
a compile error).

### Root cause (live-regime pre-mint during the declaration scan)

`ensureStructForType` (index.ts) pre-mints an anonymous object-literal method's
defined function with the LIVE-REGIME index `numImportFuncs + functions.length`.
That pre-mint runs during the DECLARATION SCAN — reached via the
`collectEmptyObjectWidening` / `collectGrowableObjectLiterals` pre-passes'
`resolveWasmType` — which is BEFORE the import collectors run. When a later
collector (`collectUsedExternImports`, or the native-string/union import passes)
prepends an `env` import via raw `addImport`, the import boundary moves but
`addImport` does NOT shift existing defined-function indices, and no later shift
walker repairs a 0-based index (`inLiveShiftRange(0, importsBefore>0)` is false).
The pre-minted funcMap entry (e.g. `__anon_0_valueOf` = 0) is now stranded in
the import range: `definedFuncAt` fails to resolve it at literal-compile time
(forking a duplicate method body), while the method trampoline keeps forwarding
`call 0` into an unrelated import (`__extern_get` / `__register_prototype`).
Verified by instrument (`set __anon_0_valueOf=0` at `ensureStructForType`, then
`addImport __extern_get -> idx 0`).

The `arguments`/`obj[0] = …` element write and (independently) a user `class`
declaration are the ingredients that force the extra imports which move the
boundary — hence the cluster only appearing on those shapes.

### Fix (index.ts, stable handle)

Mint the method with `mintDefinedFunc` / `pushDefinedFunc` (#1916 S3) instead of
the live-regime arithmetic. A stable handle is layout-independent: every
late-import shift walker skips the stable range, and resolution to a concrete
index happens at emit (`resolve-layout.ts`). This is the established idiom for
any funcIdx minted before the import space is final.

### Proofs

- 3 repro shapes (element-write, borrowed-`pop`, `class`-preamble) VALIDATE;
  all previously-valid controls unchanged.
- All 4 target test262 files flip CE → valid Wasm.
- Full 214-candidate re-harvest confirms the 4 valueOf files cleared, no new
  invalid signatures.
- 12-program corpus **byte-identical** (sha256) to main.
- New `tests/issue-3024-anon-method-stable-handle.test.ts` (5 tests); adjacent
  object-method / toPrimitive suites (issue-1602, 1602-regress, 1989, 1394,
  2194-objlit-method-host-leak, 2358-array-toprimitive, 1917-any-param-
  toprimitive — 51 tests) pass, plus 3121/3039/2160/2194 + the equivalence
  suite.
- `loc-budget-allow` granted for `index.ts` (#3131; +11 net on a god-file).

### Still open (roll forward)

The 4 valueOf files now fail on a DISTINCT semantic (Array.prototype method on a
non-array `arguments`-like receiver whose `length` is an object with `valueOf` —
ToPrimitive on the length). The remaining invalid-Wasm files: the 7-file `fN.ne`
cross-statement eval-promotion family (banked, broad-impact) and ≤4-file
per-root-cause singletons (`struct.set (ref null #)`, `call expected externref
found ref.func`, Atomics `__cb_#` fallthru, `i#.lt_s`, `__vec_from_extern`
element-rep).
