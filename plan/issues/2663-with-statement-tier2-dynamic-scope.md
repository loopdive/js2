---
id: 2663
title: "feat: `with` statement Tier 2 — dynamic-scope fallback (de-skip the 294 test262 WithStatement tests; landing page shows unsupported)"
status: in-progress
assignee: ttraenkler/dev-conformance
created: 2026-06-25
updated: 2026-08-04
priority: medium
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen, ir
language_feature: with
goal: spec-completeness
depends_on: [1387, 2580]
needs_arch_spec: false
sprint: 67
loc-budget-allow:
  # Slice 3 (`with` read-modify-write) needs a dispatch hook at the two places
  # the compiler decides how an identifier LHS is updated. Both are the sole
  # entry points for their node kind, so the hook cannot live anywhere else; all
  # of the new LOGIC is in the new file src/codegen/with-rmw.ts (0 god-file
  # growth). operator-assignment.ts: +8 (compound-assign dispatch + import).
  - src/codegen/expressions/operator-assignment.ts
  # unary-updates.ts: +17 (++/-- prefix and postfix dispatch + import).
  - src/codegen/expressions/unary-updates.ts
func-budget-allow:
  # Same two dispatch hooks. Both functions are the single switch over how an
  # identifier LHS is updated, and the `with` Object Environment Record must be
  # consulted BEFORE the const/local/global arms they already contain — so the
  # check has to sit inside them (+7 / +10 lines). The body it dispatches to is
  # in src/codegen/with-rmw.ts.
  - src/codegen/expressions/operator-assignment.ts::compileCompoundAssignment
  - src/codegen/expressions/unary-updates.ts::compilePrefixUpdate
# (#1917/#2108 coercion-sites gate) with-rmw.ts: 0 -> 1 (__unbox_number).
# A read-modify-write through a `with` scope reads an externref out of the
# Object Environment Record, applies an f64 operator, and writes it back — so
# the unbox is intrinsic to the operation, not incidental. It DELEGATES to the
# engine's existing helper by funcMap name (`__unbox_number`, paired with
# `__box_number` on the way out) and hand-rolls no ToString/ToNumber/ToPrimitive
# matrix, which is what the gate actually guards against; the gate counts the
# reference. This follows the #4160 precedent for delegating-by-name rather
# than the discouraged pattern. If the single coercion engine grows an entry
# point for "unbox, apply numeric op, rebox", this is a one-call rewrite.
coercion-sites-allow:
  - src/codegen/with-rmw.ts
---

# #2663 — `with` statement Tier 2: dynamic-scope fallback

## Why this exists (landing-page "not supported")

The landing-page feature report (`website/public/benchmarks/feature-report.html`)
derives each feature's status from **test262 category pass/total counts**. The
`with` category is overwhelmingly failing, so `with` shows as **not supported**
— even though **Tier 1 already shipped** (#1387, sprint 61, PR #1272).

## Current state

- **Tier 1 (DONE, #1387):** `src/codegen/with-scope.ts` `compileWithStatement`
  handles `with(target){…}` *only when* the target lowers to a WasmGC struct
  with a **statically closed shape** (literal keys resolvable at compile time).
  Bare identifiers in the block that match a known struct field are routed to
  that field; otherwise `reportWithStatementDiagnostic` fires and the statement
  is unsupported.
- **Tier 2 (THIS ISSUE, deferred at #1387):** the **dynamic-scope** case — a
  bare identifier inside `with(obj){}` may resolve to a *runtime* property of
  `obj` whose shape is not statically known. This is the bulk of the **294**
  test262 `WithStatement` tests and the reason the feature reads unsupported.
  #1387's feasibility note: Tier 2 "is hard and overlaps the
  object-representation ceiling."

## Scope

1. **Architect spec first (`needs_arch_spec`)** — the dynamic-scope compilation
   strategy: how a bare identifier in a `with` block does a runtime
   property-presence check on the `with` object before falling back to the outer
   lexical binding (the ECMAScript `with` scope-chain semantics, §14.11 +
   §9.1.1.2 Object Environment Records / HasBinding with `[[Unscopables]]`).
   Likely an externref/`__extern_has`/`__extern_get` runtime-resolution path
   gated behind the dynamic object representation — coordinate with the
   value-rep substrate (#2580) and the any-typed read substrate.
2. **Implement** the dynamic fallback for non-statically-closed `with` targets.
3. **`@@unscopables`** handling (HasBinding consults `Symbol.unscopables`).
4. **De-skip** the test262 `with` category once the dynamic path lands; confirm
   the landing-page feature report flips.

## Notes

- `with` is forbidden in strict mode / ES modules / TS strict — the test262
  coverage is the non-strict sloppy-mode corpus. Confirm the runner exercises
  these (they are currently skip-listed).
- Reuses the Tier-1 static fast path: only fall through to the dynamic path when
  the target shape is not statically closed.
- Tier 2 depends on the dynamic any-typed object read substrate; sequence it
  behind / alongside the #2580 value-rep work rather than as a standalone hack.

---

## Implementation Plan

> Verified against current `main` (post-#2054 merge, HEAD `152a9a05f` + origin/main).
> All file:line references are to that tree. The #2580 dynamic-read substrate
> (`src/codegen/dyn-read.ts`) and the `__extern_get`/`__extern_has` runtime
> helpers (`src/runtime.ts`) were traced directly, not from issue text.

### Root cause

Tier 1 (`compileWithStatement`, `src/codegen/with-scope.ts:106`) only admits a
`with` target it can **prove** is a closed object literal
(`proveObjectLiteralWithTarget`, line 223). Any other target —
`with (someVariable)`, `with (fn())`, a spread/accessor/method literal, an
`@@unscopables`-bearing literal, or a literal whose body references inherited
`Object.prototype` keys — hits `reportWithStatementDiagnostic` (line 215) and the
statement is rejected at compile time. The 174 sloppy-mode `noStrict`
`WithStatement` tests (of 181 in `test262/test/language/statements/with/`; the
other 6 are `onlyStrict` *negative syntax* tests + 16 negative cases) all use
`with (variableOrExpression)`, so they all fall into the rejected path. Tier 1
also has no runtime HasBinding: it routes a name to a struct field purely by
static shape, so there is no place to consult `@@unscopables` or to *fall back*
to the outer lexical binding when the property is absent at runtime.

Tier 2 adds the **dynamic scope-chain semantics**: at each bare-identifier read /
write inside a non-closed `with`, emit a runtime `HasBinding(N)` test on the
`with` object (own+proto+`@@unscopables` filter, ECMA-262 §9.1.1.2.1) and branch:
present ⇒ `Get`/`Set` the property; absent ⇒ the name's prior (outer) lowering.

### The substrate to consume (do NOT build a parallel hack)

**`src/codegen/dyn-read.ts` is the #2580 value-rep dynamic-read substrate.** Tier 2
consumes it directly:

- `emitDynGet(ctx, fctx, keyName)` (`dyn-read.ts:195`) — receiver externref on
  the stack ⇒ pushes the key + a property `Get`, leaving the value externref (or
  `undefined`). HOST mode inlines `__extern_get` (a stable JS host *import*);
  STANDALONE routes through the defined `__dyn_get` wrapper
  (`dyn-read.ts:124`), which delegates to the native `__extern_get` object
  runtime (prototype-chain walk). This is the `Get` half of HasBinding+Get.
- `__dyn_has(recv, key) -> i32` (`dyn-read.ts:163`) and the host
  `__extern_has(obj, key) -> i32` runtime helper (`src/runtime.ts:7480`) — the
  `HasProperty` half (own + proto chain; `__extern_has` already includes
  `_OBJECT_PROTO_KEYS` inherited members per §7.3.12).

**Critical substrate gap Tier 2 must close (HasBinding ≠ non-null Get):**
`__dyn_has` (dyn-read.ts:163) is the M0/M1 *approximation* `present ⇔ __extern_get
!== null` — it conflates "present with value `undefined`" vs "absent" (see its own
NOTE at dyn-read.ts:159-162). For `with`, this is **wrong**: a property present
with value `undefined` must still **shadow** the outer binding (HasBinding is
value-independent, §7.3.12). The host `__extern_has` (runtime.ts:7480) is the
*correct* value-independent HasProperty (it does `key in obj`, sidecar-aware), so
the read/write site must gate on **`__extern_has`**, not on `__dyn_has`'s non-null
proxy. Slice 1 below wires `__extern_has` as the gate; `__dyn_get`/`emitDynGet`
remains the value fetch.

There is no separate "any-string value-read substrate" call needed here — the
`with` receiver is a whole object/externref, and `emitDynGet`'s STANDALONE arm
already routes through the native-string-aware `__extern_get`. Tier 2 adds **no
new host import** beyond `__extern_has` (already registered) and the
`@@unscopables` symbol-keyed read (below, reuses the existing well-known-symbol
plumbing).

### Strategy: dynamic `with` scope entry + per-name runtime resolution

**1. Widen the `withScopes` stack entry to carry a dynamic kind.**

`src/codegen/context/types.ts:405` — the `withScopes` entry today is
`{ localIdx, structTypeIdx, fields, blockedNames }` (static-only). Add a
discriminated `kind`:

```ts
withScopes?: ({
  kind: "static";                      // existing Tier-1 entry (unchanged shape)
  localIdx: number; structTypeIdx: number; fields: FieldDef[]; blockedNames: Set<string>;
} | {
  kind: "dynamic";                     // Tier-2: target is an arbitrary externref
  localIdx: number;                    // local holding the with-object as externref
  blockedNames: Set<string>;           // body-declared names (var/fn/catch) — never routed
})[];
```

Default existing construction sites to `kind: "static"` (the one push at
`with-scope.ts:160`).

**2. New entry path in `compileWithStatement` (`with-scope.ts:106`).**

Keep Tier 1 as the fast path. Restructure:

```
const proof = proveObjectLiteralWithTarget(fctx, stmt.expression);
if (proof.ok && !containsNestedFunctionBoundary(stmt.statement)) {
  ... existing Tier-1 closed-shape lowering (unchanged) ...
  return;
}
// Tier 2 fallback:
compileDynamicWithStatement(ctx, fctx, stmt);
```

`compileDynamicWithStatement` (new function, same file):
- Compile `stmt.expression` to a value; coerce to `externref` via `coerceType`
  (the receiver may be a struct ref, a boxed any, a host object — externref is
  the uniform receiver the substrate expects). ECMA-262 §14.11.7 step 1-3:
  evaluate, `GetValue`, `ToObject` — `ToObject(undefined|null)` throws TypeError.
  Emit a null/undefined guard: `__extern_is_undefined(recv) || ref.is_null(recv)`
  ⇒ throw TypeError (reuse `emitThrowString` / the no-JS-host TypeError path used
  elsewhere; `__extern_is_undefined` is already a known late import, used at
  dyn-read.ts:254). `ToObject` of a primitive (number/string/boolean) is a
  wrapper object — for the corpus this is rare; box via the existing any-box path
  or, minimally, treat primitives as having no own enumerable bindings (Slice 4).
- `local.set` into a fresh externref local (`allocLocal`, like with-scope.ts:129).
- `blockedNames = collectBodyDeclaredNames(stmt.statement)` (reuse line 321) —
  names lexically declared in the body are NOT object-environment bindings.
- Push `{ kind: "dynamic", localIdx, blockedNames }` onto `fctx.withScopes`,
  `compileStatement(ctx, fctx, stmt.statement)`, pop in `finally` (mirror
  lines 161-166).
- **Nested-function boundary:** Tier 1 rejects bodies containing a nested
  function/class (`containsNestedFunctionBoundary`, line 112) because the closure
  cannot statically capture the with-binding. For Tier 2, a nested function that
  references a with-routed name needs the object environment captured at runtime
  — out of scope for the first landing. **Keep the boundary rejection for the
  dynamic path too** (route to `reportWithStatementDiagnostic` when the body has a
  function/class boundary). This still de-skips the large majority of the corpus
  (the boundary cases are a minority; the canary `12.10-0-1.js` captures `foo`
  via an *outer* `var f` that reads `foo` from the function scope, NOT from
  inside the with — that body has no nested boundary, so it passes).

**3. Per-name READ resolution — `findWithBinding` + `emitWithBindingGet`.**

`findWithBinding` (`with-scope.ts:51`) currently returns a *static* binding or
`null`. Extend it to also report a **dynamic** scope hit:

```ts
type WithResolution =
  | { kind: "static"; binding: WithBinding }
  | { kind: "dynamic"; scope: DynamicWithScope }   // innermost dynamic scope not shadowing `name`
  | null;
```

Walk innermost-first (as today). For a `static` scope, the existing field-match
logic applies. For a `dynamic` scope: if `name` is in `blockedNames`, skip
(shadowed by a body-local decl); otherwise return `{ kind: "dynamic", scope }`.
Do **not** stop the walk for `OBJECT_PROTO_KEYS` in the dynamic case (the runtime
HasBinding handles proto members).

At the call site (`src/codegen/expressions/identifiers.ts:486`):

```ts
const res = resolveWithBinding(fctx, name);
if (res?.kind === "static") return emitWithBindingGet(fctx, res.binding);
if (res?.kind === "dynamic") return emitDynamicWithGet(ctx, fctx, res.scope, name, /*fallback*/ () => <normal id lowering>);
```

`emitDynamicWithGet` emits the **HasBinding-gated select**, ECMA-262
§9.1.1.2.5 (GetBindingValue) + §9.1.1.2.1 (HasBinding):

```wasm
;; recv = with-object externref (local.get scope.localIdx)
;; if (HasBinding(recv, "name")) result = Get(recv, "name") else result = <outer lowering>
local.get $with_recv
<emit @@unscopables-aware HasBinding for "name">   ;; -> i32  (see step 5)
if (result externref)
  local.get $with_recv
  emitDynGet(ctx, fctx, "name")        ;; Get -> externref value
else
  <fallback: the name's prior lowering>  ;; local.get / global / func / ReferenceError
end
```

Because the two arms must have the SAME Wasm result type and the fallback may be
an i32/f64/struct-ref local while `Get` yields externref, **normalize both arms
to `externref`**: in the `then` arm `emitDynGet` already yields externref; in the
`else` arm, compile the fallback and `coerceType(resultType, externref)`. The
`compileIdentifier` return type for a dynamic-with read is therefore
`{ kind: "externref" }`. (This matches how `any`-typed reads already surface as
externref — consumers box/unbox as needed via the existing coercion path.)

**Late-import / funcidx hazard (read the #2580 note at dyn-read.ts:212-239).**
`emitDynGet` (host) inlines the *import* `__extern_get` (shift-safe). The
`__extern_has` gate is likewise a host import — register it via `ensureLateImport`
+ `flushLateImportShifts` BEFORE baking its `call`, exactly as `dyn-read.ts:240`
does for `__extern_get`. Do NOT bake `call __dyn_has` (a *defined* function whose
index floats). Build the whole `if/else` with `pushBody`/`popBody` (the branch
arms are separate `Instr[]` — never alias one array into both arms; see
`reference_shared_instr_object_dce_double_remap`).

**4. Per-name WRITE resolution — assignment + compound + inc/dec.**

`src/codegen/expressions/assignment.ts:155` already calls `findWithBinding`. Route
a dynamic hit to a new `compileDynamicWithAssignment`:

```wasm
;; if HasBinding(recv,"name")  Set(recv,"name", rhs)   else  <outer assign>
local.get $with_recv
<HasBinding "name">
if
  local.get $with_recv ; push key ; push rhs(externref) ; call __extern_set(_strict)
else
  <fallback assignment lowering for "name">
end
```

- Use `__extern_set` (sloppy) — `with` is sloppy-only, so the silent-on-failure
  semantics are correct; `__extern_set_strict` (runtime.ts:7289) is NOT needed
  here. (`src/runtime.ts:7273`.)
- The assignment expression's value is the RHS — evaluate RHS once into a temp,
  use it in both arms, leave it on the stack as the result.
- **Compound assignment (`x += 1`) and inc/dec (`x++`)** also route through the
  with object: these read-modify-write. `src/codegen/expressions/unary-updates.ts`
  (touched by #2656 in this merge) and the compound path in `assignment.ts` must
  consult `resolveWithBinding` for the LHS identifier and, on a dynamic hit, emit
  HasBinding-gated read-then-write. **Slice this separately** (Slice 3) — plain
  read + plain assignment (Slices 1-2) already de-skip a large fraction; `unscopables-inc-dec.js` and compound cases need Slice 3.

**5. `@@unscopables` filter — the HasBinding predicate (§9.1.1.2.1).**

HasBinding(N) for an object environment record with `withEnvironment=true`:
1. `found = HasProperty(bindings, N)` — the `__extern_has` gate above.
2. If `found` is false ⇒ return false.
3. `unscopables = Get(bindings, @@unscopables)`.
4. If `Type(unscopables)` is Object: `blocked = ToBoolean(Get(unscopables, N))`;
   if `blocked` ⇒ return false.
5. return true.

Implement `emitWithHasBinding(ctx, fctx, recvLocal, name) -> i32`:

```wasm
local.get $recv
ensureLateImport __extern_has ; push "name" ; call __extern_has   ;; (1)
if (result i32)
  ;; (3) us = Get(recv, @@unscopables)   — symbol-keyed read
  local.get $recv
  <emit Get(recv, @@unscopables)>            ;; externref; see below
  local.tee $us
  ;; (4) if Type(us) is Object: blocked = ToBoolean(Get(us, "name"))
  <is-object(us)?>          ;; non-null && typeof object (host: __extern_is_object or ref.test)
  if (result i32)
    local.get $us
    emitDynGet "name"       ;; Get(us, "name") -> externref
    <ToBoolean(externref)>  ;; host: __extern_truthy / __to_boolean; standalone: existing truthiness helper
    i32.eqz                 ;; blocked ⇒ NOT a binding ⇒ has=0
  else
    i32.const 1             ;; us not an object ⇒ binding present
  end
else
  i32.const 0              ;; not even own/proto present
end
```

- **`@@unscopables` symbol-keyed Get:** reuse the existing well-known-symbol
  plumbing — `Symbol.unscopables` maps to wasm key `"@@unscopables"` / symbol ID
  `11` (`src/runtime.ts:3600`, `:3751`; `src/codegen/literals.ts:1319`;
  `src/codegen/property-access.ts:182`). `__extern_get(recv, <Symbol.unscopables>)`
  resolves it on the host; for the symbol key, route through the existing
  symbol-id `__extern_get_idx`/well-known-symbol path (`runtime.ts:7355`) — i.e.
  `Get(recv, @@unscopables)` is `__extern_get_idx(recv, 11)` (or the named
  `"@@unscopables"` string the runtime already aliases). Confirm against
  `binding-blocked-by-unscopables.js` (true-coercing values block) and
  `unscopables-*` tests.
- **`ToBoolean(externref)`** and **is-object** already exist as truthiness/typeof
  helpers in the codebase (used by `if`/`&&` lowering and `typeof`); reuse them —
  do not hand-roll. Grep `__extern_truthy` / the existing `coerceToBool` /
  `typeof`-object path.
- **Cost guard:** `Get(@@unscopables)` is only evaluated when HasProperty is true
  (rare per-name), so the common "absent ⇒ fall to lexical" path is one
  `__extern_has` call. No per-name unscopables read on the miss path.

### The test262 runner is NOT a blocker (Slice 0 premise REFUTED — audited 2026-06-25, dev-2046)

**CORRECTION.** This section originally claimed the runner's
`export function test()` strict-module wrapper is the hard gate (TS1101 rejects
`with`), making "runner de-strict" (Slice 0) the prerequisite. **That premise is
wrong.** The runner ALREADY passes `skipSemanticDiagnostics: true` on EVERY path
(`scripts/compiler-fork-worker.mjs:40,67`, `tests/test262-shared.ts:608`, the
in-process runner), and `skipSemanticDiagnostics: true` **already suppresses
TS1101** for `with` (verified: `export function test(){ …; with(o){…} }` +
skipSemanticDiagnostics reaches codegen — no TS1101).

**Audit (37 noStrict `with` tests through the actual `wrapTest` + the runner's
exact compile opts, current main):** TS1101-blocked = **0**; codegen-#1387 = 30;
already-compiling = 7. **Zero** `with` tests are blocked by the strict wrapper.
The real gate is the **codegen #1387 rejection** (the dynamic-`with` path this
issue implements), NOT the runner.

**⇒ Slice 0 (runner de-strict) is MOOT and was dropped** — implementing it would
move 0 tests (they'd still hit codegen #1387). The codegen frontend
(`ts.createSourceFile`) already yields a `WithStatement` node and
`skipSemanticDiagnostics` lets it through; **Tier-2 codegen (Slices 1-4) is what
actually makes the tests run/pass.** No runner change is needed for the `with`
corpus.

### Interaction with Tier 1 (keep the fast path)

- `compileWithStatement` tries `proveObjectLiteralWithTarget` first; only a
  **failed** proof (or a body-boundary rejection that the dynamic path also
  can't handle) falls to `compileDynamicWithStatement`. A proven closed literal
  with a boundary-free body still takes the zero-overhead static struct path.
- `findWithBinding`/`resolveWithBinding` walks innermost-first across a **mixed**
  stack (a static `with` nested inside a dynamic one, or vice versa) — each scope
  resolves by its own `kind`. A static field hit short-circuits (no runtime
  HasBinding); a dynamic scope emits the gated select.
- `typeof` on a with-routed name (`src/codegen/typeof-delete.ts:895`, `:1041`):
  the static arm returns the field's static `typeof` string. For a dynamic hit,
  `typeof name` must be HasBinding-gated too: present ⇒ `typeof Get(recv,"name")`
  (runtime `__extern_typeof`), absent ⇒ the prior `typeof` lowering (which for an
  undeclared name yields `"undefined"` without throwing — §13.5.1.1). Slice 3.

### Nested `with`, var hoisting, and the canary

- **Nested `with`:** handled by the innermost-first stack walk; each level emits
  its own HasBinding gate, so a name absent on the inner object falls to the
  next-outer with (then to lexical). No special casing.
- **`var` inside `with` hoists to the function scope** (canary `12.10-0-1.js`):
  `var foo` declared inside `with(o)` creates a *function-scope* var, and the
  assignment `foo = "..."` inside the with writes through the object env IF `o`
  has `foo`, else the var. `collectBodyDeclaredNames` already collects `var`
  names into `blockedNames` — but per §, a `var`-declared name is still resolved
  against the object environment at *runtime* (the var binding exists in the
  function env, the object env is consulted first). For the canary, `o` is empty
  so `foo` resolves to the hoisted var. **Decision:** do NOT blanket-block `var`
  names — `blockedNames` should hold only *lexical* (`let`/`const`/class/catch)
  and inner-function names (true shadows). `var`/function-scope names must still
  pass through the HasBinding gate (present-on-object ⇒ object wins). Adjust
  `collectBodyDeclaredNames` usage accordingly for the dynamic path (it currently
  lumps `var` in). Verify with `12.10-0-1.js` (empty `o` ⇒ falls to var ⇒ `f()`
  returns the hoisted value) and a sibling test where `o` *has* the name.

### Slice breakdown (land incrementally)

- **Slice 0 — runner de-strict: ~~CAN LAND FIRST~~ DROPPED (moot).** The premise
  (TS1101 strict wrapper blocks `with`) is refuted — `skipSemanticDiagnostics`
  already de-stricts the TS frontend (0/37 `with` tests TS1101-blocked; audit
  above). No runner change needed; the codegen path (Slices 1-4) is the gate.
- **Slice 1 — dynamic READ: ✅ DONE (PR, 2026-06-25).** Widened `withScopes`
  (`context/types.ts`, discriminated `kind:"static"|"dynamic"`),
  `compileDynamicWithStatement`, `resolveWithBinding`, `emitDynamicWithGet`
  (HasBinding via value-independent `__extern_has` + `Get` via `emitDynGet`),
  null/undefined-receiver TypeError guard (`__extern_is_undefined`),
  innermost-first cascade through nested/mixed `with` scopes, lexical-shadow via
  `blockedNames`. No `@@unscopables` yet (HasProperty treated as HasBinding).
  **Measured row-delta (174 noStrict `with` tests, in-process runner): pass
  3→16 (+13), compile_error 162→51 (−111 now reach codegen/run). Zero
  regression to non-`with` modules; Tier-1 static path byte-unchanged.** The
  +91 runtime_error are WRITE-dependent tests (Slice 2) now reaching execution
  (previously compile_error) — progress toward measurability, not a regression.
- **Slice 2 — dynamic WRITE: ✅ DONE (PR #2061; re-fixed for #2061 merge_group
  regression 2026-06-25).** `emitDynamicWithSet` (statement-form HasBinding-gated
  write: present ⇒ `__extern_set(recv,name,rhs)`, absent ⇒ next-outer write) + the
  recursive `emitDynamicWithIdentifierWrite` (cascade through nested
  dynamic/static with scopes, then to the lexical write) and
  `emitIdentifierWriteFromLocal` (local / captured-global / module-global /
  undeclared, from a pre-computed externref temp). Plain `=` only. RHS evaluated
  ONCE into an externref temp; result = RHS value. `with` is sloppy-only ⇒
  `__extern_set` (silent-on-failure), not the strict variant.
  **#2061 merge_group regression FIX — §13.15.2 evaluation ORDER:** the first
  Slice-2 cut captured `HasBinding(scope,name)` AFTER evaluating the RHS, so an
  RHS that mutates the with-object (`with(scope){ x = (scope.x = 2, 1) }`) flipped
  the binding decision and mis-routed the write — regressed test262
  `S11.13.1_A6_T3` ("PutValue uses the initially-created Reference even if a more
  local binding is available"). FIX: the LHS Reference is resolved BEFORE the RHS
  — `captureDynamicWithHasBindings` captures each cascade scope's HasBinding into
  i32 temps *before* compiling the RHS; the gated write branches on the captured
  i32 (`emitCaptureWithHasBinding` + `emitDynamicWithSet(…, hasLocalIdx, …)`).
  Paired per-test diagnosis (main-vs-Slice2-merged, found via the masked net +4):
  pre-fix +4 with-gains masked −1 assignment regression; post-fix **0
  regressions, +4 with + 3 assignment gains** (the correct ordering also fixes 3
  more assignment-category tests). Regression-guarded in `tests/issue-2663.test.ts`.
  **Measured row-delta (174 noStrict `with` tests): pass 16→20 (+4; +17 over the
  original baseline of 3), runtime_error 92→89.** The remaining ~89
  runtime_errors are the var-hoisting/closure-capture canary class (12.10-0-1/7/8
  — `var foo` inside `with` visible via an outer closure; needs the var/object
  precedence refinement noted above) plus `typeof`/`delete`/`@@unscopables`
  (Slices 3-4). Zero regression to non-`with` modules.
- **Slice 3 — `delete name` + var/object precedence: ✅ DONE (PR, 2026-06-25).**
  Data-driven scope: a feature classification of the 89 remaining
  runtime_errors found **delete = 45** (the biggest bucket), closure-capture =
  35, and typeof/compound/inc-dec ≈ 0 in this corpus — so Slice 3 targets
  `delete` (and folds in the var-precedence refinement); typeof/compound/inc-dec
  are deferred as near-nil-yield here.
  - `emitDynamicWithDelete` (`with-scope.ts`): HasBinding-gated
    `__delete_property(recv,name)` else cascade to the outer delete / bare-var
    `false`; wired at the `delete identifier` site (`typeof-delete.ts`).
  - **var/object precedence:** `blockedNames` for a dynamic scope is now
    LEXICAL-only (`collectBodyLexicalNames` — `let`/`const`/class/catch +
    inner-fn), EXCLUDING `var`. §: a `var` inside `with` hoists to the function
    env but the Object Environment Record is consulted FIRST, so a `var foo` name
    must still pass the HasBinding gate (object wins if owned). So
    `var foo; with({foo}){ foo=… }` now writes the OBJECT; `let` still shadows.
  - **Row-delta: pass 20→23 (+3), runtime_error 89→86.** The delete RETURN value
    is now spec-correct; the bulk of the 45 delete tests ALSO check `in`/re-read
    after delete, which hits a **delete-on-struct-slot observability gap** (the
    with object is a typed WasmGC struct; `__delete_property` clears the host
    sidecar but `in`/re-read reads the struct slot — the #2659-family struct-slot
    vs sidecar asymmetry, for delete). Closing that needs a struct-slot-aware
    delete on an externref receiver — deferred (see below).
- **DEFERRED — closure-capture class (~35 tests) + delete-on-struct
  observability:** the var-decl-initializer-in-`with` + **outer-closure capture**
  of a function-scope var (canary `12.10-0-1/7/8`) is the remaining big bucket;
  it touches the closure-capture machinery and is substantially harder — its own
  sub-slice / possibly senior-dev. The delete struct-slot observability is the
  #2659-family asymmetry for delete. Both are flagged to the lead, NOT bundled.
- **Slice 4 — `@@unscopables` HasBinding: ✅ DONE (host-mode, PR 2026-06-25).**
  Implemented as a single HOST helper `__with_has_binding(obj, key) -> i32`
  (`src/runtime.ts`, in `resolveImport` `case "builtin"`) applying the full
  §9.1.1.2.1 predicate: value-independent HasProperty (reuses `__extern_has`)
  THEN the @@unscopables filter — `unsc = __extern_get(obj, Symbol.unscopables)`
  (sidecar-aware, so a WasmGC-struct receiver resolves identically to a host
  object); if `Type(unsc)` is Object and `ToBoolean(__extern_get(unsc, key))` is
  true, the name is unscopable ⇒ NOT a binding. The three with-gates (READ /
  WRITE-capture / DELETE resolution in `with-scope.ts`) route through
  `withHasBindingImport(ctx)` — `__with_has_binding` in host mode,
  `__extern_has` under `--target standalone` (where the dynamic-`with` path is
  already refused by the #1472 gate, so the new host import is NEVER emitted in a
  no-JS-host build — byte-identical standalone, no allowlist growth). Guarded by
  `tests/issue-2663-unscopables.test.ts` (11 cases: blocking true/truthy, not
  blocking false/empty/non-object, sibling-name unaffected, getter-not-invoked
  for absent props, blocked read+write fall to outer, nested cascade, Slice-1
  no-regression).
  - **Measured:** the non-mutating blocking/not-blocking cases are now
    spec-correct in host mode; ZERO regression to non-`with` modules.
  - **NOT yet flipped — corpus needs the #2580 object-representation ceiling:**
    `binding-blocked-by-unscopables.js` mutates `env[Symbol.unscopables].x` across
    heterogeneous types (`true → 'string' → 86 → {} → Symbol`); the
    `{ x: true }` literal lowers to a typed struct whose numeric `x` field cannot
    hold those later values (writing `'string'`/`{}`/`Symbol` coerces to 0 → the
    assertion-2+ rows still fail). `unscopables-inc-dec.js` needs a literal
    `get [Symbol.unscopables]()` accessor. Both are the dynamic any-typed object
    representation (#2580), NOT the HasBinding logic — which is landed and
    isolated here so the representation work immediately flips the corpus. The
    `binding-not-blocked-*` / `unscopables-not-referenced-for-undef` tests already
    pass on `main` (HasProperty gives the same answer when unblocked), so the
    measurable test262 delta of this slice alone is small; its value is banking
    the correct, prerequisite HasBinding semantics. **DEFERRED to senior-dev /
    #2580 alongside the closure-capture class.**
- **Slice 5 — landing-page flip + de-skip confirmation:** confirm no remaining
  blanket skip for the `with` category in `shouldSkip`
  (`tests/test262-runner.ts:324`; today there is no `with`-specific skip — the
  blocker is the strict wrapper, fixed in Slice 0). Re-run the `with` category,
  refresh the baseline, confirm `website/public/benchmarks/feature-report.html`
  flips `with` to supported.

Each slice is byte-identical for non-`with` modules (the dynamic path is only
reached from `compileDynamicWithStatement`, and `resolveWithBinding` early-returns
when `fctx.withScopes` is empty/static — same gating discipline as Tier 1).

### Wasm IR pattern (dynamic with read, host mode)

```wasm
;; x  inside  with (o) { ... }   — o is an arbitrary externref in $with_o
local.get $with_o
;; --- HasBinding "x" (no-unscopables form, Slice 1) ---
(string.const "x")                 ;; key externref
call $__extern_has                 ;; -> i32  (own+proto, value-independent)
(if (result externref)
  (then
    local.get $with_o
    (string.const "x")
    call $__extern_get)            ;; Get -> value externref  (via emitDynGet)
  (else
    ;; fallback: x's prior lowering, coerced to externref
    <outer x>  (coerce externref)))
```

### Test files to verify

- `test262/test/language/statements/with/12.10-0-1.js` — `var` in `with` visible
  outside; empty object ⇒ falls to hoisted var (the canary).
- `test262/test/language/statements/with/binding-blocked-by-unscopables.js` —
  true-coercing `@@unscopables[N]` blocks the object binding (Slice 4).
- `test262/test/language/statements/with/unscopables-inc-dec.js` — compound on a
  blocked name (Slice 3 + 4).
- `test262/test/language/statements/with/get-binding-value-call-with-proxy-env.js`
  / `set-mutable-binding-idref-with-proxy-env.js` — Proxy-backed env (proxy is
  deferred per project policy; expect skip/fail, not a target).
- The 174 `noStrict` files under `.../with/` collectively — the acceptance signal
  is the category count flip after Slice 0 unblocks compilation.

### Acceptance signal

1. Slice 0 merged ⇒ `with` category in the test262 report stops being
   all-`compile_error` (tests now run).
2. Slices 1-4 merged ⇒ `with` category pass count rises toward the 174
   sloppy-mode tests (Proxy/nested-function-capture cases excepted).
3. Baseline refreshed ⇒ `website/public/benchmarks/feature-report.html` flips
   `with` from **not supported** to supported.

### Dependencies

- **#2580** (value-rep dynamic-read substrate, `src/codegen/dyn-read.ts`) —
  Tier 2 consumes `emitDynGet`/`__dyn_get`/`__extern_get`/`__extern_has`. M1 (the
  `emitDynGet` call site) must be on `main` first; the host-mode `__extern_get`
  inline + `__extern_has` import are already present. Sequence Slice 1 after the
  #2580 M1 landing (already in-tree per `dyn-read.ts`). The HasBinding
  value-independence fix (use `__extern_has`, not `__dyn_has`'s non-null proxy) is
  Tier 2's own change, not a #2580 dependency.
- **#1387** (Tier 1) — extended, not replaced.

## Architectural ruling — `with` remains an IR feature (2026-07-29)

The current `src/codegen/with-scope.ts` implementation is transitional. The
selector's refusal of `WithStatement` means only that the IR cannot represent
its dynamic environment semantics yet; it is **not** a permanent legacy-only
boundary. Complete `with` support must ultimately be owned by the IR.

The IR design must represent an Object Environment Record rather than assigning
every identifier to a fixed local/global slot. At minimum it must preserve:

- single evaluation and `ToObject` conversion of the `with` target;
- runtime `HasBinding` lookup, including the prototype chain and
  `@@unscopables`, before falling back to the outer lexical environment;
- dynamic reads, writes, compound assignments, update expressions, and deletes
  with spec evaluation order and abrupt-completion propagation;
- nested `with` environments and interaction with captured outer bindings.

Closed-shape analysis may keep a static fast path, but the proof and the
resulting environment operations belong in the IR. Direct-codegen handling
should become only a compatibility adapter while module/function bodies migrate.

IR completion evidence must include:

- representative sloppy-mode `WithStatement` bodies present in
  `irCompiledFuncs`, with no post-claim demotions;
- equivalent host and standalone behavior for static and dynamic targets;
- a same-SHA local A/B measurement of the complete Test262 `with` family,
  including pass/fail and fail-signature transitions.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — sliced feature. Slices 1-2 (HasBinding-gated read + assignment) + Slice 4 (@@unscopables HasBinding, host-mode) landed. Slice 3 (HasBinding-gated read-then-write: compound-assign + inc/dec, e.g. unscopables-inc-dec.js) remains; the 294 WithStatement tests are only partially de-skipped. Stays in-progress.

## Re-measure 2026-08-04 — standalone lane, ES5 + untagged scope

Source: `plan/log/analysis-2026-08-04-es5-untagged-standalone-clusters.md`.
Baselines fetched 2026-08-04, `oracle_version` 12, lane `honest`, baseline SHA
`d3d7ec4c`.

**307 files** in the ES5 + untagged standalone scope — the third-largest
mechanism there, behind the descriptor family (#2668, 762) and Array traversal
(#3185, 738). 282 `ES5`-tagged, 25 untagged.

**A path filter on `language/statements/with` undercounts this badly.** Only 108
of the 307 live under that directory. The rest are the same dynamic-scope
mechanism reached from elsewhere:

```
 65  annexB/language/eval-code/{direct,indirect}
 54  annexB/language/global-code
 49  annexB/language/function-code
 45  language/expressions/compound-assignment/S11.13.2_A5.*   ← fails INSIDE a with block
```

The compound-assignment family is the one to notice: `scope.x === 1. Actual: NaN`
(22 files) is a `with`-scoped read-then-write, i.e. exactly the Slice 3
(HasBinding-gated read-then-write: compound-assign + inc/dec) residual this issue
already names. It is being counted under `language/expressions` by any
path-based census. The 2026-08-01 tail census reached the same conclusion from
the other direction (its refutation #4: `with` reaches 175 files by body but only
106 by path).

Top failure shapes:

```
85  Expected SameValue(…)                              annexB/language/function-code/if-decl-no-else-func-existing-fn-update.js
24  SyntaxError: NaN                                   annexB/language/eval-code/indirect/global-if-decl-else-stmt-…
24  binding value is updated following evaluation      annexB/language/eval-code/direct/func-if-decl-else-stmt-…
22  scope.x === 1. Actual: NaN                         language/expressions/compound-assignment/S11.13.2_A5.2_T2.js
15  Initialized binding created prior to evaluation    annexB/language/function-code/switch-dflt-func-no-skip-try.js
13  p1 === "x1". Actual: p1 === 1                      language/statements/with/S12.10_A1.1_T1.js
13  binding is initialized to `undefined`              annexB/language/global-code/if-decl-no-else-global-init.js
```

**289 of 307 (94 %) also fail on the JS-host lane** — only 18 are
standalone-only. This is a front-end scope-model gap, not a standalone-substrate
one, which is worth stating explicitly because the issue sits under
`goal: spec-completeness` and could otherwise be read as standalone work.

Related but distinct: **#4021** (annexB eval-code `assert is not defined`, 120
tests) is a harness-visibility problem inside eval'd code, not the scope-chain
mechanism — keep the two separate when slicing.

**Not verified by repro** — counts from the published baselines; no compiler was
built for this re-measure.
