---
id: 6778
title: "linear backend: `string + number` emits `f64.add` on an i32 string pointer — invalid binary with `success: true`, zero diagnostics"
status: done
completed: 2026-10-02
assignee: "ttraenkler/claude-dev-6778"
branch: "claude/issue-6778-linear-mixed-plus"
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: string-concat
goal: crash-free
related: [6776, 6793, 1868, 1976, 3908]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C2"
---

# #6778 — linear `+` with one string operand compiles to numeric addition

## Problem

```ts
export function f(): number { const s = "1" + 2; return s.length; }
```

`compile(src, { target: "linear" })` → `success: true`, `errors: []`.
`WebAssembly.compile(binary)` →
`Compiling function #50:"f" failed: f64.add[0] expected type f64, found if of type i32`.
Reproduced against the built `dist/index.js` on 2026-09-30.

## Root cause

`src/codegen-linear/index.ts:2510`:

```ts
if (isStringExpr(ctx, fctx, expr.left) && isStringExpr(ctx, fctx, expr.right))
```

The string-concat path requires **both** operands to be strings; a mixed `+`
falls through to the numeric path, which emits `f64.add` on whatever the
string side left on the stack (an i32 pointer). Nothing between codegen and
the result checks the binary (#6776), and `collectLinearCodegenErrors`
(`src/compiler.ts:1025-1027`) does not see this class because no error was
ever pushed.

#1976 fixed the compound-assignment variant of the same bug (`s += 1`) but
not the plain binary form.

## Correction

Change the test to **either** operand being a string (spec §13.15.3 step 3:
if either ToPrimitive result is a String, concatenate). Coerce the other side
with the backend's existing number→string helper (the one `toFixed`/template
literals use), then emit the concat. If the non-string side is an object
carrier the backend cannot stringify, push a linear codegen error rather than
falling through.

## Acceptance

- The probe returns `2` on `target: "linear"`; also `2 + "1"`, `` `${1}` + "x"
  ``, `"a" + true`, `"a" + null`, `"a" + undefined` match Node.
- Regression test under `tests/linear/` (or the existing linear test file
  family) compiles, validates with `WebAssembly.validate`, instantiates, and
  checks the runtime value.
- A `cross-backend-parity` corpus entry for mixed `+`.

## Implementation Plan

Taken from the Correction section above, executed as:

1. `src/codegen-linear/coercion-engine.ts` (the module that already owns the
   linear ToString contract) gains:
   - `classifyToStringOperand` — per-operand ToString plan from the checker
     type: `string` (mirrors `isStringExpr`, incl. `string | undefined`),
     `number` (every member NumberLike), `boolean` (every member BooleanLike),
     the `null` / `undefined` literals, else `unsupported`.
   - `emitOperandToString` — string: compile as-is; number:
     `compileExprToF64` + `number_toString` (Ryū); boolean: `f64.ne 0` →
     `if (result i32)` selecting the `"true"`/`"false"` literals;
     null/undefined: the literal; anything else (objects, `any`, mixed
     unions, bigint) or a number with no formatter linked: a hard
     `ctx.errors` diagnostic at the operand's location, never a fall-through.
   - `emitStringConcat` — ToString(left), ToString(right), `__str_concat`.
   - `nodeStringifiesNumber` — the source-gate predicate (below), kept beside
     the emitter so the two agree.
   The direct-lowering hooks come in through a `LinearToStringCompiler`
   object (same pattern as `string-methods.ts`), so no import cycle.
2. `src/codegen-linear/index.ts::compileBinaryExpression`: the concat test is
   now "`+` and EITHER operand `isStringExpr`" → `emitStringConcat`; the old
   both-strings `+` arm is removed (the both-strings block keeps `===`/`<`…).
   The string `+=` arm (#1976) compiled the RHS raw, so `s += 1` passed an
   f64 to `__str_concat` — same root cause; its RHS now goes through
   `emitOperandToString` too.
3. `src/codegen-linear/number-format.ts::sourceMayUseLinearNumberToString`:
   the Ryū runtime was linked only for `n.toString()`, so a numeric template
   span (`` `${1}` ``) silently became `""` and the new number arm would have
   had no formatter. The gate now also fires on a string `+`/`+=` with a
   numeric operand and on a numeric template span. (Linked mode still refuses
   the formatter, #4540 — such a program now gets that hard error instead of
   an invalid binary.)
4. Tests: `tests/issue-6778-linear-mixed-plus.test.ts` and a
   `string/mixed-plus` entry in `tests/cross-backend/corpus.ts`.

## Resolution

Probe `.tmp/probe-6778.mts` (22 rows × `JS2WASM_LINEAR_IR` 0/1, each compiled
with `target: "linear"`, validated, instantiated, compared to Node):

| row | before | after |
|---|---|---|
| `"1" + 2` (issue repro, `.length`) | invalid binary (`f64.add[0] … found if of type i32`) | `2` = Node |
| `2 + "1"`, `"a" + true/false/null/undefined`, `"x" + 1.5`, `n + "px"`, `"a" + 1 + 2`, `1 + 2 + "a"`, `"v" + b`, NaN/-0/1e21/Infinity | invalid binary | = Node (content checked with `===`) |
| `` `${1}` + "x" `` | `1` (span silently `""`) | `2` = Node |
| `s += 1`, `s += true`, `for … s += i` | invalid binary (`call` arg f64 vs i32) | = Node |
| `"x" + {a:1}` | invalid binary | hard error: `cannot convert an operand of type '{ a: number; }' to a string for \`+\` concatenation` |

Before: 1 / 22 rows matched Node per lane (only `s += "b"`). After: 21 / 22,
the remaining row being the intended refusal. Both IR-overlay settings agree.

Note: the Root cause section says #1976 fixed `s += 1`; it fixed only
string-on-string `+=` — a numeric RHS was still invalid until this change.

Tests: `tests/issue-6778-linear-mixed-plus.test.ts` (37: 18 rows × 2 overlay
settings + the object refusal) passes; `tests/linear-*.test.ts`,
`tests/issue-1976.test.ts`, `tests/cross-backend-diff.test.ts` (with the new
`string/mixed-plus` row) and `tests/issue-4540-heap-coexistence.test.ts`:
25 files, 234 passed / 4 skipped (artifact-gated). The other linear issue
tests: 4 failures in `issue-3497-*` / `issue-3500-*` reproduce identically
with the base sources (A/B by file copy) — pre-existing, not from this change.
`pnpm run test:guard`: 20 files / 255 passed.

Gates (all exit 0): check-loc-budget, check-func-budget (also with
`LOC_GATE_BASE` = upstream main tip), check-coercion-sites,
check:oracle-ratchet, check:dead-exports, typecheck, format:check,
compiler-boundaries inventory, ir-dialect, ir-kind-neutrality, jstag-seam,
ir-layering, codegen-fallbacks, any-box-sites, speculative-rollback,
stack-balance, pushraw, host-import-policy, ir-only, ir-adoption, issues,
done-status-integrity, issue-spec-coverage, harness-compile-budget,
verdict-oracle, lint, check:ir-fallbacks. No budget allowances needed.

Deliberately left out: template-literal spans still classify by
`inferExprType` — a boolean span becomes `""`, or `"1"` once the formatter is
linked (measured: `` `${b}`.length `` → 0, `` (`${b}` + 1).length `` → 2; Node
4 / 5), and an object span is read as a string pointer. Template lowering is
outside this issue (follow-up candidate); the
`undefined`-is-`0` representation and the IR-overlay swallow stay with #6793.

