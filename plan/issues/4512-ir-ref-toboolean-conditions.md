---
id: 4512
title: "IR: ref-typed ToBoolean in condition/ternary/`!` position"
status: in-progress
assignee: ttraenkler/dev-4512
sprint: current
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ir
language_feature: coercion
goal: ir-full-coverage
related: [4503, 4471, 2136]
created: 2026-08-16
updated: 2026-08-16
loc-budget-allow:
  - src/ir/from-ast.ts
---

<!--
loc-budget-allow justification (#4512): +21 net in the god-file. The new
`lowerToBooleanForCondition` helper is a SHARED §7.1.2 ToBoolean now serving
four condition sites (tail-if, ternary, discarded-ternary, `!`) plus the loop
path (`coerceLoopCondToBool` delegates to it, deleting its duplicated arms).
Consolidating the ToBoolean logic into one correct place — including the
host-externref demote that removes a latent wrong-answer — is worth the modest
net growth; the alternative (inline coercion at each site) would be larger.
-->


# #4512 — ref-typed ToBoolean in condition position

Deferred residual of #4503 (boolean brand). Ref-typed values in
boolean-condition position (`if (o)`, `o ? a : b`, `!o`) did not produce a
§7.1.2 ToBoolean and demoted to legacy.

## The gap (measured on main `6fa03173`, host/nativeStrings/standalone)

| shape                       | before                                             |
| --------------------------- | -------------------------------------------------- |
| `if (o) {…} else {…}` tail  | `unsupported / body-shape-rejected` @build         |
| `if (s) {…} else {…}` tail  | `unsupported / body-shape-rejected` @build         |
| `o ? 1 : 2`                 | `unsupported / operand-coercion-unsupported` @build |
| `s ? 1 : 2`                 | `unsupported / operand-coercion-unsupported` @build |
| `!o`                        | `unsupported / operand-coercion-unsupported` @build |
| `!s`                        | `unsupported / operand-coercion-unsupported` @build |
| `if (o){…}` (body, w/ else) | **already emitted** (via `coerceLoopCondToBool`)   |
| `while (o) {…}`             | **already emitted** (via `coerceLoopCondToBool`)   |
| `if (o:any)` tail           | `unsupported / body-shape-rejected` @build         |
| `if (o:unknown)`            | `unsupported / param-type-not-resolvable` @select  |

Note: the #4503 residual table described these as `invariant /
unexpected-internal-throw`; on current main the #4502 throw-sweep had already
converted every one of these arms to a **typed `unsupported` demote**. There
were **no invariant throws** left in the touched arms — only capability demotes
to widen into real lowering.

## After (this change, all three lanes)

Every shape above now `emitted(ir+)` except `if (o:unknown)`, which continues
to reject cleanly at **select** (`param-type-not-resolvable`) — the deliberate
externref negative boundary (a raw host externref may box a falsy primitive, so
ToBoolean needs the JS host; a `ref.is_null` test would be a wrong answer).

## Carriers: lowered vs demoted

Shared helper `lowerToBooleanForCondition` (`src/ir/from-ast.ts`) — §7.1.2 per
carrier, result branded `irBool()` (#4503):

| carrier                                     | ToBoolean                          | verdict |
| ------------------------------------------- | ---------------------------------- | ------- |
| i32                                         | pass through (branch cond / eqz)   | lower   |
| f64                                         | `abs(x) > 0` (NaN-safe, #1937)     | lower   |
| string                                      | `length !== 0`                     | lower   |
| object / class / closure / non-null ref     | const `true` (always truthy)       | lower   |
| nullable wasmgc ref (ref_null/eqref/anyref/funcref/callable) | `ref.is_null; i32.eqz` | lower |
| dynamic (boxed-any)                         | `dyn.truthy` (full ToBoolean, D4)  | lower   |
| host externref / ref_extern                 | (return null → caller demotes)     | **demote** `operand-coercion-unsupported` |

`coerceLoopCondToBool` (loops) now delegates to the same helper — this also
corrected its previous `extern`/`externref`/`ref_extern` arm, which did a
`ref.is_null` test (a wrong ToBoolean for a boxed falsy primitive); it now
demotes. That arm is unreachable on the corpus (such conditions reject at
select), so the change is byte-inert there but removes a latent wrong-answer.

## By-value truthiness (host lane, IR == legacy == JS)

`object non-null → truthy`, `null → falsy`, `"" → falsy`, `"x" → truthy`,
`!` negates each, verified via a side-effect/return marker across
`if` / ternary / `while`. All PASS.

## Sites changed (`src/ir/from-ast.ts`)

- tail-`if` (block-CFG) — was raw i32 check → now shared coercion.
- `lowerConditional` ternary — was dynamic-only + i32 → now shared coercion.
- discarded-ternary (`lowerDiscardedExpression`) — same.
- `lowerPrefixUnary` `!` arm — i32 fast-path kept; ref/string/dynamic via helper.
- `coerceLoopCondToBool` refactored to delegate (loops unchanged in behaviour,
  minus the corrected host-externref arm).

No `select.ts` change: the selector already admits object/string conditions
(proven by the pre-existing body-`if`/loop emission).

## Acceptance criteria

1. `if`/ternary/`!`/`while` with an object, string or nullable ref condition
   claims through IR in all three lanes. ✓
2. By-value truthiness correct per §7.1.2, IR == legacy. ✓
3. Result carries `irBool()`. ✓
4. Raw host externref demotes cleanly (typed `unsupported`, not `invariant`). ✓
5. No `check:ir-fallbacks` unintended/post-claim growth; `gen:ir-adoption
   --check` clean; `check:ir-only` floors held.

## Finding: pre-existing legacy `nativeStrings` empty-string bug (IR is correct)

Measured: in the `nativeStrings` lane, LEGACY treats an empty native string as
TRUTHY — `if ("")` / `"" ? a : b` / `!""` take the wrong branch (host and
standalone legacy are correct). The IR path length-tests correctly, so IR and
legacy DIVERGE there — IR is MORE correct. Legacy↔IR parity is therefore pinned
on the host lane (legacy spec-correct); IR-vs-JS is pinned on all three lanes.
(A separate legacy-nativeStrings fix is out of scope here.)

## Test Results

- `tests/issue-4512.test.ts` — **54/54 pass**. Per lane (host/nativeStrings/
  standalone): CLAIM + `irBodyEmitted` non-vacuity for object/string/number
  `if`/ternary/`!`/`while`; BY-VALUE `IR == JS` for string (`""`→falsy,
  `"x"`→truthy) and number (`0`/`NaN` falsy) conditions incl. `!`; host-lane
  legacy↔IR parity; and the `unknown` (host externref) negative boundary
  rejecting `unsupported` (not `invariant`), `irBodyEmitted === false`, in all
  three lanes.
- `tests/issue-2136.test.ts` + `tests/issue-1980.test.ts` — **10/10 pass** (loop
  condition path unchanged by the `coerceLoopCondToBool` → shared-helper
  refactor).
- `tests/issue-4503.test.ts` (29) + `tests/issue-4467.test.ts` (16) — pass (the
  brand and template consumers untouched).
- `pnpm run check:ir-fallbacks` — OK, no unintended/post-claim/module-level
  growth.
- `node scripts/gen-ir-adoption.mjs --check` — up to date (no row change).
- `pnpm run check:ir-only` — verdict READY; floors held; unsupported codes all
  pre-existing families (host-surface-unavailable / body-shape-rejected /
  call-graph-closure / date-constructor / async-function) — none ToBoolean.
- `scripts/check-loc-budget.mjs` — OK (+21 in `from-ast.ts`, granted by this
  issue's `loc-budget-allow`); `scripts/check-func-budget.mjs` — OK (no
  allowance needed).
- `tsc --noEmit` — no NEW errors in touched files (the pre-existing
  `@types/node` symlink noise only; CI runs the real typecheck).
