---
id: 2873
title: "Standalone: language/expressions cluster (276 host-pass/standalone-fail, de-masked from #2862)"
status: ready
created: 2026-06-30
updated: 2026-07-02
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2870, 2862]
umbrella: 2860
---

# Standalone: language/expressions failures (de-masked)

## Problem

~**276** `test/language/expressions/**` tests are host-pass but standalone-fail,
de-masked by #2870 from the phantom ToPrimitive signature (#2862). Plus ~108
`language/statements/**` and ~57 `language/function-code/**` in the same surface.

## Triage needed

This is a broad bucket — expression-level coercions/operators that throw a Wasm
exception standalone. Likely sub-clusters: object→primitive in operators
(`+`/`==`/relational), `ToPropertyKey` in member access, default-value/`ToNumber`
coercions. Triage with `runTest262File(file, cat, undefined, "standalone")`,
cluster by the operator/feature directory under `language/expressions/`, and
split into focused sub-tasks.

## Test plan

Per sub-cluster: standalone fail → pass, verify-first, full `merge_group` +
standalone high-water. `ctx.standalone` only.

## Progress (2026-06-30)

Triaged the operator sub-dirs (`addition`/`equals`/relational/...). Findings:

- **Relational `<`/`<=`/`>`/`>=` with a `String` wrapper operand emitted invalid
  Wasm** standalone (`S11.8.x_A3.2_T1.x`) → split out as **#2888** and FIXED
  (native `ref $AnyString` lowering of both operands before `__str_compare`).
- The large residual `fail | "Cannot convert object to primitive value"` bucket
  (the `_A1`/`_A2.2` object-`valueOf` relational + `addition` object operands)
  is the **#2862 ToPrimitive** cluster (object→primitive in operators), NOT a
  relational-codegen bug — verified identical on unedited main. Track under
  #2862 / a dedicated ToPrimitive-in-operators sub-task.
- `subtraction/bigint-and-number.js` needs the `BigInt` extern class (separate).

Remaining #2873 work is dominated by the #2862 ToPrimitive-in-operators surface.

## Reground + landed slice (2026-07-02, dev-2873)

**The "276" figure is stale.** A full fresh triage of all 11,036
`language/expressions/**` files against current `main` (via
`runTest262File(..., "standalone")`) shows only **10** host-pass /
host-free-standalone-fail — the valueOf-`ToPrimitive`-in-operators cluster (the
bulk of the original 276) was fixed by merges landed since 2026-06-30
(object→primitive via an OWN `valueOf` now works host-free: `1 < o`, `1 + o`,
`2 == o` all correct standalone). All 10 residual hard-fails are in `addition/`.

**Landed slice — String-wrapper `+` compared via `===`/`!==` (net +5).**
Root cause: TypeScript infers `new String("1") + <non-string>` as `any` (only
`String-wrapper + primitive-string` narrows to `string`). The concat itself
compiles correctly (`compileStringBinaryOp` → native `ref $AnyString` → "11"),
but the OUTER `=== "11"` saw an `any` LEFT, missed the native string-equality
dispatch, and fell to `ref.eq`/tag-dispatch → spurious `false`. Fix in
`src/codegen/binary-ops.ts` (standalone/WASI-only): `isStringConcatExpr` treats a
`+` with a string-/String-wrapper-typed operand as a string-producing expression
at the AST level, wired into `leftIsStrLike`/`rightIsStrLike` so the `===`/`!==`
classification routes to `__str_equals` (content compare). Mirrors the #2192
caught-`Error.message` and #2888 relational augmentations. Tests:
`tests/issue-2873.test.ts`. Verified host-free (`imports == []`), host (gc) mode
byte-unaffected (gated), and the full 11,036-file expr triage drops 10→5 with
**zero new fails**. Flips standalone:
`language/expressions/addition/S11.6.1_A3.2_T{1.1,2.1,2.2,2.3,2.4}`.

**Remaining residual (5 files, all tracked by sibling issues — nothing tractable
left in this cluster for a dev slice):**

- `S11.6.1_A2.1_T1` — `new Object().prop` numeric read backs 0 → **#2849**.
- `S11.6.1_A2.2_T1` — object literal with INHERITED `valueOf`/`toString` (default
  hint falls valueOf→toString) → **#2862** (ToPrimitive, `wont-fix`/hard).
- `coerce-symbol-to-prim-return-obj`, `get-symbol-to-prim-err` — `@@toPrimitive`
  dispatch (throw-if-result-Object; getter throws) → **#2862**.
- `subtraction/bigint-and-number` — `BigInt` extern class → separate carrier.
