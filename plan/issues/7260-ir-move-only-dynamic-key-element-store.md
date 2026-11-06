---
id: 7260
title: "IR move-only scan: statement-position element store on a dynamic local receiver (#7250 rule a)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7250
depends_on: [7258]
related: [2949, 3795, 3797, 7106, 7261, 7270]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-06 (#7258, restated so the grant does not strand once #7104 lands):
  # one `concreteResultRecoversDynamic` helper plus a `coerceReturnValue` arm.
  - src/ir/select.ts
  - src/ir/from-ast.ts
  # 2026-11-06 (#7260): one selection option and one lowering option, which
  # carry the function-code strictness fact. Both have to sit next to their
  # siblings in the two option lists; they cannot move to another module.
  - src/ir/integration.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-11-06 (#7260): +1 line in each option-list literal (same reason).
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/index.ts::planIrOverlay
  # 2026-11-06: the #7261 guard, measured against origin/main:
  # dynamicUsesAreMoveOnly +6 (the flag, and a final check that names its
  # refusal) and scanExprInner +3 (the store arm sets the flag). The
  # member-call search is the module helper `bodyCallsThroughMemberAccess`.
  # Removed with #7261.
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
---

# IR move-only scan: statement-position element store on a dynamic local receiver

## Problem

Rule (a) of [#7250](7250-ir-property-helper-dynamic-carrier-locals.md):
propertyHelper.js's `isWritable` stores `obj[name] = newValue` (inside `try`)
and `obj[name] = oldValue`, where `obj` and `name` are dynamic parameters and
`newValue`/`oldValue` are dynamic locals. The move-only scan admitted a
dynamic store only for two narrow families:

- #3797 needs ambient `this` and a stable-call root;
- #3795 needs a dynamic receiver and key, with the RHS a widened string local
  or `"true"`.

## Measurements (step 1, before code; base = #7258 head `ed947526`)

Probe (standalone, `JS2WASM_IR_SHAPE_DIAG=1`). Every dynamic-receiver store
was refused with `move-only[concrete]` on the LHS:

| shape | base |
| --- | --- |
| `obj[name] = v` (dyn key, dyn value) | refused |
| `obj[name] = 1` / `= "x"` (concrete value) | refused |
| `obj["k"] = v`, `obj[0] = v` (literal key) | refused |
| `try { obj[name] = v } catch (e) {}` | refused |
| `obj.k = v` (dot store) | refused |
| `return obj[name] = v` / `obj[name] += v` | refused (`expr-binary-op-*`, shape rule) |

Lowering contract:
- The canonical provider already exists: `dyn.member_set`, whose `sloppy`
  flag matches legacy's `__extern_set` (sloppy) vs `__extern_set_strict`.
  Legacy picks one from `isStrictContext` (`compileElementAssignment`).
- The only missing input was the function code's strictness. The lowering
  knew it only for self-guarded constructors (`ambientThisStrict`).

So (a) is an admission under the existing contract, plus one fact plumbed
through. Neither a new instruction nor a new import is needed.

## Implementation Plan

- `src/codegen/ir-dynamic-construct.ts`: `irFunctionCodeStrictness(ctx, fn)`
  (`isStrictFunction`). `irFunctionThisStrictness` now reuses it.
- `src/ir/integration.ts`:
  - the lowering gets `functionCodeStrict` for every top-level function;
  - both selection-option lists (with `src/codegen/index.ts`) set
    `lowersFunctionCodeStrictness: true`.
- `src/ir/from-ast.ts`:
  - `cx.functionCodeStrict` comes from the new `functionCodeStrict` option,
    not from `ambientThisStrict` (the same value where both are set);
  - one `lowerDynamicStoreOperand` boxes a concrete key or value onto the
    carrier (`boxConcreteToDynamic`). It replaces the element store's
    `"true"`-only arm and the property-write arm's copy of the same boxing;
  - the element store passes `sloppy = functionCodeStrict === false`.
- `src/ir/select.ts`: the #3797 statement-store arm also admits
  `dynamicLocalElementStoreIsLowerable`: an element store whose receiver is
  an identifier, in a top-level function declaration, when the lowering is
  told its strictness. The arm's existing key check (literal or dynamic
  name) and value check (dynamic or boxable) apply unchanged.
- (#7261 guard, after the #7104 reviews) The new local-receiver store sets
  the scan's `needsNoDynamicMethodCall` flag, as #7258's bool return does. A
  body that also calls through a member access
  (`bodyCallsThroughMemberAccess`: one syntactic outer-body traversal) stays
  refused, with detail
  `move-only[dynamic-method-call]`, because such a call traps in an IR body
  ([#7261](7261-ir-dynamic-method-call-on-returned-object-traps.md)).
- Out of scope, still refused: dot stores on a dynamic local, assignment as a
  value, compound stores, optional stores.

Code-quality acceptance: one shared boxing helper (two copies removed); the
strictness fact has one source (`irFunctionCodeStrictness`); the store reuses
the existing arm, with no sibling arm added.

## Acceptance criteria

- `tests/issue-7260-ir-move-only-dynamic-key-store.test.ts`: `put` is
  IR-emitted, and the sloppy (frozen store ignored) and strict (TypeError)
  fixtures pass through the test262 runner. Dot, value and compound stores
  stay refused.
- Typed corpus byte-identical on gc/standalone/wasi.
- Wrapped ledger: 0 invariants, compileOk not lower.
- Standalone test262 A/B on route-changed files plus 300 random: no
  pass→fail, no new trap.

## Results (2026-11-06; base = #7258 head `3f9e2593`, head `c9f24adc`/`d0ace9ef`)

- **isWritable:** with #7250 step 1 stubbed locally (`var unlikelyValue =
  "unlikelyValue"`, the `new Test262Error` throw simplified), the first
  refusal moves from (a) `obj[name]` (`move-only[concrete]`) to (b)
  `writeSucceeded = isSameValue(...)`. In the real harness, isWritable still
  stops first at #7250 step 1 (`vardecl-module-binding-alias` on the
  `__isArray` conditional), so no whole unit is freed yet.
- **Wrapped ledger** (stride 40, standalone, SHAPE_DIAG): head equals base
  apart from timing. compileOk 1118 → 1118, invariants 0, ir 1137 / both 8531
  / legacy 4780, and all `unsupportedDetails` rows are equal. The
  `move-only[dynamic-method-call]` row does not appear.
- **Per-file route diff:** stride-40 plus a 300-file seeded sample, kept where
  the assembled source has an element assignment. That leaves 457 files.
  0 route changes.
- **Standalone test262 A/B** (`run-test262-paths.mts --standalone`) over those
  457 files plus the 300-file sample (668 distinct): `{ pass: 417, fail: 207,
  compile_error: 27, skip: 17 }` on both sides, with the same non-pass set
  row for row.
- **Typed corpus:** 88 files × gc/standalone/wasi = 264 compiles,
  byte-identical.
- **Runtime probes** (test262-format fixtures, standalone): `put(obj, name,
  v)` is IR-emitted and passes in sloppy mode (a store to a frozen object is
  ignored, a setter runs once) and in strict mode (TypeError). The
  `store + o.f()` bodies stay refused.
- **Tests:** `tests/issue-7260-*.test.ts` passes, and so do the #3797 and
  #7106 S3c tests. #3795's two gc cases (`throws like direct codegen … on gc`,
  `Acorn's exact private-name conflict family on gc`) also fail on main.
- **Gates** (bare, also with `LOC_GATE_BASE=origin/main`): loc, func,
  coercion-sites, oracle-ratchet, dead-exports, ir-layering, lint, prettier,
  typecheck and compiler-boundaries inventory all pass.
- **New post-claim fallbacks:** `abi-signature-parity` on two probe helpers
  (`tryPut`, `putLiteral`). The IR resolves a parameter as externref where
  legacy resolves it as f64, so the legacy body is kept. This existing
  parameter-resolution divergence was unreachable for these bodies until
  now, and the stride ledger shows no new row of it.

## Review fix (2026-11-06, PR #7107 comment 6677683015)

**Blocker: in strict code the store threw for exotic receivers.** A newly
claimed `obj[k] = v` in strict function code lowers to the strict
`__dyn_member_set`. Its native body (`ensureDynMemberSet`,
`src/codegen/dyn-read.ts`) is `__reflect_set` followed by a throw on
`false`, and `__reflect_set` reports false for several receivers where
legacy's computed strict store succeeds:
- the reviewer saw arrays, typed arrays, DataView, ArrayBuffer, Map, Date
  and Error;
- in my matrix, head throws on an out-of-bounds typed-array store and on
  Map.

The defect predates this PR (it is the #3795 strict helper), but this PR is
the first to route arbitrary dynamic receivers into it. Filed as
[#7270](7270-ir-strict-dyn-member-set-exotic-receivers.md).

Effect on the harness lever: none in practice. propertyHelper.js has no
`"use strict"`, and only an `onlyStrict` test prepends one to the assembled
script. That is 5 of the 5246 propertyHelper includers (measured
2026-11-06).

The fix narrows the admission: `dynamicLocalElementStoreIsLowerable` now
requires `functionCodeStrictness(fn) === false`, i.e. sloppy function code.
The sloppy helper `__dyn_member_set_sloppy` ignores the failure. The
selector option is now the strictness itself (`functionCodeStrictness`,
the same `irFunctionCodeStrictness` the lowering is told), not a capability
flag.

Receiver matrix, `put(obj, name, v)` with widened parameters, standalone
and gc, base (#7258 head) vs head:
- rows: array `[0]`, `[10]`, `["1"]`, `length`; Uint8Array in-bounds,
  string-key and out-of-bounds; Float64Array; Map; Date; Error `message`;
  DataView; ArrayBuffer; plain object; frozen; function; RegExp.
- **Sloppy:** `put` is IR-emitted on head. Every row is identical to base,
  including base's own quirks (`map=null`, `u8oob=0`).
- **Strict:** `put` stays legacy, as on base. The rows, and the reviewer's
  repro (`put([1,2,3], 0, 9)`), are identical.

**Secondary 1/2 (claim-then-fallback, wasi bytes).**
`makeIrDynamicCarrierDivergenceProbe`
(`src/codegen/fnctor-typed-instances.ts`) now reports a divergence when
legacy resolved the parameter to a scalar slot (`f64`/`i32`, from numeric
call sites). The selector refuses such a parameter up front
(`param-dynamic-carrier-diverges-from-legacy`) instead of claiming and then
falling back on `abi-signature-parity`. With no abandoned IR attempt left,
no strict-helper literal is registered. The reviewer's
`put`/`pk`-with-numeric-`v` probe is now byte-identical to base on wasi,
standalone and gc.

**Secondary 4 (the existing #3795/#3797 element-store path in sloppy
code).** `lowerElementStore` used to always emit strict `dyn.member_set`;
it now follows `functionCodeStrict`. Probe: the #3795 conflict-marker shape
`function mark(o, k) { o[k] = "true"; }`, sloppy, IR-claimed on both sides:

| receiver | base (IR, strict helper) | head (IR, sloppy helper) | JS / legacy sloppy |
| --- | --- | --- | --- |
| plain object | `true` | `true` | `true` |
| frozen | TypeError | `1` | `1` |
| non-writable | TypeError | `1` | `1` |
| getter-only | TypeError | `2` | `2` |
| array `[0]` | `1` | `1` | `"true"` (a separate defect, the same on both sides) |

Head matches JS and legacy's sloppy `__extern_set` (gc and standalone).
In strict code (Acorn's module code) nothing changes.

Nit: the #3797 receiver test is bound once (`stableThisStore`) instead of
being re-evaluated for the guard flag.
