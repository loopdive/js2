---
id: 1589A
parent: 1589
title: Fix object-literal field-type inference + __extern_has_idx null semantics for Array.prototype.{indexOf,lastIndexOf}.call on length=2^32 array-likes
status: ready
sprint: 55
priority: medium
feasibility: hard
type: bug
area: codegen+runtime
labels: [test262, codegen, runtime, struct-inference, has-property]
---

## Recap (from #1589 Findings — Hot spot A)

Three test262 entries currently hang for ~30s and pin the `compile_timeout`
budget (which is really wall-time of compile + execute in one fork; the
hang is in the executing Wasm `test()` function, not the compiler):

- `built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js`
- `built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js`
- `built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js`

All three follow the same shape:

```js
var targetObj = {};
var obj = {
  0: targetObj,
  4294967294: targetObj,
  4294967295: targetObj,
  length: 4294967296
};
assert.sameValue(Array.prototype.indexOf.call(obj, targetObj), 0, ...);
```

The expected answer is `0` (target lives at index 0, search hits on the
first iteration). We return after ~900M iterations of a 4.29B-iteration
loop because of two compounding bugs:

### Bug 1 — codegen: wrong struct field type for `{}`-valued properties

`compileObjectLiteralForStruct` (delegating through
`ensureStructForType` in `src/codegen/index.ts`) infers the field types
for the literal `{ 0: targetObj, 4294967294: targetObj, ... }`. The
empty-object value `targetObj = {}` is widely typed (the symbol's
declared type has no useful shape), and the resolver picks the
`Test262Error` struct (typeIdx 13 in the agent's repro). The resulting
struct definition is:

```
(struct (field $0 (mut (ref null 13)))
        (field $4294967294 (mut (ref null 13)))
        (field $4294967295 (mut (ref null 13)))
        (field $length (mut f64)))
```

At construction time, `targetObj` is an externref `{}`. The codegen
attempts to coerce externref → `ref null 13`, which fails the
`ref.test`, so it stores `ref.null 13` in those fields. Reading the
field back through `__sget_0(obj)` returns `null`.

### Bug 2 — runtime: `__extern_has_idx` treats "present but null" as "absent"

`src/runtime.ts` ~line 3170, the `__extern_has_idx` host import:

```ts
const exports = callbackState?.getExports();
if (typeof exports?.[`__sget_${strKey}`] === "function") {
  try {
    const v = exports[`__sget_${strKey}`](obj);
    if (v != null) return 1;     // <-- only counts as "present" if non-null
  } catch { /* not a field on this variant */ }
}
return 0;
```

When the field is structurally present but its value is null (Bug 1's
output), `__extern_has_idx` reports "no property at index i" and the
caller's loop never short-circuits. Spec HasProperty (§7.3.12) returns
*true* for any own property regardless of value, including `null`.

### Combined effect

`Array.prototype.indexOf.call(obj, target)` reads `len = 4_294_967_296`
from the struct's `length` field, then iterates `i = 0..len-1`. At
i=0 the field is present (so spec says "compare obj[0] === target"
which would succeed), but Bug 2 reports HasProperty=false because Bug 1
stored null. The loop scans ~30M iterations/sec × 30s = ~900M
iterations before the test262 fork-pool kills it.

## Affected tests

1. `test/built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js` — `length: 4294967296` boundary
2. `test/built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js` — same shape, `length: 4294967297`
3. `test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js` — mirror of #1 for lastIndexOf

All three pass instantly once HasProperty returns true on index 0.

## Implementation Plan

Two surgical fixes — keep them in **one PR** because each is unsafe on
its own (Bug 1 fix without Bug 2 fix still mis-types the struct;
Bug 2 fix without Bug 1 fix still loses the value of `obj[0]`
when later code reads it via `__extern_get_idx`).

### Step 1 — Bug 1: widen field type when value type is unresolvable

**File:** `src/codegen/index.ts`
**Function:** `ensureStructForType` (line ~6186), specifically the field-
type-resolution loop at line 6266-6318.

Current shape:

```ts
for (const prop of props) {
  const propType = ctx.checker.getTypeOfSymbol(prop);
  ensureStructForType(ctx, propType);
  let wasmType = resolveWasmType(ctx, propType);
  // ... undefined/void widening guard at line 6288-6299 ...
  // ... valueOf/toString → eqref guard at line 6303-6305 ...
  fields.push({ name: prop.name, type: wasmType, mutable: true });
  // ...
}
```

The bug: `resolveWasmType` for an empty-object property type follows the
"Auto-register anonymous object types" branch at line 6113-6121:

```ts
if (!anonName && (name === "__type" || name === "__object") && tsType.getProperties().length > 0) {
  ensureStructForType(ctx, tsType);
  const registeredName = ctx.anonTypeMap.get(tsType);
  if (registeredName && ctx.structMap.has(registeredName)) {
    return { kind: "ref", typeIdx: ctx.structMap.get(registeredName)! };
  }
}
```

For `targetObj = {}` the inner `tsType.getProperties().length` is 0, so
this branch is skipped and we fall through to `mapTsTypeToWasm` →
returns `externref`. *That part is correct.* But before the loop in
`ensureStructForType` reaches `resolveWasmType`, it already recursed
into `ensureStructForType` for the prop type (line 6269). For
property types that match an existing anon struct (because of
structural dedup via `anonStructHash`), the dedup table may map
`{}` → an existing struct that *happens* to have zero fields (e.g.
`Test262Error`'s instance shape, if it gets registered with empty
fields).

The fix has two parts.

**1a. Reject ref-typed `wasmType` when it points at a struct that is
not structurally compatible with the prop's TS type.**

In the field-resolution loop (line 6266-6318), after `resolveWasmType`
returns, add a guard:

```ts
// (#1589A) When the resolved type is a ref to a struct that has no
// declared structural relationship to this property's TS type (e.g.
// dedup collapsed {} onto an unrelated empty struct), widen the
// field to externref. Storing null in a ref field for a value that
// is actually a host externref breaks HasProperty semantics in the
// __extern_has_idx host import.
if (wasmType.kind === "ref" || wasmType.kind === "ref_null") {
  const refTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
  const refStructName = ctx.typeIdxToStructName.get(refTypeIdx);
  // The dedup table can route {} (zero-property TS type) onto any
  // struct whose anon-hash key is the empty string. Always widen to
  // externref in that case.
  const propHasOwnProps = propType.getProperties().length > 0;
  if (!propHasOwnProps && refStructName && refStructName !== "__Date") {
    wasmType = { kind: "externref" };
  }
}
```

**1b. Alternative (preferred if 1a triggers regressions): tighten the
dedup hash to disambiguate empty struct shapes.**

In `fieldsHashKey` (line 6151), append a sentinel for empty field
lists so two empty structs only dedup if they share an additional
discriminator. Track this via a comment pointing back to #1589A.

```ts
function fieldsHashKey(fields: FieldDef[]): string {
  if (fields.length === 0) {
    // (#1589A) Empty-shape dedup is dangerous when the value side is
    // a real externref ({} target). Force every empty literal to its
    // own struct so an existing empty named struct (e.g. Test262Error)
    // never absorbs anonymous {} literals.
    return `__empty_${Math.random()}`; // or a counter from ctx
  }
  // ... existing implementation
}
```

(Prefer 1a — it's narrower. Use 1b only if 1a regresses the
existing `valueOf`/`toString` callable-property dedup tests.)

**Verify the path with a probe** before landing:

```bash
node --no-warnings .tmp/probe-struct-keys.mts  # from the #1589 investigation worktree
```

The probe should print field types of the compiled obj struct. After
the fix, fields `0`, `4294967294`, `4294967295` should be `externref`,
not `(ref null 13)`.

### Step 2 — Bug 2: HasProperty returns 1 for "present but null"

**File:** `src/runtime.ts` (~line 3170, the `__extern_has_idx` import
case in `_makeHostImportFactory` or the equivalent factory).

Current:

```ts
const exports = callbackState?.getExports();
if (typeof exports?.[`__sget_${strKey}`] === "function") {
  try {
    const v = exports[`__sget_${strKey}`](obj);
    if (v != null) return 1;
  } catch {
    /* not a field on this variant */
  }
}
return 0;
```

Fix:

```ts
const exports = callbackState?.getExports();
if (typeof exports?.[`__sget_${strKey}`] === "function") {
  try {
    // (#1589A) HasProperty (spec §7.3.12) returns true for any own
    // property regardless of value — including null. Only treat the
    // getter as a "no such field on this variant" signal when it
    // throws (i.e., the struct type doesn't define that field at
    // all), not when it returns null/undefined.
    exports[`__sget_${strKey}`](obj);
    return 1;
  } catch {
    /* getter not defined for this struct variant — fall through */
  }
}
return 0;
```

Key change: drop the `if (v != null)` check; getter *successfully
returning* (even null) means the field exists on this struct shape.

**Audit the symmetric path: `__extern_has` (line ~3213).** The
agent's finding notes it "mirrors `__extern_has_idx`" but its current
implementation uses `key in obj` (correct HasProperty) and a
`_sidecarGet` fallback. Check whether `__extern_has` has the same
"present but null" issue when it consults a struct getter; apply the
same fix there if so.

### Step 3 — runtime audit: where else does "null payload = absent"
leak in?

Grep:

```bash
rg "__sget_" src/runtime.ts
```

For each call site that reads a struct getter result, confirm whether
"null" should mean "absent" or "field present with null value". The
following sites are likely candidates:

- `__extern_get_idx` (line ~3160 region) — for *get*, returning the
  null payload as the value is correct (it's what the field holds).
  No change needed; document the asymmetry with a comment.
- `__extern_get` (string-keyed get fallback) — same as `__extern_get_idx`.
- Any `_in_` / `_has_` family helpers — apply the same fix as Step 2.

## Risk

The Bug 1 fix is the high-risk part. `ensureStructForType` is the
spine of every anonymous-object-literal codegen path; widening to
externref where we currently emit a ref-to-struct loses some method-
call dispatch speed and may shift call-site resolution from
`compileStructMethodCall` to `compileCallablePropertyCall`.

### Call surface inventory (places that consume the registered struct shape)

Run before landing:

```bash
rg -n "ensureStructForType|anonStructHash|anonTypeMap|structFields\.get" src/codegen/ | wc -l
# Currently ~65 references across:
#   src/codegen/literals.ts        (object literals + spreads)
#   src/codegen/closures.ts        (param-type struct registration)
#   src/codegen/declarations.ts    (return-type + param-type registration)
#   src/codegen/destructuring-params.ts
#   src/codegen/index.ts           (the function itself + resolveWasmType)
#   src/codegen/statements/destructuring.ts
```

The widening from `ref` to `externref` only fires when:
- The prop's TS type has zero own properties (empty `{}`), AND
- The current resolved type is a `ref` / `ref_null` to a named or anon
  struct.

This combination is rare in well-typed code (a property whose value
type is `{}` is unusual outside of test262 patterns and dynamic
loaders). Tighter risk: Test262Error (and other zero-field named
structs) never get incorrectly assigned as field type.

### Test plan

1. **Scoped equivalence** (must pass before push):
   - Add `tests/issue-1589a.test.ts` exercising the test262 shape directly:
     ```ts
     it("Array.prototype.indexOf.call works on object with empty-object values and length 2^32", () => {
       const src = `
         var targetObj = {};
         var obj = { 0: targetObj, 4294967294: targetObj, 4294967295: targetObj, length: 4294967296 };
         var result = Array.prototype.indexOf.call(obj, targetObj);
         result;
       `;
       expect(runWasm(src)).toBe(0);
     });
     ```
   - Add a sibling test for the lastIndexOf flavor.
   - Add a regression test for plain `Test262Error` construction to
     confirm we didn't break the dedup-collapse path: compile a fixture
     that creates a `Test262Error` and verify field reads still work.

2. **Full `npm test`** (vitest) — the equivalence suite is the
   strongest guard against the dedup-tightening risk.

3. **Targeted test262 spot-check** locally:
   ```bash
   POOL_SIZE=1 TIMEOUT_MS=15000 npx tsx .tmp/probe-pool.mts \
     test/built-ins/Array/prototype/indexOf/15.4.4.14-3-28.js \
     test/built-ins/Array/prototype/indexOf/15.4.4.14-3-29.js \
     test/built-ins/Array/prototype/lastIndexOf/15.4.4.15-3-28.js
   ```
   (Probe artifacts live in the #1589 investigation worktree;
   `.tmp/probe-pool.mts` documented in `1589-...md`.)

4. **Full test262 CI** — the PR's CI run is the final acceptance gate.
   Watch for regressions in:
   - `built-ins/Array/prototype/*` (callable property dispatch)
   - `built-ins/Error/*` and `built-ins/NativeErrors/*` (Test262Error
     dedup collateral)
   - any test that uses `{ valueOf() { ... } }` literal patterns
     (struct dedup with method signatures)

### Acceptance criteria

- All 3 affected test262 tests transition from `compile_timeout` →
  `pass` in the baseline diff.
- `__sget_<i>` returning null is reported as HasProperty=true by
  `__extern_has_idx` (verifiable via `.tmp/probe-has-idx.mts`).
- No regressions ≥ 5 tests in any single test262 bucket.
- The equivalence test suite passes locally before push.

## Related

- Parent: #1589 (investigation; see Findings → Hot spot A)
- Sibling: #1589B (Hot spot B — toSorted closure-throw); separate PR
- Sibling: #1589C (Hot spot C — eval-in-loop skip filter); separate PR
- Repro artifacts (from #1589 investigation): `.tmp/probe-pool.mts`,
  `.tmp/probe-has-idx.mts`, `.tmp/probe-struct-keys.mts`,
  `.tmp/probe-trace2.mts`
