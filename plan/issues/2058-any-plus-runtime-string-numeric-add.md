---
id: 2058
title: "+ and += with a runtime string in an any/externref position do numeric addition instead of concatenation"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [79, 308, 1134, 1175, 2059]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #2058 — `any + any` with runtime strings forces f64 addition

## Problem

Per [§13.15.3 ApplyStringOrNumericBinaryOperator](https://tc39.es/ecma262/#sec-applystringornumericbinaryoperator),
`+` must ToPrimitive both operands and concatenate if *either* primitive is a
string. With `any`/externref-typed operands carrying runtime strings, the
compiler unconditionally unboxes to f64: `1 + "2"` → `3` instead of `"12"`.

## Repro (verified on main)

```ts
export function plus(s: any): any { return 1 + s; }
export function plusBoth(a: any, b: any): any { return a + b; }
export function compound(s: any): any { let x = 1; x += s; return x; }
```

| call | wasm | node |
|------|------|------|
| `plus("2")` | `3` | `"12"` |
| `plusBoth("1","2")` | `3` | `"12"` |
| `compound("2")` | `3` | `"12"` |

## Root cause

Three converging paths in `src/codegen/binary-ops.ts` /
`src/codegen/expressions/assignment.ts`:

1. AnyValue dispatch (binary-ops.ts:905-921) requires
   `leftIsAny && rightIsAny` *and* `ctx.anyValueTypeIdx >= 0`; for plain
   externref-typed `any` params in default (non-fast) mode the AnyValue infra
   isn't active, so even any+any falls through.
2. String-concat routing (941-952) is gated on the static checker type
   `isStringType`, which `any` never satisfies.
3. The externref-numeric fallback (1721-1733) unconditionally unboxes externref
   operands to f64 with hint "number".

Compound `+=` shares the defect via the `hasStringAssignment` heuristic
(assignment.ts:4573-4585).

## Fix direction

For `+` with any externref/any-typed operand, emit a runtime-dispatched add
(a `__host_add` import mirroring `__host_loose_eq` from #1134, with a
standalone tag-dispatch fallback) instead of forcing f64. The same helper
serves `+=` when the LHS static type is any/unknown. Keep the f64 fast path
when the checker proves both operands numeric.

## Acceptance criteria

- All three repros match Node (`"12"`)
- `any + any` with two numbers still numeric (`1 + 2 = 3`)
- Object operands go through ToPrimitive (valueOf/toString order)
- Standalone mode covered (no host-only fix)

## Dupe check

Grepped `compileAnyBinaryDispatch`, `concat` + `any`, `addition` + `externref` —
#79 (AnyValue infra, done, fast-mode only), #308 (static string/number
addition, done), #1175 (concat type mismatch, different). Not covered.

---

## Implementation Plan (shared design for #2058 / #2059 / #2063)

> This is the **anchor spec** for the AnyValue host-bridge tag-recovery cluster.
> #2059 (relational) and #2063 (switch) reference this section for the shared
> tag-dispatch mechanism and carry only their per-site deltas. Read this first.

### Root cause (one sentence)

In default (JS-host, non-`nativeStrings`) mode `any`/`unknown` parameters lower
to a **plain `externref`** and `ctx.anyValueTypeIdx` stays `-1`
(`create-context.ts:141`; set lazily only by `ensureAnyValueType`), so every
operator site that needs runtime number-vs-string tag awareness instead takes a
**type-blind fast path** that unconditionally treats the externref as a number:
`+`/`+=` unbox both sides to f64 and `f64.add` (binary-ops.ts:1815-1828,
assignment.ts:4587-4619), relationals do the same (#2059), and `switch` unifies
the whole statement into one f64-or-string comparison domain (#2063). The
honest tag lives in the host value (or, in standalone, in the WasmGC heap type)
but is never probed.

### Why honest recovery at the *boxing* site regressed −788 (do NOT touch it)

`type-coercion.ts:1207-1219` boxes **every** `externref → AnyValue` as **tag 5**
(`__any_box_string`, externval = the raw externref) on purpose. The comment
there (and the mirror in `any-helpers.ts:694-705`) records the #1888 finding:
routing that generic boxing through `__any_from_extern` (which probes
`ref.test $BoxedNumber` / `$BoxedBoolean` and assigns honest tags 3/4) flipped
**~794 standalone test262 passes red**. The dependency is the **test262
standalone harness comparator**: `isSameValue(a: any, b: any)` /
`assert.sameValue` compile their `any` params to `externref`, and their
`a === b` / `a !== a` bodies reach the externref-equality path
(binary-ops.ts:1833-2028). That path was already hardened (#1776 numeric/bool
tag dispatch, #1914 string value-compare) to be **bit-compatible with the
current tag-5 box-the-externref ABI**. Re-tagging at the boxing site shifts the
representation those comparators were tuned against and desyncs the harness.

**Design rule that falls out of this:** do **NOT** change the
`externref → AnyValue` boxing in type-coercion.ts, and do **NOT** flip
`anyValueTypeIdx` on for default mode. Honest tag recovery must happen
**per-operator-site, on the externref operands directly**, exactly mirroring the
#1776/#1914 equality blocks that already coexist with the comparator without
regressing it. Each site is opt-in, so the baseline can only move per landed
site and any regression is attributable and revertible.

### The one shared mechanism: per-site externref tag dispatch

All three issues get the same primitive — a helper that, given two `externref`
operands already spilled to temps `$l` / `$r`, branches on runtime type and
performs the spec-correct primitive operation. This is **the #1776 pattern
generalized** from equality to `+`, relational, and `switch` case-compare.

**Dual-mode probes (CLAUDE.md dual-mode principle — no new host import without a
standalone fallback):**

| Concern | JS-host fast path (import) | Standalone / WASI Wasm-native fallback |
|---|---|---|
| is operand a string? | `__typeof_string` (manifest 97) | same name — in `UNION_NATIVE_HELPER_NAMES` (late-imports.ts:32), `addUnionImports` emits an in-module func |
| is operand a number? | `__typeof_number` (96) | union-native (late-imports.ts:30) |
| is operand a boolean? | `__typeof_boolean` (98) | union-native (late-imports.ts:31) |
| number value | `__unbox_number` (103) | union-native (late-imports.ts:26) |
| boolean value | `__unbox_boolean` (104) | union-native (late-imports.ts:28) |
| string→number (ToNumber) | `__unbox_number` (host ToNumber, manifest 103) | `__str_to_number` native scanner (§7.1.4.1), emitted via `emitNativeParseNumber(ctx, new Set(["__str_to_number"]))` — see binary-ops.ts:884-887 |
| string content op (concat / compare / equals) | wasm:js-string `concat`/`equals` + a new host `__host_*` for ordering, OR native helpers when `nativeStrings` | `__str_concat` / `__str_compare` / `__str_equals` via `any.convert_extern` + `ref.test $AnyString` + `ref.cast` (the #1914 pattern at binary-ops.ts:1982-2009) |

**Two new host imports** (each WITH a standalone story, so the dual-mode rule
holds):

1. **`__host_add(a: externref, b: externref) -> externref`** — §13.15.3
   ApplyStringOrNumericBinaryOperator for `+`. Host body (runtime.ts, new
   `case "host_add"` next to `host_loose_eq` at 10293): `(a, b) => a + b`. This
   gets ToPrimitive + the string-if-either-is-string rule + object valueOf/
   toString ordering **for free** from JS `+`. Manifest: add
   `if (name === "__host_add") return { type: "host_add" };` near line 129.
2. **`__host_compare(a: externref, b: externref) -> i32`** — §7.2.13 IsLessThan
   core for relationals (used by #2059). Host body: return `-1` / `0` / `1` /
   `2`(=undefined/NaN incomparable): e.g.
   `(a,b) => { if (a < b) return -1; if (a > b) return 1; if (a === b ... ) ...; return 2 /*NaN*/ }`.
   Returning a 4-way result lets the call-site map each relational operator
   (`<`,`<=`,`>`,`>=`) without 4 separate imports, and the `2` sentinel makes
   every comparison involving a NaN/undefined operand yield `false` per spec.
   Manifest + runtime `case "host_compare"` likewise. (Detailed in #2059.)

**Standalone substitution** for these two: there is no JS host, so the call-site
must NOT emit `__host_add`/`__host_compare`. Instead, under
`ctx.standalone || ctx.wasi`, build the operation inline from the union-native
probes + `__str_*` helpers, exactly as binary-ops.ts:879-908 already does for
mixed string⇄number `==` (the `noJsHost && ctx.nativeStrings` branch). Gate with
`const noJsHost = ctx.standalone === true || ctx.wasi === true;` and require
`ctx.nativeStrings && ctx.anyStrTypeIdx >= 0` for the string arms (auto-true for
`--target standalone`/`wasi`). If neither host nor native-string support is
available, fall through to the existing f64 path (status-quo, no regression).

### #2058-specific changes — `+` and `+=`

**File: `src/codegen/binary-ops.ts`**

- **New gate, placed BEFORE the externref-numeric fallback at line 1815**
  (so it intercepts `+` before the unconditional f64 unbox). Condition:
  `op === ts.SyntaxKind.PlusToken && (leftType.kind === "externref" || rightType.kind === "externref")`.
  (Use the lowered `leftType`/`rightType`, the Wasm types already computed
  above — `any` lowers to externref, so this catches the issue's `any + any`,
  `1 + any`, `any + "2"` cases. Do **not** rely on `leftIsAny && rightIsAny` —
  one side is often a concrete `number`/`string` literal.)
- Spill both operands to externref temps (`coerceType(..., {kind:"externref"})`
  for any non-externref side), mirroring the spill at binary-ops.ts:1877-1887.
- **JS-host path:** `ensureLateImport(ctx, "__host_add", [externref, externref],
  [externref])`, `flushLateImportShifts(ctx, fctx)`, `call __host_add`. Result
  is `externref` (a boxed any) — return `{ kind: "externref" }` so the caller
  boxes it back into the `any` slot via the existing externref→AnyValue path.
- **Standalone path** (`noJsHost`): inline §13.15.3 — if `__typeof_string(l) ||
  __typeof_string(r)` then ToString both and `__str_concat`; else ToNumber both
  (string via `__str_to_number`, number via `__unbox_number`) and `f64.add` then
  box. Reuse `emitConcatOperand`-style ToString from string-ops.ts:68-72 for the
  non-string side's `ToString`. If a clean standalone ToString for arbitrary
  externref isn't reachable, scope the standalone string-concat arm to operands
  `__typeof_string`-positive on at least one side and fall through to f64 add for
  the all-numeric case (covers `lt`-style numeric `any+any`; pure object
  ToPrimitive in standalone is out of scope and already unsupported).
- **Fast path preserved:** when the checker proves both operands `number`
  (`isNumberType(leftTsType) && isNumberType(rightTsType)`), skip this gate and
  let the existing numeric path run — no host call, no perf change.

**File: `src/codegen/expressions/assignment.ts`**

- Function `compileCompoundAssignment` (the `PlusEqualsToken` arm, line
  ~4587-4619). Today it forces the RHS to f64 and `f64.add`s. When the LHS
  variable's static type is `any`/`unknown` (not provably numeric — extend the
  existing `hasStringAssignment` heuristic at 4452/4595 to also fire for `any`),
  route through the **same `__host_add` / standalone-inline helper**: load LHS as
  externref, compile RHS to externref, call the shared add, store back. Keep the
  f64 fast path when LHS is provably numeric.
- Factor the add-dispatch into a small shared emitter (e.g.
  `emitAnyAdd(ctx, fctx)` in binary-ops.ts exported for assignment.ts) so `+`
  and `+=` share one implementation and one host import.

### Edge cases (apply to all three sites)

- **NaN**: ToNumber("x") → NaN; `f64.add`/`f64.eq`/comparisons propagate NaN
  correctly. The `__host_compare` `2` sentinel makes NaN relationals `false`.
- **-0**: `f64.add(-0, ...)`/`f64.eq` already match JS; do not special-case.
- **null / undefined operands** (tags 0/1 in the AnyValue scheme; `null` /
  `undefined` host values): `null + 1 === 1`, `undefined + 1 === NaN`,
  `"x" + null === "xnull"`. JS-host `__host_add` gets these free. Standalone:
  `__typeof_number(null)` is 0 and `__unbox_number(null/undefined)` →
  `0`/`NaN` per the host ToNumber funnel (runtime.ts:10181-10206) / union-native
  equivalent — verify the union-native `__unbox_number` returns NaN for
  undefined and 0 for null (it must, to match the f64-unbox table at
  type-coercion.ts:1270-1284).
- **Subclassed primitives / wrapper objects** (`new String("a")`): these are
  `typeof === "object"`, so `__typeof_string` is 0 and they take the ToPrimitive
  path — JS-host `+`/`<` handle valueOf/toString ordering. Standalone wrapper
  ToPrimitive is out of scope (already refused for open objects, late-imports.ts
  §1472); fall through is acceptable.
- **bigint**: not in scope for `+`/relational here — `any + bigint` keeps the
  existing bigint routing (binary-ops.ts:998+) which runs before this gate for
  statically-typed operands; for runtime bigint in an externref, `__host_add`
  throws `TypeError` (string+bigint) or concatenates (correct), matching JS.

### Staged landing order (regression-safe)

1. **Land #2063 switch strict-eq first** (smallest blast radius, no new host
   import — reuses `__any_strict_eq` + the host-boxed-boolean tag-4 fix). It is
   the cleanest validation that per-site tag dispatch coexists with the harness.
2. **Land #2058 `+`/`+=`** — adds `__host_add` (+ standalone inline). Run the
   standalone test262 shard locally/CI and confirm the comparator buckets
   (`isSameValue`, `sameValue`) do **not** move; the gate only fires for `+`, so
   equality is untouched.
3. **Land #2059 relational** — adds `__host_compare` (+ standalone inline),
   depends on the spill/dispatch scaffolding from #2058. Re-check the same
   buckets.

Each step is independently revertible and touches a disjoint operator set, so a
−N regression localizes to exactly one PR. **Do not** combine them into one PR
and **do not** "simplify" by flipping `anyValueTypeIdx` on in default mode — that
is precisely the −788 trap.

### Test files to verify (#2058)

- The three repros in this issue (`plus("2")`, `plusBoth("1","2")`,
  `compound("2")`) → `"12"`; `plusBoth(1,2)` → `3`.
- `tests/equivalence.test.ts` add `any`-concat cases.
- Standalone: re-run the `test262` standalone shard; assert no movement in the
  `isSameValue`/`assert.sameValue` pass buckets (the −788 guard).

---

## Resolution (2026-06-12)

Implemented per the staged plan: a new `__host_add` host import (JS `+`) plus a
shared per-site runtime-dispatched add. **The comparator path
(`binary-ops.ts` externref-equality block) and `__any_from_extern` /
type-coercion boxing were NOT touched** — the gate only fires for `+`/`+=`, so
the test262 `isSameValue` comparator ABI is untouched (the −788 guard holds).

### What landed

1. **`__host_add` wiring** — `src/index.ts` (`host_add` in the `ImportIntent`
   union), `src/compiler/import-manifest.ts` (`__host_add → { type: "host_add" }`),
   `src/runtime.ts` (`case "host_add": (a, b) => a + b`). JS `+` provides
   ToPrimitive, the string-if-either-is-string rule, and object valueOf/toString
   ordering for free.
2. **`emitAnyAdd(ctx, fctx, expr)`** (`src/codegen/binary-ops.ts`) — the shared
   add. Compiles both operands with an **externref hint** (keeping a runtime
   string boxed, no ToNumber) then:
   - JS-host → spill to externref temps, `call __host_add`, return externref.
   - standalone/WASI (`noJsHost`) with `nativeStrings` → runtime branch:
     `if (__typeof_string(l) | __typeof_string(r))` ToString both via
     `__extern_toString` + `__str_concat`, **else** `__unbox_number` both +
     `f64.add` + `__box_number`. No `__host_add` import is emitted standalone.
   - no host / no native strings → legacy f64 add (status quo, no regression).
3. **`+` gate** (`compileBinaryExpression`, after `isNumericOp`) — when
   `op === PlusToken` and either static operand type is `any`/`unknown` (and not
   bigint), route to `emitAnyAdd` **before** the f64 `numericHint` is applied
   (the root cause: operands were ToNumber-coerced at compile time by the
   numeric hint, so the late externref-numeric fallback never saw a string).
4. **`+=` gate** (`compileCompoundAssignment` simple-identifier path) — new
   `compileAnyCompoundAdd`: when LHS or RHS is `any`/`unknown`, compute via
   `emitAnyAdd` (which reads `expr.left` as the current value) and store the
   externref result back to the local / captured-global / module-global,
   coercing to the binding's storage type. Boxed-capture and static-string
   concat paths are left to their existing handlers.

### Why it's regression-safe

- Provably-numeric `+`/`+=` (neither side `any`/`unknown`) keep the f64/i32 fast
  path verbatim — the gate's `leftIsAnyish || rightIsAnyish` predicate is false.
- Provably-string `+` is still handled by the earlier `isStringType` concat gate
  (runs before the new gate).
- Fast mode (`anyValueTypeIdx >= 0`) intercepts `any + any` via
  `compileAnyBinaryDispatch` earlier still, so it never reaches the new gate.
- Standalone never emits a `__host_add` import (builds in-module or falls back).

### Outcome (all verified)

`plus("2")`/`plusBoth("1","2")`/`compound("2")` → `"12"`; `plusBoth(1,2)` → `3`;
`null + 1` → `1`; `undefined + 1` → `NaN`; `"x" + null` → `"xnull"`;
`string + (any number)` concatenates. Standalone numeric add computes correctly
and the concat arm validates with no unsatisfiable import.

### Tests

`tests/issue-2058-any-plus-string.test.ts` — 12 JS-host equivalence cases
(`assertEquivalent`) + 3 standalone cases (`--target standalone`,
`WebAssembly.validate` + run).
