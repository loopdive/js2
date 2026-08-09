---
id: 3481
title: "bigint/symbol coercion: value-substrate ToPrimitive/ToNumeric fidelity (host ~164 fails) — architect-spec hand-off"
status: ready
created: 2026-07-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
goal: test262-conformance
model: opus
sprint: current
horizon: xl
related: [3422, 3328]
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/runtime.ts
---

# #3481 — bigint/symbol coercion fidelity (value substrate)

**HAND-OFF ISSUE — needs a senior-dev + architect-spec, NOT a developer quick-fix.**
Overlaps the toPrimitive-nominal-struct epic (see MEMORY: project_2358_toprimitive_*,
project_toprimitive_nominal_struct_gap). Verified via verify-first while working #3422;
do not fold into a throw-class fix (that was the initial mis-framing — the arithmetic
`+`/coercion operators already throw real `instanceof TypeError`).

## Scope (host oracle-v8 baseline 2026-07-19, ~164 fails; Temporal excluded)

Two sub-families, both rooted in the value substrate's ToPrimitive/ToNumeric path,
NOT in throw-class (the delete/read-only bare-string bug fixed by #3422/#3471):

### A. Wrong-coercion (~106): we throw the CORRECT TypeError but shouldn't throw at all
The thrown errors are already real `instanceof TypeError`; the bug is that we coerce
Symbol/BigInt to number where the spec does something else. Repros:
- `Object(2n) * 2n` → we throw "Cannot mix BigInt and other types" because we do NOT
  ToPrimitive-unwrap the BigInt **wrapper object** to its primitive `2n` before the
  multiply (should be `4n`). (`language/expressions/multiplication/bigint-wrapped-values.js`)
- `Array[Symbol.species]` descriptor read / `Map.prototype[Symbol.iterator]`
  verifyProperty → a Symbol key gets coerced to a number during normal execution
  ("Cannot convert a Symbol value to a number in __module_init / isWritable").
- Signatures: "Cannot convert a Symbol value to a number" ×79, "Cannot mix BigInt and
  other types" ×27.

### B. Missing-throw (~26): ToPrimitive result not re-validated
An object whose `@@toPrimitive`/`valueOf` returns a Symbol/BigInt, passed where a
string/integer/index is expected — we call ToPrimitive, get the Symbol/BigInt back, and
do NOT re-validate it on the subsequent ToString/ToInteger/ToIndex, so no throw occurs.
- ToPrimitive-tangled (~16, same root as A): `String.prototype.indexOf`
  searchstring/position, `Error`/`AggregateError`/`SuppressedError`/`NativeError` message
  ToString, `DataView.getBigInt64` / `BigInt.asUintN` ToIndex, `ArrayBuffer` length.
  The runtime `__extern_to_string_default` DOES re-check Symbol (runtime.ts ~8722-8736),
  but the inlined codegen coercions (string-ops.ts `$__any_to_string`) and the
  ToInteger/ToIndex paths do not — route them through the checking helper.
- Genuinely isolated (~10, scattered across ~6 sites — could be split off as small
  independent fixes if desired): `1n >>> 1n` (BigInt has no `>>>`, must throw TypeError);
  `(x).toFixed(sym)` throws RangeError **before** the ToNumber TypeError (coercion-order
  bug — coerce fractionDigits before range-validating); `[].sort(Symbol())` comparefn
  IsCallable validation; `ArrayBuffer.prototype.slice` species-not-constructor;
  `String.fromCharCode(1n)` ToNumber(BigInt).

## Why hard / hand-off
The dominant A + B-tangled clusters require correct ToPrimitive/ToNumeric on nominal
struct wrappers (`Object(2n)`, boxed Symbol) and Symbol-keyed access — the same substrate
as the toPrimitive-nominal-struct work. Regression-prone; needs an architect spec that
sequences: (1) wrapper-object ToPrimitive unwrap, (2) ToString/ToInteger/ToIndex Symbol/
BigInt re-check on ToPrimitive results, (3) the isolated operator/arg-validation fixes.

## Acceptance
- `Object(2n) * 2n === 4n`; Symbol-keyed descriptor reads don't spuriously coerce.
- ToPrimitive returning a Symbol/BigInt into a String/Integer/Index context throws a real
  `instanceof TypeError` at the coercion site.
- The ~10 isolated cases (`>>>`, toFixed order, sort comparefn, species, fromCharCode) throw.
- Zero regression on the arithmetic-coercion cases that already pass.

## Implementation Notes — senior-dev, 2026-07-21 (branch `issue-3481-value-rep-coercion`)

**Verify-first disproved the "bigint-wrapper is a tight slice" premise. This IS the
epic the issue predicted — there is no single-PR slice that flips a whole host
test262 file.** What landed on the branch is a correct, low-regression *prerequisite*,
not a self-merge. Escalated to the tech lead for sequencing (do NOT enqueue).

### What the branch implements (step 1 of the issue's own sequence — "wrapper-object ToPrimitive unwrap")
A new internal host import `__host_bigint_binop(op:i32, a:externref, b:externref)->externref`
(mirrors the existing `host_add`/`host_compare`/`host_eq` precedent — compiler-emitted,
not user-facing, so the host-import allowlist gate does not bite):
- `src/index.ts` — `ImportIntent` union: `{ type: "host_bigint_binop" }`.
- `src/compiler/import-manifest.ts` — name→intent mapping.
- `src/runtime.ts` (`case "host_bigint_binop"`) — struct operands ToPrimitive-reduced via
  `_toPrimitiveSync` (hint `default` for `+`, `number` otherwise), then JS applies the
  operator → ToNumeric + the mix-TypeError check + BigInt arithmetic + `>>>`-on-BigInt
  throw, all for free. i32 opcode is a private ABI shared with `bigIntHostBinopOpcode`.
- `src/codegen/binary-ops.ts` — in the mixed-BigInt arithmetic block, BEFORE the
  `emitThrowTypeError("Cannot mix BigInt…")`, delegate to the host binop when the
  **non-bigint operand is `Any|Unknown|Object`** and mode is JS-host + default
  (`anyValueTypeIdx < 0`). Standalone/WASI keeps the throw (no JS host). Gate includes
  `Object` (not just `Any`) deliberately — object-literal operands are `TypeFlags.Object`,
  and broadening is safe *because* the binop pre-reduces structs via `_toPrimitiveSync`
  (the #1374 regression was raw `a<b` on opaque structs with NO pre-reduction).

**Regression surface = zero on passing tests**: the delegated arm replaces a path that
*currently always throws at runtime*. Only outcomes are throw→compute (fix) or
TypeError-msgA→TypeError-msgB (benign — `assert.throws(TypeError)` still passes).
Empirically verified: `Object(2n)*2n=4n`, `2n*Object(2n)=4n`, `-`/`+`/`**`/`|`/`>>` on
`Object(bigint)` correct; `(5 as any)*2n` and `2n*(3 as number)` still throw TypeError;
`Object(4n) >>> 1n` throws; plain `2n*2n`/`5n+3n`/`1n<<4n` untouched.

### Why it flips 0 whole host files ALONE (inferred from assertion-path analysis)
test262 aborts on the FIRST failed `assert.*`, and every failing FILE bundles the
wrapper case with an assertion this slice does NOT cover:
- **`.../bigint-wrapped-values.js` (13 files)** — assertion #3 (before the passing
  `Object(2n)` rows finish the file) is `{[Symbol.toPrimitive](){return 2n}} * 2n`, then
  `{valueOf}`/`{toString}`. These are WasmGC structs; two substrate gaps block them:
  - **Gap A** — a compiled `valueOf`/`toString` dispatched via a method-call-through-`any`
    loses the BigInt brand: it returns `2` (number), not `2n`, so `2 * 2n` throws the JS
    mix error. (A *direct* closure return preserves the brand — the loss is in the
    method-via-any / `__call_fn_method_0` return boxing.)
  - **Gap B** — an object-literal computed `[Symbol.toPrimitive]` is NOT dispatched by
    `_hostToPrimitive` at all (no sidecar / no `__call_@@toPrimitive` for object literals)
    → falls to `"[object Object]"`.
  Both are `_hostToPrimitive` / nominal-struct ToPrimitive substrate — **the same lane as
  the active `issue-3328-capturing-closure-toprimitive-dispatch` worktree.** Not touched
  here to avoid duplicate-work collision (lane-partition rule). Once #3328's dispatch
  lands, this binop is what routes the reduced primitive back into a BigInt op → the
  wrapped-values files flip. The binop is a genuine dependency of that flip, not redundant.
- **`.../bigint-and-number.js` (9 files)** — assertions like `Object(1n) * 1` and
  `Object(1n) * Object(1)` have **neither** operand statically bigint, so they never enter
  the mixed-BigInt block; they need general `any`-arithmetic host delegation, which changes
  the result type of ALL `any * number` from f64→externref (blast radius across every
  any-arithmetic site + the AnyValue fast-mode ABI) — explicitly NOT a low-regression first
  slice (#1374 lesson). Deferred.

### Remaining slices (for the architect/PO to sequence)
1. **Gap A + Gap B in `_hostToPrimitive`** (coordinate with #3328) — unblocks the 13
   `bigint-wrapped-values.js` files given the binop above.
2. **General `any`-arithmetic host delegation** (multiplicative/bitwise) — unblocks the 9
   `bigint-and-number.js` files; needs its own regression budget (result-type f64→externref).
3. **Symbol ×79 cluster** — the larger, unexplored lever (localized property-access Symbol-key
   coercion per the scope notes). Needs a short feasibility probe (single coercion site vs
   shared substrate) before commit; likely the better flip-positive host win this session,
   but a different subsystem from the bigint work here.
4. Family-B ToString/ToInteger/ToIndex Symbol/BigInt re-check on ToPrimitive results, and the
   isolated operator/arg-validation cases.
