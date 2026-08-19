---
id: 4467
title: "IR: adopt NUMERIC template-literal substitutions (`\\`a${n}b\\``)"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: s
feasibility: medium
task_type: feature
area: ir
language_feature: template-literals
goal: ir-full-coverage
related: [3518, 3583, 3912, 2955, 2856]
origin: "2026-08-15 #3583 adoption-matrix measurement — the `TemplateExpression` row's promotion criterion is 'Template substitutions support the remaining typed coercion families'; STRING claims, NUMERIC rejects."
# The seam itself (the per-lane provider) went into a NEW subsystem module,
# `src/ir/number-to-string-provider.ts`. What is left in the three god-files is
# irreducible: the claim predicate has to live in the selector's template arm,
# the conversion has to live in the lowerer's template arm, and the resolver's
# intrinsic dispatcher is one `else if` per symbol. integration.ts grows by the
# import + those two dispatcher lines only.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
# The family predicate itself is extracted to a module-level
# `templateSubstitutionFamily`. What remains inside the dispatcher is one net
# line: the arm has to bind the family (the module-scalar guard below it
# compares against it) where it previously only had to test one boolean.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

# #4467 — IR: numeric template-literal substitutions

## Problem

The IR front-end claims a template literal only when **every** substitution is
checker-proven `string`. Any numeric substitution rejects at
`template-substitution-unsupported` (`src/ir/select.ts`, the
`ts.isTemplateExpression` arm), so the whole enclosing function demotes to the
legacy AST→Wasm path.

`` `a${n}b` `` with `n: number` is the single most common template shape in real
code, so this one rejection reason keeps a large amount of otherwise-claimable
code on legacy. The adoption-matrix row (`plan/log/ir-adoption.md`,
`TemplateExpression`) names exactly this as its promotion criterion:

> Template substitutions support the remaining typed coercion families.

## Measurement (2026-08-15, base `9e17d34f`)

`.tmp/probe-4467.mts` — `compile(src, { experimentalIR: true, trackIrOutcomes: true })`,
reading the `test` unit's outcome per lane. `CLAIM` = `kind: "emitted"`.

| substitution                 | host                                | nativeStrings                       | standalone                          |
| ---------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| `` `a${s}b` `` (string)      | CLAIM                               | CLAIM                               | CLAIM                               |
| `` `a${n}b` `` (f64)         | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${n}b` `` (`i32` alias) | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${b}b` `` (boolean)     | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `${s}=${n}!` `` (mixed)   | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `v${3}` `` (num literal)  | `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${n * 2}b` `` (num expr)| `template-substitution-unsupported` | `template-substitution-unsupported` | `template-substitution-unsupported` |
| `` `a${n.toString()}b` ``    | CLAIM                               | `primitive-method-unsupported`      | `primitive-method-unsupported`      |

Two facts fall out of the last row and drive the design:

1. In the **host** lane the number→string result already composes with the
   existing string-concat chain — `${n.toString()}` claims today. So the host
   arm needs no new representation work, only the implicit conversion.
2. In the **native** lanes there is no IR-side number→string at all: the
   `<number>.toString()` arm demotes on `hasHostNumberToString() === false`.
   Since #3912 the legacy path has a **native** `number_toString`
   (`src/codegen/number-format-native.ts`) whose `externref` result is an
   `$AnyString` widened by `extern.convert_any` — recovering the native string
   carrier is `any.convert_extern` + `ref.cast $AnyString`, exactly what
   `emitNativeStringRefFromExternref` does in `src/codegen/string-ops.ts`.

## Acceptance criteria

1. A numeric (`number` / `i32`-alias) substitution is IR-claimed and lowers to
   spec-correct §7.1.17 `Number::toString` output in **all three** lanes (host,
   nativeStrings, standalone).
2. Mixed string+number templates claim.
3. Special values pin against node: `-0` → `"0"`, `NaN` → `"NaN"`,
   `Infinity`/`-Infinity`, integer vs decimal formatting, exponent forms.
4. Substitution families that are **not** lowered keep rejecting at
   `template-substitution-unsupported` — the selector arm admits exactly what
   the lowerer handles.
5. Legacy↔IR dual-run equality for every covered shape.
6. No `check:ir-fallbacks` growth; `gen-ir-adoption.mjs --check` clean;
   `check:ir-only` host lane holds at 37/37 and standalone floors do not
   regress.

## Design

- **Selector** (`src/ir/select.ts`): the template arm accepts a substitution
  whose declared family is `string` **or** `number`; every other family keeps
  the existing `template-substitution-unsupported` rejection.
- **Lowering** (`src/ir/from-ast.ts` `lowerTemplateExpression`): a substitution
  that lowers to an `f64`/`i32` value is routed through a shared
  number→string seam and then fed to the existing `emitStringConcat` chain.
- **The seam** is a single IR intrinsic (`IR_NUMBER_TO_STRING_FN`) resolved
  per-lane in `src/ir/integration.ts`, the same shape as `IR_STRING_CONCAT_FN` /
  `IR_STRING_CHAR_AT_FN`:
  - host: the `env.number_toString` `(f64) -> externref` import — externref IS
    the host lane's string carrier.
  - native: `emitNativeNumberFormat(ctx, {"number_toString"})` plus a minted
    `(f64) -> (ref $AnyString)` thunk that unboxes the formatter's widened
    result (`any.convert_extern` + `ref.cast`). Minting the thunk keeps the
    intrinsic's IR-visible signature representation-correct in both lanes, so
    from-ast never has to ask a mode question.
- **Boolean substitutions** are taken only if the same seam gives them for free
  with spec-correct `"true"`/`"false"`; otherwise they keep rejecting and the
  residual is recorded below.

## Result

Same probe, same three lanes, after the change:

| substitution                  | host  | nativeStrings | standalone |
| ----------------------------- | ----- | ------------- | ---------- |
| `` `a${s}b` `` (string)       | CLAIM | CLAIM         | CLAIM      |
| `` `a${n}b` `` (f64)          | CLAIM | CLAIM         | CLAIM      |
| `` `${s}=${n}!` `` (mixed)    | CLAIM | CLAIM         | CLAIM      |
| `` `v${3}` `` (num literal)   | CLAIM | CLAIM         | CLAIM      |
| `` `a${n * 2}b` `` (num expr) | CLAIM | CLAIM         | CLAIM      |
| `` `len=${s.length}` `` (i32) | CLAIM | CLAIM         | CLAIM      |
| `` `a${b}b` `` (boolean)      | reject (unchanged) | reject | reject |

`${s.length}` is worth calling out separately: it is the i32-CARRIED numeric
operand, so it exercises the `f64.convert_i32_s` arm of the conversion without
needing a `number`-annotated binding. (The explicit `type i32 = number` alias
could NOT be used to exercise it — `const k: i32 = …` is itself rejected at
`body-shape-rejected`, an unrelated pre-existing blocker on the i32 vardecl
type node, so the alias never reaches the template arm at all.)

### Special-value pins (§7.1.17 / §6.1.6.1.13)

All three lanes match node exactly for `0`, `-0` → `"0"`, `1`, `-1`, `42`,
`3.5`, `-3.5`, `0.1`, `1e21` (fixed→exponential threshold), `1e-7`
(small-magnitude threshold), `123456789012345680` (past 2^53 exactness),
`2 ** 31` (past i32 range — no wrap), `NaN`, `Infinity`, `-Infinity`.

Expectations are computed from node's own template evaluation rather than a
hand-written table, so the pin cannot drift from the spec the host implements.

## Residual: BOOLEAN substitutions (deliberate, not an oversight)

`` `${b}` `` with `b: boolean` keeps rejecting. The seam does NOT give it for
free: a boolean lowers to IR's `i32`, the same carrier a native-annotated
number uses, so once the checker family is gone the lowerer cannot tell
`${true}` → `"true"` from `${1}` → `"1"`. Admitting it would break claim ⇔
lowering parity in the one direction that produces WRONG OUTPUT rather than a
demote. The unblocker is an IR boolean brand on the value, not a formatter;
until then the selector rejects and the legacy path (which still has the
checker type at the substitution site — `emitBoolToString`, string-ops.ts)
handles it correctly.

## Test Results

- `tests/issue-4467.test.ts` — **16/16 pass**. Per lane: claim, special-value
  pins, legacy↔IR dual-run equality, and the mixed/multi/expression/i32-carried
  shapes; plus boolean and object substitutions pinned as still rejecting at
  `template-substitution-unsupported`.
- `pnpm run check:ir-fallbacks` — OK, no unintended/post-claim/module-level
  increases.
- `node scripts/gen-ir-adoption.mjs --check` — clean (row regenerated).
- `pnpm run check:ir-only` — verdict READY; single-host 37/37 emitted,
  0 unsupported; standalone floors exactly at baseline (17 emitted,
  20 unsupported, same per-code split) — no regression.
- `scripts/check-loc-budget.mjs` / `check-func-budget.mjs` — OK under the
  allowances granted in this frontmatter.
- Pre-existing failures confirmed identical on base `9e17d34f` (NOT caused by
  this change, verified by re-running each in a worktree at that sha):
  `pnpm run check:linear-ir` (already FAIL: IR-compiled count 8→6,
  `illegal:instr-vec.set_length` and `select:string-builder-candidate` both
  0→2) and `tests/issue-2029-tagged-template-capture-local-index.test.ts`
  ("materializes a forward capturing sibling returned as a callable").
- `tsc --noEmit`: 484 errors, all the known `@types/node` resolution noise
  under symlinked `node_modules`; 22 non-`TS2591`/`TS2304` errors, none in any
  file this change touches. CI runs the real typecheck.
- `node scripts/profile-godfiles.mjs --check` — 11 regressions, byte-identical
  to the same command on base `9e17d34f`; none in a file this change touches.
- `node scripts/check-oracle-ratchet.mjs`, `check-issue-ids.mjs
  --against-main`, `prettier --check`, `biome lint` — all clean.
- `scripts/equivalence-gate.mjs`, **all 8 shards — no new regressions.**
  Several shards additionally report baseline known-failures as `fixed`
  (`coercion/arithmetic-add`, `symbol-basic`, `Math.pow`, the #1197 i32
  peephole). **These are NOT this change's doing, and that is measured, not
  assumed**: running shard 2 in a worktree at base `9e17d34f` reports SIX
  `fixed` entries in that shard alone — including the exact
  `coercion/arithmetic-add standalone-O any string + any string concatenates`
  the branch reported — against the branch's one. The baseline is simply stale
  (and partly nondeterministic) relative to main; the gate does not fail on it.

  **Methodology note, worth keeping:** `equivalence-gate.mjs` calls
  `process.exit()`, which TRUNCATES pending stdout writes when stdout is a
  PIPE. `node scripts/equivalence-gate.mjs 2>&1 | tail -N` therefore showed
  only the stderr `JSON report written …` line for shards 4 and 8, which reads
  exactly like a crashed/failing shard. Both were clean on re-run with a file
  REDIRECT (`> file 2>&1`), which is synchronous and loses nothing. Redirect,
  don't pipe, when you need this script's verdict.
