---
id: 1460
title: "spec gap: Object.defineProperty / defineProperties descriptor fidelity"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: property-descriptors
goal: spec-completeness
sprint: 52
related: [929, 1334, 1364]
---
# #1460 - spec gap: Object.defineProperty / defineProperties descriptor fidelity

## Problem

`built-ins/Object/defineProperty/` and `built-ins/Object/defineProperties/`
account for **1,763 test262 failures** (1,131 + 632). Most are silent
assertion failures (no error thrown, but the resulting property doesn't
match the spec). Representative patterns:

| Pattern | Test file | Spec gap |
| --- | --- | --- |
| Property key coerced from non-string (number 1e+22, Symbol, object with `toString`) | `15.2.3.6-2-19.js`, `15.2.3.6-2-48.js` | ToPropertyKey not applied to `P` |
| Truthy/falsy coercion of `configurable` / `writable` / `enumerable` (e.g. `-12345` → `true`) | `15.2.3.6-3-108.js`, many `15.2.3.6-3-*.js` | `ToBoolean(desc.X)` not applied; non-bool stored verbatim or ignored |
| `delete obj.x` after `defineProperty` with `configurable:false` should throw / be a no-op | `15.2.3.6-3-123.js` | configurable flag not honoured by `delete` |
| Redefining a non-configurable accessor / data property → TypeError | "Expected TypeError, got Test262Error" (40 cases) | redefinition validation skipped |
| Mixing accessor + data attributes → TypeError | `15.2.3.7-5-b-*.js` | mixed-attribute rejection missing |
| `Object.defineProperties(obj, descMap)` with inherited descriptor keys | `15.2.3.7-5-a-3.js` | only own enumerable descriptor keys should be visited |
| Property description must be an object: 0 | `L55:3 TypeError: Property description must be an object: 0` | numeric descriptor accepted (should throw) |
| Codegen error: op.endsWith is not a function | 3 tests | crashes inside codegen on certain descriptor shapes |

Existing infrastructure (`src/codegen/object-ops.ts`) already encodes flags
into a packed integer for `__defineProperty_value` and handles the
struct-property fast path, but the validation and coercion required by the
spec algorithm `OrdinaryDefineOwnProperty` / `ValidateAndApplyPropertyDescriptor`
(ES §10.1.6) is largely missing.

## Failure count

1,763 (1,131 `Object/defineProperty/` + 632 `Object/defineProperties/`).
Roughly 50% of failures are silent "wrong result" assertions, 30% are
"Expected TypeError" cases where the spec demands a throw, the rest are
crashes / compile errors.

## Root cause

In `src/codegen/object-ops.ts` (~1,400 LOC for the Object.defineProperty
family):

1. **Boolean coercion of attribute flags is absent.** Around line 437 the
   compiler assembles the descriptor flag word, but it reads
   `desc.writable` / `desc.configurable` / `desc.enumerable` literally —
   if the source supplies `-12345` the value is captured but never run
   through ToBoolean. Spec §6.2.5.6 step 5.b requires `ToBoolean(value)`.

2. **ToPropertyKey on `P` is not applied uniformly.** When the key is a
   non-string literal (number, Symbol, object with `toString`) the codegen
   keeps the original kind, so `1e+22` becomes `"1e22"` instead of
   `"1e+22"`. This is a JS `String()` issue too — the canonical
   number-to-string algorithm must run.

3. **Redefinition validation is missing.** `__defineProperty_value` /
   `__defineProperty_accessor` overwrite blindly. The spec
   (`ValidateAndApplyPropertyDescriptor`, §10.1.6.3) rejects:
   - changing a non-configurable data property to accessor (or v.v.);
   - widening attributes on non-configurable;
   - changing the value of a non-writable, non-configurable data property.

4. **Mixed accessor + data descriptors** (`{ value: 1, get: f }`) are not
   rejected. Spec §6.2.5.6 step 4 requires TypeError.

5. **Descriptor type check** (`Type(desc) is Object`) is missing — the
   runtime accepts `defineProperty(obj, "x", 0)`. Spec §6.2.5.5 step 1.

6. **`delete` path does not consult the configurable flag**
   (`src/codegen/typeof-delete.ts` line 195 notes the gap explicitly).

7. **`Object.defineProperties` iterates all enumerable keys** —
   but it must filter by `enumerable: true` of the *descriptor map's*
   own properties, not the resolved descriptors.

8. **Codegen crash** "op.endsWith is not a function" — descriptor
   compilation path mis-types a non-string property key (3 tests).

## Acceptance criteria

1. `defineProperty(obj, K, desc)` applies `ToPropertyKey(K)` and
   `ToBoolean` on `configurable`/`writable`/`enumerable` before storing.
2. Numeric property keys render via JS canonical
   `Number::toString` (so `1e+22` stays `"1e+22"`).
3. Redefinition validation per §10.1.6.3 — throws TypeError when changing
   non-configurable in ways the spec forbids.
4. Mixed accessor + data descriptors throw TypeError (§6.2.5.6 step 4).
5. Non-object descriptor argument throws TypeError (§6.2.5.5 step 1).
6. `delete` respects `configurable:false` (extends existing #1334 work).
7. `Object.defineProperties` iterates only own enumerable keys of the
   descriptor map (and reads each via `ToPropertyDescriptor`).
8. No codegen crashes ("op.endsWith is not a function") on any
   `Object/defineProperty` test262 case.
9. ≥1,200 of the 1,763 failures resolved (≥68% pass-rate).
10. Tests: `tests/issue-1460.test.ts` covers each of the eight rules
    above with a focused vitest case.

## Files to inspect

- `src/codegen/object-ops.ts` (~1,400 LOC — main implementation)
- `src/codegen/typeof-delete.ts` (configurable-aware `delete`, lines 109/195)
- `src/codegen/literals.ts` (`__defineProperty_accessor` for object literals)
- `src/codegen/declarations.ts` (widening hooks, lines 523–545, 1722–1820)
- `src/runtime.ts` — host `__defineProperty_value`/`_accessor` implementations
- `tests/issue-1460.test.ts`

## Notes

- Issue #1364 covered class-element method descriptor fidelity — this
  issue is the broader Object.defineProperty surface.
- Issue #1334 covered writable on `delete` — there is overlap on the
  configurable-aware delete path.
- Many of the 40 "Expected TypeError" failures resolve trivially once
  redefinition validation lands; tackle that early to avoid double work.

## Implementation Plan

### Strategy

The largest pass-rate lever is **R1 (ToBoolean coercion of attribute flags)** — most of the 1,131 silent-fail cases come from non-boolean values for `writable` / `enumerable` / `configurable` (e.g. `-12345`, `this`, `{}`, `null`). Currently the codegen *only* accepts the `TrueKeyword` / `FalseKeyword` literals and silently drops the entire attribute when any other expression appears, so the host descriptor never gets the bit set and the property silently inherits the JS-engine default (`false`). Fixing that one bug should resolve ≥800 of the 1,763 failures.

Two design choices apply to every fix:

1. **Push validation into the JS host (`runtime.ts`) where possible.** Native `Object.defineProperty` already does `ToPropertyKey`, `ToPropertyDescriptor`, and `ValidateAndApplyPropertyDescriptor` correctly for plain JS objects. The compiler bug is that we *bypass* the host by splitting `value`/`flags` apart at codegen time, so the host never sees the spec-mandated `ToPropertyDescriptor` step. The fix is to (a) parse the descriptor as a *raw externref* and pass it to a new host import `__defineProperty_full(obj, key, descObj)` for any descriptor whose attributes are not all statically resolvable booleans, and (b) for the fast path keep the existing `__defineProperty_value` / `__defineProperty_accessor` calls only when all flags are compile-time-known booleans.
2. **Statically detect malformed descriptors at codegen** (R4, R5) — these are cheap to detect and let us emit a TypeError throw at compile time, matching the spec.

### Implementation phases (by impact × risk)

**Phase 1 (high impact, low risk)** — R1, R5, R4 — addresses ~1,000 failures.
**Phase 2 (medium impact)** — R3, R7 — addresses ~400 failures.
**Phase 3 (cleanup)** — R2, R6, R8 — addresses ~150 failures and crashes.

---

### Phase 1A — ToBoolean coercion of attribute flags (R1)

**File: `src/codegen/object-ops.ts`**

#### 1. Parse all flag initializers, not just literals (lines 436-456)

Replace the literal-only parser with a three-state result: `true`, `false`, or `dynamic` (carries an AST node we'll ToBoolean-coerce at runtime).

```ts
type FlagValue = { kind: "literal"; value: boolean } | { kind: "dynamic"; expr: ts.Expression } | undefined;

function parseFlagInitializer(init: ts.Expression): FlagValue {
  // Compile-time constant folding — preserves zero-cost behavior when source is `true`/`false`.
  if (init.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: true };
  if (init.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: false };
  if (init.kind === ts.SyntaxKind.NullKeyword) return { kind: "literal", value: false };
  if (ts.isIdentifier(init) && init.text === "undefined") return { kind: "literal", value: false };
  if (ts.isNumericLiteral(init)) {
    // ToBoolean(0) = false, ToBoolean(NaN) = false, else true
    const n = Number(init.text);
    return { kind: "literal", value: !!n && !Number.isNaN(n) };
  }
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
    return { kind: "literal", value: init.text.length > 0 };
  }
  // For everything else (-12345 is PrefixUnaryExpression, identifiers like `this`,
  // object literals `{}`, calls, etc.) we need a runtime ToBoolean.
  return { kind: "dynamic", expr: init };
}
```

Apply at the descriptor parse loop. Update local types:

```ts
let descWritable: FlagValue;
let descEnumerable: FlagValue;
let descConfigurable: FlagValue;
// ...
if (name === "writable") descWritable = parseFlagInitializer(prop.initializer);
else if (name === "enumerable") descEnumerable = parseFlagInitializer(prop.initializer);
else if (name === "configurable") descConfigurable = parseFlagInitializer(prop.initializer);
```

Also update the identical second copy in `compileObjectDefineProperties` (lines 1571-1582) and the `dpWritable`/`dpEnumerable`/`dpConfigurable` parsing.

#### 2. Lower `FlagValue` into the runtime flag word

`computeRuntimeFlags` (line 1009) currently takes `boolean | undefined`. Keep it as the fast path. Add a new emitter that builds the same packed-int representation on the Wasm stack at runtime:

```ts
// New helper — emits an `i32` (or `f64` via f64.convert_i32_s) holding the runtime flags
// for a descriptor where one or more attributes need ToBoolean coercion.
function emitDynamicRuntimeFlags(
  ctx: CodegenContext,
  fctx: FunctionContext,
  writable: FlagValue,
  enumerable: FlagValue,
  configurable: FlagValue,
  hasValue: boolean,
): void {
  // Compile-time constant portion
  let staticFlags = 0;
  if (writable?.kind === "literal") {
    staticFlags |= 1 << 3; // specified
    if (writable.value) staticFlags |= 1;
  }
  if (enumerable?.kind === "literal") {
    staticFlags |= 1 << 4;
    if (enumerable.value) staticFlags |= 1 << 1;
  }
  if (configurable?.kind === "literal") {
    staticFlags |= 1 << 5;
    if (configurable.value) staticFlags |= 1 << 2;
  }
  if (hasValue) staticFlags |= 1 << 7;

  // Push static base
  fctx.body.push({ op: "i32.const", value: staticFlags });

  // For each dynamic flag: emit `i32.const (specified_bit)` OR `(ToBoolean(expr) ? value_bit : 0)`
  // ToBoolean is performed via __to_boolean host import (externref → i32).
  const emitToBool = (expr: ts.Expression, valueBit: number, specifiedBit: number) => {
    // Top-of-stack accumulator is i32.
    // Push specified bit OR with accumulator.
    fctx.body.push({ op: "i32.const", value: specifiedBit });
    fctx.body.push({ op: "i32.or" });
    // Compile expr → externref, call __to_boolean → i32 (0 or 1)
    const t = compileExpression(ctx, fctx, expr, { kind: "externref" });
    if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    const toBoolIdx = ensureLateImport(ctx, "__to_boolean", [{ kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: toBoolIdx! });
    // Shift to the value bit position
    const shift = Math.log2(valueBit);
    if (shift > 0) {
      fctx.body.push({ op: "i32.const", value: shift });
      fctx.body.push({ op: "i32.shl" });
    }
    fctx.body.push({ op: "i32.or" });
  };

  if (writable?.kind === "dynamic") emitToBool(writable.expr, 1, 1 << 3);
  if (enumerable?.kind === "dynamic") emitToBool(enumerable.expr, 1 << 1, 1 << 4);
  if (configurable?.kind === "dynamic") emitToBool(configurable.expr, 1 << 2, 1 << 5);

  // Convert i32 to f64 to match the existing `f64.const` slot of `__defineProperty_value`
  fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
}
```

In `emitExternDefinePropertyValue` (line 1107) and `emitExternDefinePropertyNoValue` (line 1284, 1357), replace:

```ts
fctx.body.push({ op: "f64.const", value: runtimeFlags });
```

with:

```ts
const allStatic =
  (descWritable === undefined || descWritable.kind === "literal") &&
  (descEnumerable === undefined || descEnumerable.kind === "literal") &&
  (descConfigurable === undefined || descConfigurable.kind === "literal");
if (allStatic) {
  fctx.body.push({ op: "f64.const", value: computeRuntimeFlags(literalOf(descWritable), literalOf(descEnumerable), literalOf(descConfigurable), hasValue) });
} else {
  emitDynamicRuntimeFlags(ctx, fctx, descWritable, descEnumerable, descConfigurable, hasValue);
}
```

(`literalOf` returns `value` when `kind==="literal"`, else `undefined`.)

#### 3. Add `__to_boolean` host import

**File: `src/runtime.ts`** — add right next to the other primitive helpers (e.g. after `__box_number`):

```ts
if (name === "__to_boolean")
  return (val: any): number => (val ? 1 : 0);
```

ToBoolean in JS is identical to the truthy test (`!!val`); no spec deviation.

#### 4. Disable the struct fast path when any flag is dynamic

In `compileObjectDefineProperty`, after `parseFlagInitializer` runs, set `useStruct = false` if any of the three flags is `kind: "dynamic"`. The struct fast path stores compile-time-known booleans only; routing dynamic flags through the externref path means the JS host handles validation uniformly.

```ts
const anyDynamic =
  descWritable?.kind === "dynamic" || descEnumerable?.kind === "dynamic" || descConfigurable?.kind === "dynamic";
const useStruct = !anyDynamic && structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr;
```

---

### Phase 1B — Non-object descriptor argument throws TypeError (R5)

**File: `src/codegen/object-ops.ts`**, `compileObjectDefineProperty` (line 346):

After the `objArg` non-object guard (line 356), add a symmetric guard on `descArg`:

```ts
// ES spec §6.2.5.5 step 1: descriptor must be an object.
if (emitNonObjectDescGuard(ctx, fctx, descArg, "Object.defineProperty")) {
  fctx.body.push({ op: "unreachable" } as unknown as Instr);
  return { kind: "externref" };
}
```

Define `emitNonObjectDescGuard` as a sibling of `emitNonObjectArgGuard` (line 33) — same shape, but called for the descriptor and emits the spec-text error message `"TypeError: Property description must be an object: <value>"`. For *dynamic* descriptor expressions whose TS type is uncertain, emit a runtime guard that calls a new host import `__assert_desc_object(desc)` which throws when desc is `null`, `undefined`, or a primitive. (Adding the import follows the same `ensureLateImport` pattern.)

**`src/runtime.ts`**:

```ts
if (name === "__assert_desc_object")
  return (desc: any): void => {
    if (desc != null && typeof desc !== "object" && typeof desc !== "function") {
      throw new TypeError("TypeError: Property description must be an object: " + String(desc));
    }
    if (desc == null) {
      throw new TypeError("TypeError: Property description must be an object: " + String(desc));
    }
  };
```

Note: `_toPropertyDescriptorValidate` (runtime.ts:198) **already does** this check and is correct, but `__defineProperty_value` (line 2938) bypasses it because the codegen has pre-split value+flags. Either route through `_toPropertyDescriptorValidate` (preferred) by emitting `__defineProperty_full(obj, key, descObjExpr)` and deleting the split-flags fast path for unknown-shape descriptors, or insert the new `__assert_desc_object` guard upstream.

---

### Phase 1C — Mixed accessor + data descriptors throw TypeError (R4)

**File: `src/codegen/object-ops.ts`**, in `compileObjectDefineProperty` after the descriptor walk that fills `valueExpr` / `getNode` / `setNode` / `getExpr` / `setExpr` (around line 434):

```ts
const hasData = valueExpr !== undefined || descWritable !== undefined;
const hasAccessor = getNode !== undefined || setNode !== undefined || getExpr !== undefined || setExpr !== undefined;
if (hasData && hasAccessor) {
  // ECMA-262 §6.2.5.6 step 4 — Invalid property descriptor.
  emitThrowString(
    ctx,
    fctx,
    "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
  );
  fctx.body.push({ op: "unreachable" } as unknown as Instr);
  return { kind: "externref" };
}
```

(Compile-time check — the spec error must fire even if the rest of the body is unreachable.)

For the `defineProperties` path, the existing `isStaticDescWellFormed` (line 1461) already detects this — verify it falls through to the dynamic runtime which throws via `_toPropertyDescriptorValidate`. No change needed.

---

### Phase 2A — Redefinition validation when source object is opaque (R3)

The runtime helper `_validatePropertyDescriptor` (runtime.ts:139) is correct; the gap is in *plain JS* objects where the codegen's static struct path bypasses it.

**File: `src/codegen/object-ops.ts`**, in the struct fast path (lines 765-815) and the `defineProperties` struct path (lines 1639-1668):

These already emit static redefinition-violation throws (`emitThrowString("TypeError: Cannot redefine property")`). The bug is they only trigger when `ctx.definedPropertyFlags` has a *prior* entry — meaning *only* properties previously written by `defineProperty`. They miss:

1. Properties created by an object literal (`{ x: 1 }`) — these are configurable+writable+enumerable by default, so the validation passes. ✓ (no fix needed)
2. Built-in non-configurable properties (e.g. `Array.prototype.length`) — the codegen for those doesn't go through the struct path. Validated by the JS host. ✓
3. **Properties whose first defineProperty made them non-configurable via the externref path, then a second defineProperty hits the struct path.** This is the bug. The fix: when *any* prior call set non-configurable flags for `obj.prop`, every subsequent call on the same `(obj, prop)` must take the externref path so the runtime can validate. After the struct fast path completes, also call `__defineProperty_value(extObj, key, value, flags)` for the validation side-effect — OR simply force the externref path whenever `priorExistingFlags` is non-undefined and has `PROP_FLAG_CONFIGURABLE == 0`.

Concretely, in `compileObjectDefineProperty` after computing `priorExistingFlags`:

```ts
if (priorExistingFlags !== undefined && !(priorExistingFlags & PROP_FLAG_CONFIGURABLE)) {
  // Bypass struct fast path — route to runtime for full ValidateAndApplyPropertyDescriptor.
  return emitExternDefinePropertyValue(ctx, fctx, objArg, propArg, descArg, valueExpr!, literalOf(descWritable), literalOf(descEnumerable), literalOf(descConfigurable));
}
```

---

### Phase 2B — `defineProperties` filters inherited keys (R7)

**File: `src/runtime.ts`**, `__defineProperties` handler (line 3023):

For plain JS objects, line 3091 calls native `Object.defineProperties` which uses `[[OwnPropertyKeys]]` filtered to enumerable — already correct. The bug surfaces when the *descriptors object* is a WasmGC struct (line 3071) or when the runtime catches an opaque-object TypeError and falls into the manual loop (line 3098). In both branches:

```ts
const keys = getKeys(descsObj);
```

`getKeys` currently returns *all* own keys. The spec requires filtering by `enumerable: true` of the descriptor-map's *own* properties. Apply `[[OwnPropertyKeys]]` (already correct for plain JS via `Reflect.ownKeys`) **then** filter by `descsObj.propertyIsEnumerable(key)`:

```ts
const allKeys = getKeys(descsObj);
const keys: (string | symbol)[] = [];
for (const k of allKeys) {
  // For WasmGC structs, consult the sidecar descriptor map; for plain JS, use the native helper.
  if (_isWasmStruct(descsObj)) {
    const sDescs = _wasmPropDescs.get(descsObj);
    const flags = sDescs?.get(_normalizeDescKey(k));
    // Sidecar fields default to enumerable per the implicit "no descriptor = data property with all-true flags"
    // convention. Only filter out when flags exist AND enumerable bit is cleared.
    if (flags !== undefined && !(flags & _SC_ENUMERABLE)) continue;
  } else {
    if (!Object.prototype.propertyIsEnumerable.call(descsObj, k)) continue;
  }
  keys.push(k);
}
```

---

### Phase 3A — Configurable-aware delete verification (R6)

`#1334` landed the runtime side (`__delete_property` in runtime.ts:3626). Verify against `15.2.3.6-3-108.js` and `15.2.3.6-3-123.js` once Phase 1A makes the `configurable: -12345`/`configurable: this` cases store the correct flag. No code change expected; if tests still fail, the gap is in the delete codegen (`src/codegen/typeof-delete.ts:201`) where the property-access shape may bypass `__delete_property` when the receiver is a known struct field.

---

### Phase 3B — `op.endsWith is not a function` crash (R8)

This is `src/codegen/stack-balance.ts:376` reading `op` as something other than a string. The 3 crashing tests almost certainly hit a code path that pushes `{ op: <number>, ... }` or `{ ... }` (missing `op`) to `fctx.body`. Reproduce locally:

```bash
grep -l 'endsWith is not a function' /workspace/benchmarks/results/*.jsonl | head -1 | xargs -I{} jq -r 'select(.error|test("endsWith"))|.testFile' {} | head
```

Most likely cause: one of the `as unknown as Instr` casts in `object-ops.ts` (e.g. line 358 `{ op: "unreachable" } as unknown as Instr` is fine, but the `if` instr literal at line 754 with `blockType: { kind: "val", type: { ... } }` may be malformed when `structTypeIdx` is undefined). Add an assert in `stack-balance.ts:355`:

```ts
if (typeof op !== "string") {
  throw new Error(`stack-balance: non-string op in instr ${JSON.stringify(instr)}`);
}
```

Run the failing test against the unstripped error to find the offending push.

---

### Phase 3C — Property key formatting (R2)

`Object.defineProperty(obj, 1e+22, {})` — codegen currently routes through `emitExternDefinePropertyNoValue` which calls `compileExpression(propArg, { kind: "externref" })`. For a numeric literal that boxes via `__box_number`, then JS's native `ToPropertyKey` does `String(1e22) = "1e+22"`. **Verify** this works once Phase 1A lands; if the test still fails, the gap is that `compileExpression` for a numeric literal in externref context emits an unboxed `f64.const` rather than `__box_number`. Confirm by inspecting the compiled wasm for the test.

For object-with-`toString()` keys (`15.2.3.6-2-48.js`), the codegen sends the object as externref and native JS does ToPropertyKey including `toString` invocation. Same verification.

---

### WasmGC-specific constraints

- `_validatePropertyDescriptor` runs against the sidecar map (`_wasmPropDescs` WeakMap) — keys are externref identity, so any `extern.convert_any` -> ref-cast roundtrip that creates a *new* externref will lose validation history. The existing code uses `extern.convert_any` directly (lines 1054, 1287, 1363, 1896) precisely to preserve identity for `_wasmPropDescs` — do **not** introduce `coerceType(...)` here, it would call `__make_iterable` which allocates a fresh JS array (see `#856` / `#1092` comments).
- Adding `__to_boolean` and `__assert_desc_object` requires the **standalone mode** fallback (per CLAUDE.md "Dual-mode: JS host optional"). For ToBoolean, emit inline Wasm equivalent: `ref.is_null → 0, else 1` for ref values, `i32.ne 0` for numbers, `i32.const 0` for unbox+isNaN, etc. Gate via `ctx.standaloneMode`. For Phase 1A the JS host path suffices; standalone fallback can be a follow-up.
- Sidecar descriptors must use `_normalizeDescKey` (runtime.ts:118) for numeric/symbol parity — already done consistently.

### Edge cases to cover

1. `configurable: 0` → ToBoolean = false → property non-configurable (struct fast path must NOT bypass this).
2. `configurable: -0` → ToBoolean = false (same).
3. `configurable: NaN` → ToBoolean = false.
4. `configurable: ""` → ToBoolean = false. (string literal `""` is the only non-zero-length string falsy case)
5. `configurable: this` (global object) → ToBoolean = true.
6. `configurable: {}` → ToBoolean = true.
7. `configurable: null` / `undefined` → false; codegen should treat as `kind: "literal", value: false`. Note this differs from "attribute absent" (which leaves the flag unspecified → JS engine default false). The observable behavior is identical for `defineProperty`, so collapsing them is safe.
8. Mixed: `{ value: 1, writable: false, configurable: false }` redefined later as `{ value: 1, writable: false, configurable: false }` — SameValue, no throw.
9. Redefining with `{ value: -0 }` over a non-writable `+0` → TypeError (SameValue distinguishes signs).
10. Symbol-keyed `defineProperty` — works via host; the `_normalizeDescKey` already handles symbols. Verify after Phase 1A.
11. `Object.defineProperty(obj, "x", undefined)` → TypeError "Property description must be an object" — Phase 1B covers.
12. `defineProperty` on a frozen object → TypeError (already handled by `nonExtensibleVars` / `frozenVars` checks at lines 780, 850).

### Test files to verify

Primary regression set:
- `test/built-ins/Object/defineProperty/15.2.3.6-2-19.js` (numeric key 1e+22) → R2
- `test/built-ins/Object/defineProperty/15.2.3.6-2-48.js` (toString-based key) → R2
- `test/built-ins/Object/defineProperty/15.2.3.6-3-1.js` … `15.2.3.6-3-181.js` (flag coercion) → R1 (≥600 tests)
- `test/built-ins/Object/defineProperty/15.2.3.6-4-*.js` (redefinition violations) → R3
- `test/built-ins/Object/defineProperty/15.2.3.7-5-b-*.js` (mixed data+accessor) → R4
- `test/built-ins/Object/defineProperty/15.2.3.7-5-a-3.js` (inherited descriptor keys) → R7

Vitest coverage (`tests/issue-1460.test.ts`):

```ts
// R1
expect(run(`const o={}; Object.defineProperty(o, "x", { configurable: -12345 }); delete o.x; return o.hasOwnProperty("x");`)).toBe(false);
expect(run(`const o={}; Object.defineProperty(o, "x", { configurable: 0 }); return Object.getOwnPropertyDescriptor(o,"x").configurable;`)).toBe(false);
// R5
expect(() => run(`Object.defineProperty({}, "x", 0)`)).toThrow(/Property description must be an object/);
// R4
expect(() => run(`Object.defineProperty({}, "x", { value:1, get(){} })`)).toThrow(/Invalid property descriptor/);
// R3
expect(() => run(`const o={}; Object.defineProperty(o,"x",{value:1,configurable:false}); Object.defineProperty(o,"x",{value:2});`)).toThrow(/Cannot redefine property/);
// R7
expect(run(`const proto={inherited:{value:1}}; const descs=Object.create(proto); descs.own={value:2}; const o={}; Object.defineProperties(o,descs); return o.hasOwnProperty("inherited");`)).toBe(false);
// R2
expect(run(`const o={}; Object.defineProperty(o, 1e+22, {}); return o.hasOwnProperty("1e+22");`)).toBe(true);
// R6
expect(run(`const o={}; Object.defineProperty(o,"x",{configurable:false,value:1}); return delete o.x;`)).toBe(false);
```

### Risk & rollback

- The `useStruct` bypass in Phase 1A may **regress** existing tests that rely on the struct fast path for non-extensible objects. Mitigate by running `tests/equivalence.test.ts` after each phase. If a regression appears, narrow the bypass: only force externref when the flag is *dynamic*, not when *non-configurable was previously set*.
- Adding host imports `__to_boolean` and `__assert_desc_object` shifts function indices via `addUnionImports`; ensure all `ensureLateImport` + `flushLateImportShifts` calls follow the existing pattern (see CLAUDE.md "addUnionImports" note).
- Phase 1A changes the type of `descWritable` / `descEnumerable` / `descConfigurable` from `boolean | undefined` to `FlagValue` — all helper call sites (`computeRuntimeFlags`, `computeDescriptorFlags`, both `emitExternDefineProperty*`, and the inner `defineProperties` loop at line 1567+) must be updated together. Touch in one commit to keep the type-check green.
