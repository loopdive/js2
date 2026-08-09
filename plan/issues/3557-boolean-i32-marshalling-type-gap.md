---
id: 3557
title: "booleans cross the host boundary as i32 0/1 — systemic wrong-TYPE marshalling (boolean brand lost in struct-field type inference)"
status: in-progress
assignee: sendev-bool-marshal
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
model: opus
created: 2026-07-23
updated: 2026-07-23
task_type: bugfix
area: runtime, codegen
language_feature: host-marshalling, value-rep
goal: acorn-dogfood
related: [2773, 1712, 2847, 1788]
umbrella: 1712
origin: "Split out of #2847 (2026-07-23, sendev-acorn) — mis-filed there as a cosmetic quirk. The tech lead's 2026-07-23 review flagged it as a real fidelity gap; this issue reframes it as the wrong-TYPE-crossing-the-boundary defect it is."
---

# #3557 — booleans marshal as the number 0/1: a real type-fidelity gap, not a cosmetic quirk

Split from #2847 (which now keeps only the genuinely-cosmetic `sourceFile`
quirk). Surfaced by the acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella), but the defect is
**systemic**, not acorn-specific.

## Problem — this is wrong TYPE, not wrong truthiness

Boolean-valued struct fields (`computed`, `optional`, `static`, `generator`,
`async`, `prefix`, `delegate`, `tail`, `method`, `shorthand`, …) marshal across
the host boundary as the **number** `0`/`1` instead of JS `false`/`true`:

```
primitive-mismatch  $...computed   expected false   actual 0
```

Why "cosmetic" was the wrong frame (the original #2847 rationale said "a
consumer that reads `node.computed` still gets a truthy/falsy value"):

- `node.computed === false` → **false** (it's `0`); strict-equality consumers
  break silently.
- `typeof node.computed` → `"number"`, not `"boolean"`.
- `JSON.stringify` emits `0`/`1`, so serialized output differs from every
  spec-conformant producer.
- Any downstream tool with a type check (validators, TS consumers of the AST,
  structural differs) sees a different VALUE TYPE, which is exactly the class
  of divergence the dogfood program exists to catch.

Measured 467 occurrences across the 2026-07-03 corpus run (fields: `async`
`await` `computed` `delegate` `generator` `optional`).

## Root cause (verified 2026-07-03, dev-team-a — carried over from #2847)

**This is a CODEGEN brand-preservation gap, NOT a marshalling gap.** The
`__box_boolean` path (#1788) already boxes a boolean-branded i32 struct field
(`{kind:"i32", boolean:true}`) as a JS boolean on host read — verified for
both TS-typed `boolean` fields and untyped-JS `this.computed = false`
constructor assignments. The runtime marshaller does the right thing when the
brand survives.

The brand is **lost during struct-field-type computation** when a field is
assigned via boolean-returning method calls in untyped JS
(`node.generator = this.eat(types.star)`) whose inferred return type is plain
number-i32, not boolean-branded. When a field's assignment mix includes
unbranded method-call results, the merged field type drops `boolean: true`,
and getter emission (`src/codegen/index.ts` `_emitStructFieldGettersInner`,
the `hasBool` fork) emits raw-i32/`__box_number` instead of `__box_boolean`.

- **Real fix location**: struct-field-type inference / brand-preservation in
  `src/codegen` (brand boolean-returning method returns, or preserve the brand
  through the field-type merge), NOT `src/runtime.ts`. A field-name allowlist
  in the generic marshaller would regress real user programs and violates the
  no-bespoke-builtins principle.
- **Blast radius**: branding changes flow into `typeof`/boxing across the
  whole test262 surface (exactly what #1788 had to guard) — must validate IN
  BATCH via the full merge_group, not locally. This is value-rep territory —
  hence `related: [2773]` (value-rep epic); coordinate with any in-flight
  brand/rep work before implementing.

## Fix-vs-accept is a REAL decision — record it, don't default it

This issue must end in one of two explicit outcomes, decided with the value-rep
epic (#2773) owner / tech lead — NOT silently parked as an allowance:

1. **Fix**: preserve the boolean brand through field-type merging (per the
   root cause above), validated in batch. This is the type-fidelity-correct
   outcome and the default recommendation.
2. **Accept**: a recorded decision that i32-boolean marshalling is a permitted
   representation divergence, with the differ's quirk bucket as the permanent
   normalization layer. This weakens every strict-equality/typeof consumer of
   compiled output and should require explicit sign-off.

## Acceptance

- Marshalled boolean struct fields are JS booleans (`typeof === "boolean"`,
  `=== false` works), OR a recorded accept-decision with sign-off in this file.
- `tests/dogfood/acorn-corpus.mjs` reports `quirk-bool-as-i32` ≈ 0 (fix path).
- Full merge_group validation (batch blast-radius check) — no test262
  regression, no standalone-floor regression.

## Increment landed — `!`/`!!` operator brand (2026-07-24, sendev, Opus)

**Corrected root cause (traced to the emitting site, not inferred).** The
original #2847-carryover note pointed at the struct-field getter
(`_emitStructFieldGettersInner` / `hasBool` fork). Tracing one field
(`generator`) through the actual WAT proved that is NOT where acorn's boolean
fields marshal:

- The `__sget_*` getter path (#1788) and `coerceType`'s i32→externref arm
  (`type-coercion.ts:1971`, `if (from.boolean === true) __box_boolean`) **already
  pick `__box_boolean` when the ValType carries `boolean:true`**. Verified: only
  `prefix`/`generator` are ever struct-field getters, and both are branded — yet
  `generator` still read `0/1` for some nodes.
- Acorn's node boolean fields (`computed`/`async`/`optional`/…) are **dynamic
  sidecar properties** set on open objects (`node.async = !!isAsync`), boxed to
  externref by the dynamic-set helpers (`tryEmitDeleteAwareDynamicSet`,
  `compilePropertyAssignmentExternSet`). Those helpers compile the RHS in its
  natural type then `coerceType(→externref)` — which honours `boolean:true`.
- **So the entire defect is brand-LOSS before boxing, not a boxing-site bug.**
  Instrumenting the dynamic-set site showed the surviving loss forms:
  - boolean **literal** RHS (`= false`) → already branded → boxes as boolean ✓
  - **`!x` / `!!x`** (PrefixUnary) → born **unbranded** i32 (`unary.ts` returned
    `{kind:"i32"}`) → boxed as the number `0/1` ✗ (dominant: `async`, `computed`)

**Fix (contained, dual-mode).** Brand the `!`/`!!` result as
`{kind:"i32", boolean:true}` in `src/codegen/expressions/unary.ts` — the missing
prefix-unary member of the boolean-producing-operator family that #2712's
`brandBooleanBinaryResult` already brands for `===`/`<`/`in`/`instanceof`. `!x` is
definitionally a JS boolean, so this is semantically correct and structurally
inert (still `.kind === "i32"`). Lane-agnostic: the `from.boolean` check fires in
gc/host **and** standalone.

**Measured corpus impact** (`pnpm run dogfood:acorn-corpus`, denominators honest):

| input          | `quirk-bool-as-i32` before | after |
| -------------- | -------------------------- | ----- |
| real/acorn.mjs | 11,843                     | 6,781 |
| real/edge.js   | 258                        | 148   |
| corpus total   | ~12,556                    | ~7,025 (**−44 %**) |

`REAL=0` unchanged (no new structural divergence); `equal` stays 0 because it is
gated by the *separate* `quirk-sourceFile` (#2847, out of scope), present in
every input.

Test: `tests/issue-3557-not-operator-bool-brand.test.ts` (10/10) — `typeof (!x)`,
dynamic-property write of `!!cond`, `=== false`, `JSON.stringify`, Set-element,
plus structural-inertia guards (`!x` in arithmetic stays number; branch cond
works; number fields unaffected).

## Residual — the genuine value-rep slice (#2773), NOT ground here

After the operator fix, the remaining `quirk-bool-as-i32` (acorn self-parse,
measured per-field) is:

- **`optional`: 6,427 (94 % of residual)** — acorn line 2923
  `var optional = optionalSupported && this.eat(types.questionDot)`. The value is
  a boolean at runtime but its boolean-ness is lost through **`&&` where one
  operand (`this.eat(...)`) is `any`/externref-typed**, then through **variable
  storage** (the local is not boolean-branded). `&&`/`||` return the operand type
  and deliberately do **not** brand (branding a number would be a bug), and the
  `any`-typed method return has already boxed as a number upstream — so this is
  not cleanly brandable at any single site without value-rep work.
- **`generator`: 354** — chained `node.generator = node.expression = false`
  (acorn 3491): the inner assignment returns an already-boxed externref that the
  outer set re-stores; the externref lost its boolean tag upstream.

Both are the **"any-passage" residual**: boolean-ness dropped while a value
transits `any`/externref before reaching the marshalling boundary. Fixing them
means preserving a boolean tag through `&&`/`||` operand typing, `any`-typed
method-call return boxing, and boolean-local storage — i.e. the #2773 value-rep
brand-propagation work, explicitly out of scope for this contained increment.
**Recommend:** keep #3557 open tracking this residual under #2773; route the
value-rep slice deliberately (do not grind a substrate rewrite here).

**Gate note:** the operator brand is exactly the typeof/boxing blast-radius class
#1788/#2712 had to guard. PR-level test262 is a designed no-op — the real
regression/standalone-floor gate is the **merge_group** re-validation; expect a
possible auto-park and treat merge_group green as the acceptance evidence.
