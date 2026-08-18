---
id: 4503
title: "IR: a BOOLEAN BRAND so booleans are distinguishable from i32-carried numbers"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: m
feasibility: medium
task_type: feature
area: ir
goal: ir-full-coverage
related: [4467, 4471, 2949, 1788, 2785]
assignee: ttraenkler/opus-4503
origin: "2026-08-15 — #4467's measured residual (boolean template substitutions must keep rejecting because a boolean is indistinguishable from an i32-carried number at the IR type layer) and #4471's measured ref-condition leak."
# from-ast.ts: the type-layer brand and its ToString lowering went into a NEW
# subsystem module (src/ir/boolean-brand.ts), which is why nodes.ts does not
# grow at all. What is left in the god-files is irreducible: the boolean
# PRODUCERS are the comparison/`!`/literal/equality-fold arms inside
# `lowerBinary` / `lowerPrefixUnary` / `lowerExpr`, the template dispatch has to
# live in the lowerer's template arm, and the unbranded-i32 backstop has to sit
# in the numeric conversion it guards.
loc-budget-allow:
  - src/ir/from-ast.ts
# select.ts: one line of code (the boolean arm of `templateSubstitutionFamily`);
# the rest of the growth is the rewritten rationale comment, which had to be
# rewritten rather than deleted — it documented WHY boolean was excluded, and
# that reasoning is what this change answers.
  - src/ir/select.ts
---

# #4503 — IR boolean brand

## Problem

A JS `boolean` and a native-annotated (`type i32 = number`) integer land on the
**same** IR carrier: a bare `{ kind: "val", val: { kind: "i32" } }`. Nothing in
the IR type layer records which one a value is, so once the checker family is
out of reach the lowerer cannot tell `${true}` from `${1}`.

Two measured demands:

1. **#4467's residual.** Numeric template substitutions landed, but boolean ones
   had to keep rejecting at `template-substitution-unsupported`: admitting them
   would have printed `"1"`/`"0"` instead of `"true"`/`"false"` — WRONG OUTPUT,
   not a demote, which is the one outcome that is never acceptable.
2. **#4471's leak.** `if (o) {…} else {…}` over a ref-typed value demotes with
   "if condition must be bool" — no ToBoolean for refs.

## Measurement (2026-08-15, base `fce375e5`)

`.tmp/probe-4503.mts` — `compile(src, { experimentalIR: true, trackIrOutcomes:
true })`, reading the `f` unit's outcome per lane. `CLAIM` = `kind: "emitted"`.

| substitution                       | host                                | nativeStrings                       | standalone                          |
| ---------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| `` `v=${b}` `` (boolean param)     | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v=${true}` `` (literal)        | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v=${x > 0}` `` (comparison)    | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v=${!b}` `` (logical not)      | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v=${b}` `` (boolean local)     | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `${s}/${n}/${b}` `` (mixed)     | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v=${n}` `` (numeric, control)  | CLAIM                               | CLAIM                               | CLAIM                               |
| `` `v=${o}` `` (object, negative)  | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v=${u}` `` (`any`, negative)   | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |

The measurement that decided the DESIGN, though, is a different one: the brand
**already exists** on the ValType. `src/ir/types.ts` has carried
`{ kind: "i32"; boolean?: true }` since #1788 (+ `symbol?: true`, #2785), the
legacy path reads it at its escape-box site (`coerceType(i32 → externref)` picks
`__box_boolean` over `__box_number`), and `typeNodeToIr` already brands a
`boolean` type annotation. Only the IR's own producers had never been threaded
through it — 5 branded sites in `src/ir/**` against ~50 in `src/codegen/**`.

## Design — reuse the ValType brand, do NOT add an `IrType` arm

`irBool()` / `irTypeIsBoolean()` (new module `src/ir/boolean-brand.ts`) wrap
that existing structural flag. Why this instead of a new `{ kind: "bool" }`
`IrType` arm:

- **No value-representation change.** Still an `i32` 0/1 — boxed/dynamic value
  representation is #2949's territory and is deliberately untouched here.
- **The brand is ERASABLE under `irTypeEquals`.** `valTypeEquals` (nodes.ts)
  compares only `kind` (+ `typeIdx`), so a branded and an unbranded `i32` remain
  interchangeable at joins, slot writes and the verifier. Threading the brand
  through more producers therefore **cannot** create a new type mismatch or a
  new demotion. A `bool` arm would have been STRICT here: every join between a
  branded producer (`x > 0`) and an unbranded one (any producer not yet
  converted) would have had to be reconciled in one slice, and every resolver
  and backend switch would have needed a new case.
- **One notion of boolean-ness, not two.** The IR adopts the flag the legacy
  path already boxes by.

Reading contract, and it is load-bearing: **brand present ⇒ proven JS boolean;
brand absent ⇒ UNKNOWN.** A consumer that needs the distinction fails CLOSED.

### What now claims

- **Selector** (`src/ir/select.ts`): `templateSubstitutionFamily` returns
  `"boolean"` for a checker-proven boolean substitution. Unlike the numeric arm
  it needs no `supportsBackendCapability` read — it binds no provider.
- **Producers** (`src/ir/from-ast.ts`): `true`/`false` literals, the six
  comparison arms of `lowerBinary` (+ the #3741 fused-i32 compare, which must
  agree with the unfused arm), `!`, and the `undefined`/`null` equality folds
  now type their result `IR_BOOL` instead of `IR_I32`.
- **Consumer** (`lowerTemplateExpression`): asks the brand **before** the
  numeric conversion, and lowers a branded value to §7.1.17 ToString(Boolean) —
  the literal `"true"`/`"false"`, two `string.const`s selected by the value
  (`cond ? "true" : "false"` is the #3144-lowerable shape, so both string
  carriers work with no per-lane provider).
- **Backstop** (`lowerNumericSubstitutionToString`): an `i32` substitution whose
  source the checker proves boolean but which arrives UNBRANDED demotes at
  `template-substitution-unsupported` instead of taking the numeric conversion.
  This is what makes a future branding gap a demote rather than `${true}` →
  `"1"`.

## Result

Same probe, same three lanes, after the change:

| substitution                       | host  | nativeStrings | standalone |
| ---------------------------------- | ----- | ------------- | ---------- |
| `` `v=${b}` `` (boolean param)     | CLAIM | CLAIM         | CLAIM      |
| `` `v=${true}` `` (literal)        | CLAIM | CLAIM         | CLAIM      |
| `` `v=${x > 0}` `` (comparison)    | CLAIM | CLAIM         | CLAIM      |
| `` `v=${!b}` `` (logical not)      | CLAIM | CLAIM         | CLAIM      |
| `` `v=${b}` `` (boolean local)     | CLAIM | CLAIM         | CLAIM      |
| `` `${s}/${n}/${b}` `` (mixed)     | CLAIM | CLAIM         | CLAIM      |
| `` `v=${o}` `` (object, negative)  | reject (unchanged) | reject | reject |
| `` `v=${u}` `` (`any`, negative)   | reject (unchanged) | reject | reject |

## Byte-identity proof (numeric paths unchanged)

`.tmp/probe-4503.mts` in `PROBE_MODE=digest` mode compiles a fixed corpus —
9 synthetic units (numeric templates, i32-carried `${s.length}`, arithmetic,
bitwise, compare-loop, boolean return/local, string concat, **plus a
boolean-template POSITIVE CONTROL**) and 8 `website/playground/examples/` files,
each × 3 lanes × `experimentalIR: {true,false}` = **102 compiles** — and
sha256's each binary. Before/after were both produced by a run on this box using
the file-copy A/B (`.tmp/base-4503/` holds the pre-edit `from-ast.ts`,
`select.ts`, `nodes.ts`, captured before the first edit).

**Result: 2 of 102 digests changed — both the positive control, both in the IR
lane.**

| entry                                 | before             | after              |
| ------------------------------------- | ------------------ | ------------------ |
| `bool-template \| host \| ir=true`         | `1954a72aaf4ba003` | `3481b8c5a110b00c` |
| `bool-template \| nativeStrings \| ir=true` | `3dcf9b18ed9329b6` | `6e0faa5ebb7e330b` |

Everything else — every numeric unit, every corpus file, and **every** `ir=false`
(legacy) entry — is byte-identical. The control is what makes the zero-diff
meaningful: it proves the harness can see a change at all. Two corroborations of
the same fact: before the change `bool-template` compiled to the same bytes with
and without IR (i.e. it was falling back to legacy), and after the change the two
differ; and the control's outcome flips `unsupported /
template-substitution-unsupported` → `emitted` in all three lanes.

(The standalone control digest does not move: that lane's IR emission for this
unit is byte-identical to its legacy emission. Its OUTCOME flips like the others,
verified separately.)

## Acceptance criteria

1. The IR type layer can answer "is this value a JS boolean?" without the
   checker, without changing the value representation. ✓
2. Boolean template substitutions claim and print `"true"`/`"false"` in all
   three lanes (host, nativeStrings, standalone). ✓
3. Mixed string/number/boolean templates claim; an i32-CARRIED NUMBER
   (`${s.length}`) still prints its digits. ✓
4. Legacy↔IR dual-run equality for every covered shape. ✓
5. Substitution families that are not lowered keep rejecting at
   `template-substitution-unsupported`. ✓
6. Numeric paths byte-identical (proof above); no `check:ir-fallbacks` growth;
   `gen-ir-adoption.mjs --check` clean; `check:ir-only` floors held. ✓

## Residual: ref ToBoolean (#4471's leak) — deliberately NOT in this change

Measured on this branch (`.tmp/ref-cond-4471.mts`, host lane):

| shape                            | outcome                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `if (o) {…} else {…}` (object)   | `invariant` / `unexpected-internal-throw` — "if condition must be bool" |
| `if (s) {…} else {…}` (string)   | `invariant` / `unexpected-internal-throw` — "if condition must be bool" |
| `o ? 1 : 2` (object)             | `invariant` / `unexpected-internal-throw` — "ternary condition must be bool" |
| `if (!o)` (object)               | `unsupported` / `operand-coercion-unsupported` — "unary '!' expects bool" |

The brand does **not** make this fall out cheaply, and it is worth being precise
about why: the brand answers "is this value already a boolean?", whereas these
sites need to PRODUCE one from a non-boolean — a per-type ToBoolean (§7.1.2)
whose arms genuinely differ. A WasmGC object/class ref is truthy iff non-null; a
`string` is truthy iff its length is non-zero; an `extern` (host) value follows
full JS truthiness (`0`, `""`, `null`, `undefined` all falsy) and cannot be
answered by a null test at all. Each arm is its own correctness question, and it
also needs a matching selector admission, so it belongs in its own slice. What
this change does give it: the produced value has an obvious type to carry
(`irBool()`), and the demote is currently on the INVARIANT channel
(`unexpected-internal-throw`), which is itself worth converting to a clean
capability reject.

## Test Results

- `tests/issue-4503.test.ts` — **29/29 pass**. Brand unit claims (marks only a
  boolean-carrying i32; representation unchanged; **erasable under
  `irTypeEquals`** — the backward-compat property stated as an assertion), then
  per lane: claim for four boolean shapes, the `"true"`/`"false"` spelling pin,
  legacy↔IR dual-run equality, a mixed string/number/boolean/`${s.length}`
  template, and the numeric-path re-pin; plus object/`any` negative boundaries.
- `tests/issue-4467.test.ts` — **16/16 pass**, with its AC#4 boolean case
  flipped from "still rejects" to "claims since #4503" (that assertion WAS the
  residual; leaving it would have pinned the bug). Its numeric ACs are untouched.
- `pnpm run check:ir-fallbacks` — OK; unintended, post-claim and module-level
  buckets all empty, unchanged vs. baseline.
- `node scripts/gen-ir-adoption.mjs --check` — clean, after regenerating the
  `TemplateExpression` row (the row TEXT lives in `scripts/gen-ir-adoption.mjs`,
  not in the .md — editing the .md alone would have been silently overwritten).
- `pnpm run check:ir-only` — verdict READY. Host lane 37/37 emitted, 0
  unsupported, 0 invariants. Standalone lane 19 emitted / 18 unsupported / 0
  invariants, with the unsupported codes all pre-existing families
  (`host-surface-unavailable` 6, `body-shape-rejected` 3, `call-graph-closure`
  3, `async-function` 4, `date-constructor-unsupported` 1,
  `primitive-method-unsupported` 1) — none template- or boolean-related.
- `pnpm exec vitest run tests/issue-3765-numeric-locals.test.ts` — 18/18 (the
  pre-push gate for exactly this change's regression risk: the direct/IR numeric
  carrier contract).
- `scripts/check-loc-budget.mjs` (OK under the two allowances in this
  frontmatter) / `check-func-budget.mjs` (OK, **no** allowance needed). The
  brand + its ToString lowering were extracted to `src/ir/boolean-brand.ts`
  first, which took `nodes.ts` growth to zero and roughly halved from-ast's;
  `lowerBinary` needed one comment line trimmed to stay under its function
  budget rather than being granted one.
- `scripts/equivalence-gate.mjs`, **all 8 shards — no new regressions.** Shards
  2/4/6/7 additionally report baseline known-failures as `fixed`
  (`coercion/arithmetic-add`, `Math.pow`, the #1197 i32 peephole,
  `symbol-basic`). That is baseline staleness, and it is MEASURED rather than
  inherited from #4467's identical note: re-running shard 7 with the pre-edit
  `from-ast.ts`/`select.ts` swapped back in (`.tmp/base-4503/`) reports the SAME
  two `symbol-basic` entries as fixed.
- `prettier --check`, `biome lint`, `check-oracle-ratchet.mjs`,
  `check-coercion-sites.mjs`, `check-issue-ids.mjs --against-main`,
  `update-issues.mjs --check` — clean.
- **Re-validated on the merged state** after `main` advanced (`51043a65`, which
  itself moved `src/ir/from-ast.ts`, `select.ts`, `types.ts` and added
  `array-spread-shape.ts`): tests 63/63 across the three files above,
  `check:ir-fallbacks` OK, `gen-ir-adoption --check` clean, both budget gates
  OK, equivalence shards 2 and 7 clean, and the 102-entry digest set is
  **identical to the pre-merge run** — main's IR work and this brand do not
  interact on the corpus.
- `tsc --noEmit`: the known `@types/node` resolution noise under symlinked
  `node_modules`; 33 non-`TS2591`/`TS2304` errors, **none** in any file this
  change touches (same set as on base). CI runs the real typecheck.
