---
id: 2184
title: "linear backend: &&/|| yield 0/1 constants instead of operand values (needs result-type unification)"
status: done
completed: 2026-06-17
assignee: ttraenkler/dev-resume
sprint: 63
created: 2026-06-16
updated: 2026-06-17
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1975, 1976]
origin: "2026-06-16 split from #1975 — the ToBoolean half (NaN/empty-string truthiness) landed in PR #1412; this is the deferred operand-value half the issue explicitly carved out as a dedicated issue."
---

# #2184 — linear `&&`/`||` discard the operand value

## Problem (`target: "linear"`)

JS `a || b` / `a && b` evaluate to **the operand value**, not a boolean.
The linear backend's logical-operator lowering coerces its result to f64 and
yields the constants `0` / `1` on the short-circuit arm instead of the
operand:

| probe                                  | linear | node  |
|----------------------------------------|--------|-------|
| `const r = "" \|\| "x"; return r;`      | `1`/0  | `"x"` |
| `const r = "a" && "b"; return r;`      | `1`    | `"b"` |
| `const r = 0 \|\| 42; return r;`        | `1`    | `42`  |

The **boolean-context** use (`if ("" \|\| x)`, `while`, ternary condition) is
already correct — that path was fixed in #1975 (PR #1412), which made
`emitTruthyCoercion` NaN/empty-string aware. This issue is only the
*value-producing* use of `&&`/`||`.

## Root cause

`src/codegen-linear/index.ts` logical-operator lowering (the `&&`/`||` arm,
~index.ts:1921-1948 at the time of #1975) emits an `if` whose result type is
f64-only and pushes `0`/`1` constants, rather than tee-ing the LHS and
yielding the actual operand value. JS semantics: `a || b` ⇒ `ToBoolean(a) ?
a : b`; `a && b` ⇒ `ToBoolean(a) ? b : a` — both yield an *operand*, whose
static type may be string (i32 pointer), f64, or boolean.

## Why it was split from #1975

#1975's progress note: *"Fixing this needs result-type unification in the
linear backend (the f64-only `if` result type can't carry a string operand),
which is a larger change than the ToBoolean fix and is left for a dedicated
issue."* The ToBoolean correctness fix (the verified problem-table repros)
shipped; this is the carved-out remainder.

## Fix direction

- Compute the unified result ValType of the two operands (string/f64/bool);
  emit an `if` typed to carry that value.
- Tee the LHS into a temp, run `emitTruthyCoercion` on the tee for the branch
  condition, and yield the LHS temp on the short-circuit arm / the RHS on the
  other — no `0`/`1` constants.
- Mixed-type operands (`"" || 42`) need the `any`/boxed representation or a
  documented restriction; scope the first slice to same-typed operands and
  file a follow-up for mixed types if needed.

## Acceptance criteria

- `"" || "x"` ⇒ `"x"`, `"a" && "b"` ⇒ `"b"`, `0 || 42` ⇒ `42` in linear mode
  (match Node).
- Boolean-context `&&`/`||` (the #1975 path) stays correct — no regression in
  `tests/issue-1975.test.ts`.
- New `tests/issue-2184.test.ts` covering value-producing `&&`/`||` for
  string and numeric operands.

## Notes

GC backend already yields operand values correctly; this is linear-only.

## Resolution (2026-06-17, PR for #2184)

Fixed in `src/codegen-linear/index.ts`:

- **Same-typed operands** (`string||string`, `number||number`, `bool&&bool`):
  the lowering now tees the LHS into a temp, runs `emitTruthyCoercion` on the
  tee'd value for the branch condition, and yields the **actual operand** —
  `local.get leftTemp` on the short-circuit arm, the RHS on the other. The `if`
  result ValType is the operand's native type (string `i32`-pointer / `f64` /
  bool `i32`), so no `0`/`1` constants and no value loss. `inferExprType` gained
  a matching `&&`/`||` case so callers (var decl, return) allocate a local of
  the same type.
- **Mixed-type operands** (e.g. string `i32` vs number `f64`): kept the legacy
  boolean-producing lowering. Coercing a string pointer to `f64` to share one
  `if` result type would corrupt both the value and downstream truthiness (a
  nonzero pointer reads truthy even for `""`). This is the documented
  same-typed-first scope; covering mixed-type *values* needs a boxed/`any`
  representation and is left as a follow-up. Boolean-context mixed use stays
  correct (the #1975 path).

## Test Results

`tests/issue-2184.test.ts` — 12/12 pass (operand-value `&&`/`||` for numeric +
string operands, chains, typed-local flow, plus #1975 boolean-context regression
guards). `tests/issue-1975.test.ts` — 8/8 still pass.
`tests/equivalence/{logical-operators,coalesce-operator,boolean-relational-comparison}.test.ts`
pass unchanged. (Pre-existing, unrelated failures confirmed on pristine
upstream/main: `ir-numeric-bool-equivalence` `__unbox_number` link errors;
`logical-conditional-identity` `void x` NaN cases.)
