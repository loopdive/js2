---
id: 2042
title: "standalone: Object.defineProperty/defineProperties residual — __obj_insert illegal cast + descriptor semantics over $Object (~340 tests)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property-descriptors
goal: standalone-mode
related: [1888, 1472, 1905, 739, 797]
test262_bucket: standalone-defineproperty
test262_count: 340
es_edition: es5
origin: "2026-06-10 standalone-vs-host baseline diff: 365 defineProperty + 177 defineProperties gap rows; ~217 are #1472/#1888-owned refusals, the rest are real standalone runtime bugs tracked here."
---

# #2042 — standalone defineProperty/defineProperties residual

## Problem

`built-ins/Object/defineProperty` (365 gap rows) + `defineProperties` (177)
split into three failure classes in standalone where host passes:

**A. Runtime trap — compiler bug (37+ rows):**
`illegal cast [in __obj_insert() ← __defineProperty_value ← test]`
e.g. `built-ins/Object/defineProperty/15.2.3.6-4-*`. The supported
`__defineProperty_value` fast path itself feeds `__obj_insert` a
wrongly-typed key or value (likely numeric/symbol key reaching the
string-keyed insert arm). This is the same `$Object` runtime as #2039's
`__obj_find` signature and could be fixed in the same slice.

**B. Wrong descriptor semantics — runtime asserts (~300 rows incl.
defineProperties):** tests that compile and run but fail
`verifyProperty(...)` / flag checks:

- `assert(accessed, 'accessed !== true')` — accessor `get`/`set` from the
  descriptor object never invoked,
- `assert.sameValue(beforeWrite, true, 'beforeWrite')` — ValidateAndApply
  ordering ([§10.1.6.3](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor)),
- `assert(propertyDefineCorrect, …)` — attribute defaults (writable/
  enumerable/configurable default **false** for fresh descriptors,
  [§6.2.6.6 CompletePropertyDescriptor](https://tc39.es/ecma262/#sec-completepropertydescriptor)),
- redefinition rejections that must throw TypeError and don't.

**C. Loud refusals (already owned — NOT this issue):** ~217 rows
`'__defineProperty_desc' … is not yet supported in --target standalone
(#1472 Phase B)` — accessor-descriptor support is #1888 Slice 5 (D5,
`$PropEntry` funcref slots). This issue should land after or alongside that
slice and re-measure.

## Suggested approach

1. Fix A first (small, mechanical): typed-key dispatch before `__obj_insert`
   — numeric and symbol keys must take their own arm or be normalized; add a
   brand check instead of an unconditional `ref.cast`.
2. For B: implement ValidateAndApplyPropertyDescriptor over the `$PropEntry`
   flag word — attribute defaults, [[Configurable]] transition rules, and
   TypeError on invalid redefinition. `verifyProperty` harness coverage makes
   the spec-order observable, so follow §10.1.6.3 step order exactly.
3. Re-run the defineProperty/defineProperties directories standalone and
   reassign any residual rows.

## Acceptance criteria

- 0 `illegal cast` rows under `built-ins/Object/defineProperty` standalone.
- `verifyProperty`-based attribute-default and redefinition tests pass
  (≥150 of the ~300 class-B rows).
- TypeError thrown (catchable) on invalid redefinitions — no traps.
- Host mode unchanged; equivalence test for numeric + symbol keys through
  `Object.defineProperty` in standalone.

## Implementation Plan (architect spec, 2026-06-13)

### Part A — `__obj_insert` illegal cast (37+ rows): the key is not ToString'd

**Root cause (precise).** `__obj_insert` (`src/codegen/object-runtime.ts:769`,
body `:640`) treats its `key` param as a string: the very first instructions
(`:642-644`) do `any.convert_extern(key)` → `ref.cast $AnyString`. The standalone
`$Object` runtime is **string-keyed by invariant** — every other write path
(member assign `obj[0]=x`) passes the key as an already-stringified string
literal (`src/codegen/expressions/assignment.ts:2500-2504`,
`compileStringLiteral(propName)` where `propName` is the canonical decimal).

But the defineProperty value path does NOT stringify. In
`emitExternDefinePropertyValue` (`src/codegen/object-ops.ts:1889-1899`) the prop
key is compiled with `compileExpression(propArg, { externref })`. For a
**numeric** key — `Object.defineProperty(o, 0, …)` (`15.2.3.6-4-*`) — that boxes
the *number* via `__box_number` into a boxed-number externref, NOT a string.
`__defineProperty_value` (`object-runtime.ts:3265`) passes it straight through
to `__obj_insert` (`:3256-3261`), whose `ref.cast $AnyString` then traps
**`illegal cast`**. Symbol keys hit the same cast.

**Fix.** ToPropertyKey the key before it reaches `__obj_insert`. ToPropertyKey
([§7.1.19](https://tc39.es/ecma262/#sec-topropertykey)) = `ToString` for
everything except Symbols (which stay symbols). For the string-keyed `$Object`
runtime, the data-property numeric-key case is just ToString. Two placement
options — recommend (1) for the smallest blast radius:

1. **At the call site (`object-ops.ts`, `emitExternDefinePropertyValue`
   `:1889-1899`):** after compiling `propArg` to externref, route it through the
   runtime ToString helper so the value handed to `__defineProperty_value` is
   always a `$AnyString` externref. Use **`__extern_toString`**
   (`object-runtime.ts:1754`) — it already maps a boxed number / value to a
   `$AnyString` (via `__any_to_string`). Numeric → canonical decimal string,
   matching how `{0:x}` / `obj[0]=x` store the key. This is symmetric with the
   accessor path (`emitExternDefinePropertyNoValue` /
   `__defineProperty_accessor`) — apply the SAME stringification there
   (`object-ops.ts` accessor branch + `__defineProperty_accessor`
   `object-runtime.ts:3392` key arg) or its symbol/numeric accessor keys trap
   identically.
2. **In the runtime (`__defineProperty_value` `object-runtime.ts:3253`):**
   call a ToString helper on the key before `__obj_insert`. More central (covers
   every caller) but mutates a hot runtime func and is harder to keep host-mode
   identical. Only if option (1) misses a caller.

- **Symbols:** the string-keyed `$Object` cannot represent symbol keys at all
  (the table keys are `$AnyString`). For a symbol key, ToPropertyKey must NOT
  ToString it (that would alias `Symbol("x")` to `"Symbol(x)"`). Standalone
  symbol-keyed defineProperty is **out of scope for Part A** — guard it:
  `ref.test` the key for the symbol carrier and **refuse-loud** (a `Codegen
  error:` / runtime TypeError) rather than mis-store or trap. Confirm whether
  any `15.2.3.6-4-*` row in the 37 actually uses a symbol key (most are numeric);
  numeric is the bulk and is fully fixable.

**Verify** the same key-coercion gap does NOT also live in `__extern_set`
(member write) — it does not, because that path stringifies at the AST. The bug
is specific to defineProperty's externref-key compilation.

### Part B — descriptor semantics / ValidateAndApply (~300 rows)

The standalone data path stores attributes in the `$PropEntry.flags` word
(`object-runtime.ts:163`, bits `FLAG_WRITABLE=0x01` / `FLAG_ENUMERABLE=0x02` /
`FLAG_CONFIGURABLE=0x04`, `:82-84`). Today `__defineProperty_value` masks the
descriptor's specified flags and inserts — it does NOT run
ValidateAndApplyPropertyDescriptor, so it gets attribute defaults, the
configurable-transition rules, and invalid-redefinition rejection wrong.

**Spec to implement exactly (observable via the `verifyProperty` harness):**
- **CompletePropertyDescriptor**
  [§6.2.6.6](https://tc39.es/ecma262/#sec-completepropertydescriptor): a fresh
  descriptor's unspecified `writable`/`enumerable`/`configurable` default to
  **false** (NOT `FLAG_DEFAULT`). `__defineProperty_value` already masks only
  specified bits via `NATIVE_ATTR_MASK` (`:3210`) — confirm an *unspecified*
  attribute on a NEW property lands as 0 (false), and crucially does NOT inherit
  `FLAG_DEFAULT`. This is the `propertyDefineCorrect` bucket.
- **ValidateAndApplyPropertyDescriptor**
  [§10.1.6.3](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor):
  on **redefinition** of an existing property, follow the step order:
  - If current is non-configurable: reject (TypeError in strict / per spec
    step 4) any attempt to change configurable→true, enumerable, change
    data↔accessor, or (for non-writable data) change writable→true / change
    value. Same-value redefinitions are allowed.
  - Apply only the fields present in the descriptor; absent fields preserve the
    current attribute (this is the redefinition vs. fresh-define distinction).
  - The `beforeWrite`/ordering asserts come from doing the validate BEFORE the
    apply, and from not writing the value when validation fails.
- **TypeError on invalid redefinition:** throw a **catchable** JS TypeError via
  the existing standalone helper pattern — `emitWasiErrorConstructor(ctx,
  "TypeError", 1)` → `__new_TypeError` (`object-runtime.ts:1570-1571` /
  `:3472-3473`) → `throw tagIdx`. The `__defineProperties` path already has a
  `throwTypeError(message)` closure (`object-runtime.ts:3529-3537`) — factor it
  out / reuse it for `__defineProperty_value`. NEVER `unreachable`/trap.

**Where:** extend `__defineProperty_value` (`object-runtime.ts:3253` area) to,
before `__obj_insert`:
1. `e = __obj_find(o, key)` — is this a redefinition?
2. If `e != null`: run ValidateAndApply against `e.flags` (configurable
   transition rules). On reject → throw TypeError (catchable). On accept →
   merge only specified fields into `e.flags`, set `e.value` only if `value`
   specified, return.
3. If `e == null`: CompletePropertyDescriptor (unspecified attrs = false),
   then `__obj_insert` with the completed flag word.

Reuse the `__defineProperties` descriptor-reader machinery
(`object-runtime.ts:3520-3600` region — `readBooleanFlag`, `hasField`,
`getField`, `setFlag`) so the two paths share spec-step logic instead of
diverging. **`Object.defineProperties` (177 rows)** is the same engine applied
per-key — fixing the per-key ValidateAndApply in a shared helper fixes both.

### Part C — accessor descriptors (~217 rows): OUT OF SCOPE

These refuse-loud today (`'__defineProperty_desc' … not yet supported …
(#1472 Phase B)`). Full accessor support is **#1888 Slice 5** (the
`$PropEntry.$get/$set` funcref slots + `__defineProperty_accessor` call-site
wiring, gated on the #329 funcIdx-stability fix — see the FOLLOW-UPS note at
`object-runtime.ts:3298-3308`). This issue lands AFTER or ALONGSIDE that slice;
do not attempt accessor `get`/`set` invocation here. Part A's symbol-key guard
must not regress the existing accessor refusals.

### Wasm IR pattern (Part A key coercion, call-site option)

```wasm
;; emitExternDefinePropertyValue, after compiling propArg to externref:
local.get $propKeyRaw       ;; boxed number / string externref
call $__extern_toString     ;; -> $AnyString externref (ToString); numeric → "0","5",...
local.set $propLocal        ;; now always string-keyed → __obj_insert ref.cast $AnyString OK
```

```wasm
;; Part B redefinition reject (inside __defineProperty_value):
local.get $o
...key...
call $__obj_find            ;; e
local.tee $e
ref.is_null
i32.eqz
if                          ;; existing property → validate
  ;; if (e.flags & FLAG_CONFIGURABLE)==0 && <changes configurability/enumerability/...>
  ;;   throwTypeError("Cannot redefine property: ...")   ;; catchable, NOT trap
end
```

### Edge cases
- **Numeric key canonical form:** `ToString(0)`→`"0"`, `ToString(1.5)`→`"1.5"`,
  `ToString(-0)`→`"0"`. Must match the `{0:x}` / `obj[0]=x` stringifier exactly
  or define + read miss each other. `__extern_toString`/`__any_to_string` is the
  shared canonical path — use it both sides.
- **`Object.defineProperty(o, k, { value: -0 })` on existing +0** (frozen):
  value-change rejection per §10.1.6.3 SameValue (not `===`) — there is already a
  -0 note in `object-ops.ts:1572`; ensure the native ValidateAndApply uses
  SameValue, not `f64.eq`, for the "is value actually changing" check.
- **Redefining a non-existent property on a non-extensible object:** per
  §10.1.6.3 must throw (or sloppy no-op) — `__obj_insert` already refuses new
  keys on `NON_EXTENSIBLE` (`:695-700`); the strict TypeError throw is the gap
  (currently a silent no-op, #1473-deferred). Surface it as TypeError here only
  if cheap; otherwise leave to #1473 and note it.
- **`writable:false` then write:** is enforced by the `__extern_set` FROZEN/flag
  gate, not this path — out of scope, but confirm the flags we store are the
  ones that gate reads.
- **Same-value redefinition of a non-configurable property:** allowed (no
  throw) — the validate must permit no-op redefinitions.
- **Symbol key:** refuse-loud (Part A), never ToString-alias.

### PR split
1. **PR-A (key cast fix):** ToString the defineProperty key at the call site
   (`object-ops.ts` value + accessor branches) + symbol-key refuse-loud guard.
   Small, mechanical; kills the 37 `illegal cast` rows. Scope: `object-ops.ts`
   (+ maybe `object-runtime.ts:3253` if option 2). **Developer-claimable.**
2. **PR-B (ValidateAndApply):** CompletePropertyDescriptor defaults +
   redefinition validation + catchable TypeError, shared with
   `__defineProperties`. Scope: `object-runtime.ts` (`__defineProperty_value` +
   shared descriptor helpers). Larger, spec-order-sensitive —
   **architect-reviewed / senior-dev.** Do PR-A first; PR-B builds on a
   non-trapping key.

### Regression risk
- ToString-ing the key changes the externref handed to `__defineProperty_value`
  — verify **host mode** is byte-identical (host `__defineProperty_value` is the
  JS import; the JS side already ToPropertyKeys its key, so stringifying the
  externref before the host call must not double-stringify a string key —
  `__extern_toString` on a string returns the same string, so it is idempotent;
  confirm with a host string-key spot-check).
- The ValidateAndApply additions run inside the hot `__defineProperty_value`
  native func; the new `__obj_find` pre-check adds one lookup per define — fine
  for conformance, watch any define-heavy benchmark. Gate nothing on target:
  the spec semantics are correct for both, but host mode delegates to the JS
  import so the native ValidateAndApply only executes standalone.
- funcIdx stability if a new shared throw/validate helper is registered —
  follow `ensureObjectRuntime` ordering discipline (`:120-145`).

### Test files to verify
- `built-ins/Object/defineProperty/15.2.3.6-4-*` (Part A) — standalone: no
  `illegal cast`; numeric-key define + read round-trips.
- `verifyProperty`-based attribute-default + redefinition rows under
  `built-ins/Object/defineProperty` and `defineProperties` (Part B) — ≥150 pass.
- New `tests/issue-2042.test.ts`: standalone `Object.defineProperty(o, 0, {value:5})`
  then `o[0] === 5`; fresh-define has `writable/enumerable/configurable === false`
  by default; redefining a non-configurable property throws a CATCHABLE TypeError
  (wrap in try/catch, assert caught); host mode same results.
