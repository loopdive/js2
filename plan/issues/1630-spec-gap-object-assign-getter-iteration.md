---
id: 1630
title: "spec gap: Object.assign drops getters / Symbol keys (27 of 38 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 56
renumbered_from: 1335
parent: 1328
---
# #1335 — Object.assign: getter invocation + Symbol-key copying

## Problem

`built-ins/Object/assign`: **11 / 38 pass (28.9%) — 27 fails (21 assertion_fail, 6 runtime_error)**.

Spec §20.1.2.1 (Object.assign) requires CopyDataProperties to:
1. Enumerate **own enumerable** keys (string + Symbol) of each source.
2. **Invoke getters** on the source — the call must observe the receiver as the source object.
3. **Set** (not DefineOwnProperty) on the target — so target setters and prototype setters are invoked.
4. Skip non-enumerable own keys.
5. Throw if any individual Get/Set throws (and stop the iteration).

The current implementation in `src/codegen/object-ops.ts` (look for `compileObjectAssign`) and the
host fallback `__object_assign` does:
- Iterates only **string** keys (not Symbol keys).
- Reads via direct field access — getters are not invoked on typed structs.
- Writes via direct field assignment — target setters not invoked.

## Acceptance criteria

1. `built-ins/Object/assign/source-own-prop-error.js` passes (getter throw aborts iteration).
2. `built-ins/Object/assign/target-set-symbol.js` passes (Symbol keys copied).
3. `built-ins/Object/assign/Symbol-keys.js` passes.
4. Pass-rate for `built-ins/Object/assign` rises from 29% to ≥75%.

## Files to modify

- `src/codegen/object-ops.ts` — Object.assign emitter
- `src/codegen/property-access.ts` — common get/set with getter/setter invocation
- `src/runtime.ts` — `__object_assign` host fallback (mostly correct already; verify Symbol key handling)

## Implementation Plan (architect, 2026-05-27 — supersedes the original plan above)

> The original plan (two-phase fast/slow Object.assign loop) was written against a
> mental model that turned out to be wrong: there is **no `compileObjectAssign`**,
> and `__object_assign` already delegates to the host `Object.assign` over a
> live-mirror Proxy (`_wrapForHost`). The dev-1568 investigation below pinpointed
> the real defect. This plan addresses **only the in-scope slice of #1630: the
> struct-target writeback gap.** The descriptor-attribute / freeze-seal / wrapper-
> valueOf failures are separate root causes and are split out (see "Out of scope").

### Root cause (verified against current main)

The compiler emits per-field **getter** exports `__sget_<name>(externref) -> {externref|f64|i32}`
(`emitStructFieldGetters` → `buildNestedIfElse`, `src/codegen/index.ts:1258-1351`) but emits
**no corresponding setter** export. There is no `__sset_<name>` anywhere in `src/` — confirmed by
grep.

Consequences in the runtime write path:

- `__object_assign` (`src/runtime.ts:4815-4833`): when the target `_isWasmStruct`, it wraps the
  target in a `_wrapForHost` Proxy and runs host `Object.assign(wrappedTarget, ...wrappedSources)`.
  Each copied property fires the Proxy `set` trap (`src/runtime.ts:2177-2180`) → `_safeSet`.
- `_safeSet` for a WasmGC struct (`src/runtime.ts:1793-1841`) does `obj[key] = val` — which is a
  **silent no-op for a real (typed) struct field** (V8 will not write a WasmGC struct slot via JS
  bracket assignment) — and then `_sidecarSet(obj, key, val)` stashes the value in the JS-side
  sidecar map (`_wasmStructProps`).

The read path is **asymmetric**: compiled Wasm code reads `tgt.a` via `struct.get` on the real
field, which still holds its initial value (0). The sidecar copy is invisible to compiled code.
(The host Proxy `get` reads sidecar-first in `safeGetField`, `src/runtime.ts:2057-2059`, which is
why a *host-side* read of the proxy appears to "work" while the compiled program sees 0 — masking
the bug in some probes.) Net effect: `Object.assign(typedStruct, src)` leaves the struct's real
fields unchanged. This is the dev-1568 symptom "both `tgt.a` and `tgt.b` stay 0", and it is the
mechanism behind the `Override*` / `Target-Object` / writeback-dependent failures.

### Chosen approach — (B) runtime dispatch + emit symmetric struct-field setters

Of the three options posed:

- **(A) compile-time property-by-property copy** — rejected: requires both operands to be
  statically known typed structs; fails for dynamic (`externref`) targets and for `{} as any`
  targets, which is exactly the spread of cases in test262. Also re-implements the Get/Set/
  enumerable protocol in codegen, duplicating logic the host already does correctly for plain
  objects.
- **(C) wrap target in externref + reflect back** — rejected: there is no "reflect back" hook today;
  the missing piece *is* the writeback, so this collapses into the same problem.
- **(B) runtime dispatch** — chosen. Keep the existing `__object_assign` dispatch (`externref`
  target → host `Object.assign`; struct target → `_wrapForHost` + host `Object.assign`). The host
  already enumerates own-enumerable string **and** Symbol keys and invokes source getters correctly
  for the Proxy mirror. The single missing capability is: **`_safeSet` must be able to write a real
  WasmGC struct field.** Provide that by emitting `__sset_<name>` setter exports symmetric to the
  existing `__sget_<name>` getters, and calling them from `_safeSet`.

This handles dynamic targets correctly: the dispatch is purely runtime (`_isWasmStruct(target)`),
so a target whose compile-time type is `externref` takes whichever branch matches its *runtime*
identity. No compile-time type knowledge of the operands is required.

### Changes

**File: `src/codegen/index.ts`**

1. Add `emitStructFieldSetters(ctx)` mirroring `emitStructFieldGetters` (line 1258). Call it
   immediately after each existing `emitStructFieldGetters(ctx)` call site (lines 1085 and 3231).
   - Reuse the exact `fieldMap` construction from `_emitStructFieldGettersInner` (lines 1270-1299):
     same struct/field iteration, same skip rules (`Wrapper*`, `$AnyValue`, `__vec_*`, `__arr_*`,
     names starting with `$`).
   - **Only emit a setter for mutable fields.** Object-literal fields are created with
     `mutable: true` (line 7343), so they qualify; skip any entry whose field `mutable` is false
     (the boxed-number/i32 singleton structs at lines 6374/6381 are immutable and must be skipped —
     `struct.set` on an immutable field is a validation error).
   - Setter signatures (3 variants, by field type, mirroring the getter type triple at 1307-1309):
     - `__sset_<name>(externref /*obj*/, externref /*val*/) -> []` for ref fields
     - `__sset_<name>(externref, f64) -> []` for f64 fields
     - `__sset_<name>(externref, i32) -> []` for i32 fields
     When a field name maps to entries of mixed kinds across struct types, take the externref
     variant and unbox per-branch (mirror the `returnMode === "extern"` getter logic, inverted:
     for an f64 target field unbox the incoming externref via the existing number-unbox path; for
     i32, unbox then `i32.trunc_*`/`f64`→`i32`). Prefer to keep this simple: if mixed-kind handling
     is fiddly, emit a setter only for the homogeneous-kind fields and let mixed-kind fields fall
     back to sidecar (document the gap) — homogeneous covers the test262 cases.
   - Body, per entry, mirrors `buildNestedIfElse`/`buildGetterExtract` (lines 2947-3011) but with
     `struct.set` instead of `struct.get`:
     ```wasm
     local.get 0            ;; obj: externref
     any.convert_extern
     local.tee $any
     ref.test  $StructT
     if
       local.get $any
       ref.cast $StructT
       local.get 1          ;; val (coerce to field type here)
       struct.set $StructT <fieldIdx>
     end                    ;; else: fall through (next ref.test or no-op)
     ```
     Chain the `ref.test` ladder exactly like the getter's nested-if, but the block type is `[]`
     (no result) and the final else is empty (no-op — value simply lands only in the sidecar, as
     today, for unrecognized struct types).
   - Wrap the whole thing in the same try/catch-swallow as `emitStructFieldGetters` (lines
     1258-1265) so a setter-emission failure is non-fatal (module still runs, writeback degrades to
     sidecar-only — i.e. current behavior).

**File: `src/runtime.ts`**

2. In `_safeSet`, for the `_isWasmStruct(obj)` branch (after the existing `__set_<key>` accessor-
   setter check at lines 1795-1802, and after the descriptor writable / non-extensible guards at
   1803-1821, before the `obj[key] = val` no-op at 1822-1827): attempt the real struct-field write
   via the new export.
   ```ts
   if (typeof key === "string" && exports) {
     const setter = exports[`__sset_${key}`];
     if (typeof setter === "function") {
       try { setter(obj, val); } catch { /* not a field of this struct type */ }
     }
   }
   ```
   Note `_safeSet` currently has no `exports` in scope — it's a free function. Thread `exports`
   through: `_safeSet` is reached from (a) the `_wrapForHost` `set` trap (line 2178, where `exports`
   is the closure param) and (b) the `__extern_set` host import (line 3305) and `__set_member`
   (line 2920). Add an optional 4th parameter `exports?: Record<string, Function>` to `_safeSet`,
   pass it from the `set` trap and from the `callbackState?.getExports()` sites; default `undefined`
   keeps existing callers safe (they fall back to sidecar-only, current behavior). Keep the
   `_sidecarSet` call as well — the sidecar must stay in sync so host-side reads, `Object.keys`,
   `JSON.stringify`, and dynamic (non-field) keys keep working.

3. Leave `__object_assign` (lines 4815-4833) **unchanged** — once `_safeSet` can write the real
   field through the Proxy `set` trap, struct-target assign reflects back automatically. Verify
   only that `_wrapForHost` is created with a non-undefined `exports` at the assign call site
   (line 4823 passes `exports = callbackState?.getExports()` — OK).

### Edge cases

- **Source is `null`/`undefined`** → host `Object.assign` already skips these; `wrappedSources`
  maps them through unchanged (only `_isWasmStruct` sources are wrapped). No change needed.
- **Source is a non-object primitive** (number/string/boolean) → host `Object.assign` boxes/ignores
  per spec; unchanged.
- **Setter on the target** (`Object.defineProperty(tgt, k, {set})`) → already handled first in
  `_safeSet` (the `__set_<key>` sidecar-accessor check at 1795-1802 runs before the new `__sset_`
  write and `return`s, so the accessor wins over the struct field — correct, an accessor shadows
  the data field).
- **Target field is non-writable / target frozen / non-extensible** → the existing guards at
  1803-1821 run *before* the new `__sset_` call and `return` early, so writeback is correctly
  suppressed. (Full freeze/seal *throwing* semantics are a separate root cause — see Out of scope.)
- **Symbol-keyed source property → struct field** → struct fields only have string names, so a
  Symbol key never matches an `__sset_`; it stays sidecar-only via the existing symbol path
  (1828-1839). Correct.
- **Mutable vs immutable field** → only mutable fields get a setter; immutable singleton structs
  (boxed number/i32) are skipped at emission to avoid `struct.set` validation errors.
- **Unknown struct type at runtime** (no matching `ref.test`) → setter is a no-op; value remains in
  sidecar exactly as today. No regression.

### Out of scope — split into follow-up issues (per dev-1568 decomposition)

These share the file but are independent root causes; do **not** attempt them under #1630:

1. Descriptor attributes (`enumerable`/`writable`) not honored on the struct mirror —
   overlaps the `Object.defineProperty` object-model. (`source-non-enum`, `target-set-not-writable`)
2. `freeze`/`seal`/`preventExtensions` not *throwing* a TypeError on Set (currently silent no-op).
   (`target-is-frozen-*`, `target-is-sealed-*`, `target-is-non-extensible-*`)
3. Boxed wrapper `.valueOf()` round-trip for `Target-Number`/`Target-String`/`Target-Boolean`
   (shared with #1568).
4. Getter-invocation **order** logging + Proxy `ownKeys` ordering (`strings-and-symbol-order*`,
   `source-own-prop-*-error`) — needs a real per-key ordered Get/Set protocol over structs.

### Estimated test impact

- **Direct target of this fix**: the struct-target-writeback failures in `built-ins/Object/assign`
  (`Override-*`, `Target-Object`, and any plain-data-copy case where the target is a typed struct).
  Realistically lifts the suite from 15/38 toward the high-teens/low-20s — **not** to the original
  ≥75% acceptance target, because that target conflated four independent root causes (now split
  out). Recommend the PO **revise acceptance criterion #4** down to the writeback slice (e.g.
  "Override*/Target-Object cases pass; pass-rate +≥4 tests") and track the rest under the follow-up
  issues above.
- **Cross-suite upside**: `__sset_` + `_safeSet` writeback also fixes any host MOP write into a
  typed struct field — `Reflect.set`, `Object.defineProperty` data writes, spread-into-typed-object
  — so watch `built-ins/Reflect/set`, `built-ins/Object/defineProperty`, and object-spread cases for
  incidental gains. Possible (small) risk: previously-silent sidecar-only writes now mutate the real
  field; if any test relied on a field staying at its initial value while the sidecar diverged, it
  could flip. Low likelihood; CI bucket-by-path diff will surface it.
- **No new host import** (setter is a compiled export, consistent with the dual-mode principle); no
  `addUnionImports` index-shift concern.

### Verify-after-implementation checklist (for the reviewing architect / dev)

- `grep -r __sset_ src/` shows the new emitter + the `_safeSet` call.
- A probe: `const t = {a:0,b:0}; Object.assign(t, {a:7,b:9}); /* compiled */ t.a + t.b === 16`
  (read via compiled code, not just host Proxy) — must be 16, currently 0.
- Immutable-struct probe (boxed number) does not throw a validation error at module instantiation.

### Test262 sample

- `test262/test/built-ins/Object/assign/Override-not-affected-by-Object-prototype-Symbol-property.js`
- `test262/test/built-ins/Object/assign/target-Object.js` (writeback into typed target)
- `test262/test/built-ins/Object/assign/source-own-prop-error.js` (getter-throw — host already aborts)

## Investigation (2026-05-27, dev-1568) — MIS-SCOPED, needs decomposition

Reproduced against current main. Baseline JSONL (May 25): **15 pass / 23 fail**.
The task title ("Object.assign drops getters / Symbol keys") does **not** match
the actual failures — getters and Symbol keys already work via host delegation.
Verified with direct probes:

- `Object.assign(plainTgt, {get a(){return 7}})` → `tgt.a === 7` ✅ (getter invoked)
- `Object.assign(plainTgt, symbolKeyedSrc)` → Symbol copied ✅
- `Object.assign(plainTgt, nonEnumSrc)` → **copies non-enumerable** ❌ (root cause is
  `Object.defineProperty enumerable:false` not honored on the struct mirror — NOT assign)

The decisive split: target type, not source accessors.
- target is plain externref (`{} as any`) → assign fully correct.
- target is a **typed wasmGC struct** (`{a:0,b:0}`) → **both** getter-sourced and plain
  data writeback fail (`tgt.a` and `tgt.b` both stay 0). The bug is the
  `_wrapForHost` **set-trap → `__sset_` struct-field writeback**, an object-model
  mirror gap, not Object.assign logic.

The 23 fails decompose into ≥4 independent root causes, none a localized assign fix:
1. **Struct-target writeback** via `_wrapForHost` set-trap (`Override*`, `Target-Object`).
2. **Descriptor attributes** enumerable/writable not honored on struct mirror
   (`source-non-enum`, `target-set-not-writable`) — overlaps `Object.defineProperty` model.
3. **freeze/seal/preventExtensions** not enforced → Set doesn't throw TypeError
   (`target-is-frozen-*`, `target-is-sealed-*`, `target-is-non-extensible-*`).
4. **Boxed wrapper `.valueOf()`** round-trip (`Target-Number/String`) — same
   limitation noted in #1568, shared by number/string/boolean wrappers.
5. Getter-invocation **order** logging + Proxy ownKeys (`strings-and-symbol-order*`,
   `source-own-prop-*-error`) — depends on a real per-key Get/Set protocol over structs.

**Recommendation**: re-route to architect for an object-descriptor-model spec, or
split into sub-issues (struct-writeback mirror; descriptor attributes; freeze/seal
enforcement; wrapper valueOf). The current single "medium / localized to
object-ops.ts" framing is not achievable — `compileObjectAssign` does not even exist;
assign already delegates to host `__object_assign` which is correct for plain objects.
