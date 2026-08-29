---
id: 5163
title: "IR: adopt mutating expression statements with property/element LHS (`o.x += 1;`, `o.x++;`, `a = b = 1;`)"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: adoption
area: ir
language_feature: statements
goal: ir-full-coverage
related: [4459, 3583, 3518, 2949]
origin: "2026-08-28 IR-takeover session — measured residual on the ExpressionStatement row; scout probes in .tmp/stmtmut-*.ts"
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #5163 — IR adoption of mutating expression statements (property/element LHS + chained assign)

## Problem

#4459 adopted value-DISCARDING expression statements; the MUTATING shapes with
no dedicated arm still reject. Measured 2026-08-28 (all probes in
`.tmp/stmtmut-*.ts`, run via `JS2WASM_IR_SHAPE_DIAG=1 npx tsx .tmp/ir-probe.mts`):

| shape | position | rejection arm |
| --- | --- | --- |
| `o.x += 1;` / `a[i] += 1;` | top level | `nontail-compound-or-binary-stmt` |
| `o.x++;` / `++o.x;` | top level | `nontail-incdec-stmt` |
| `a = b = 1;` | top level | `nontail-assign-nonprop-lhs` |
| `o.x = o.y = 1;` | top level | `expr-binary-op-=` (property-assign arm admits `o.x =`, RHS check rejects the inner assign) |
| `o.x += 1;` / `a[i] += 1;` | loop/try body buffer | `body-exprstmt-other` (body compound arm is identifier-only) |
| `o.x++;` etc. | loop body | bare false at select.ts:4826 → relabeled `nontail-while` |
| local `a = 1;` / `x++;` | top level | `nontail-assign-nonprop-lhs` / `nontail-incdec-stmt` — the TOP-LEVEL walker has NO local-assign/incdec arm at all (the adoption table's "plain-local assign and ++/-- claim" holds only in body buffers / for-update) |

Controls that CLAIM+EMIT today: local `x += n;` in all three positions; plain
`o.x = 5;` and `a[i] = 5;` at top level.

Value-position twins (`const v = (o.x += 1)`, `return x++`) are ALL rejected
too (`expr-binary-op-+=`, `expr-unhandled:PostfixUnaryExpression`,
`expr-prefix-op-++`) — there is NO expression-position mutating lowering to
reuse; that is a separate follow-up, out of this issue's scope.

### Gate sites (read 2026-08-28)

- `src/ir/select.ts:3574` — top-level compound arm `ts.isIdentifier(s.expression.left)` (identifier-only).
- `src/ir/select.ts:3604-3611` — top-level catch-all labeling the three buckets; no top-level arm for incdec/local plain assign/property compound.
- `src/ir/select.ts:4804` — body-buffer compound arm, identifier-only; falls to `body-exprstmt-other` at 4845.
- `src/ir/select.ts:4826` — body-buffer incdec arm `if (!ts.isIdentifier(...operand)) return false;`.
- `src/ir/from-ast.ts:1720` — `lowerIdentifierAssignment` already wired in `lowerStatementList`; `lowerIncrementDecrement` exists at 11050 but is not wired top-level.
- Compound op map lives in `lowerCompoundAssignment` (from-ast.ts:11009-11028, f64-only per 10977); property read emitters at 5182/5214; element read/store at 5593/5668/5712-5720/5842.

## Implementation Plan

**Fable lane, 2026-08-28.** Implemented by an Opus subagent, slice-by-slice;
each sub-slice ships its selector arm + lowering arm ATOMICALLY in BOTH
statement walkers (`isPhase1StatementListInScope` ~select.ts:3565-3612,
`isPhase1BodyStatement` ~4731-4845) and BOTH dispatchers (`lowerStatementList`
~from-ast.ts:1741-1769, `lowerStmt` ~10277-10338), placed BEFORE the
discard/catch-all checks. Do NOT wrap via `lowerDiscardedExpression` — both its
call sites are guarded by `expressionStatementMutatesAtTopLevel` and its
fallthrough (`lowerExpr`) has no mutating arms.

### S0 (S) — top-level LOCAL plain assign + local incdec

Add the two top-level selector arms mirroring body-walker 4734-4753 /
4823-4838 (incl. `clearProjectionBinding` + class-binding bookkeeping); wire
`lowerIncrementDecrement` into `lowerStatementList`. Wins probes pE1, pA8.

### S1 (M) — property compound assign + property incdec, statement position

New `lowerPropertyCompound(lhs, op, rhs, cx)`:
1. `recv := lowerExpr(receiver)` ONCE (mirror 8594) — single evaluation;
2. `old := emitObjectGet/emitClassGet(recv, field, fieldType)` (5182/5214);
3. `rhsV := lowerExpr(rhs, fieldType)`;
4. binop via the op map FACTORED OUT of `lowerCompoundAssignment` (f64 fields only in this slice);
5. write via the FACTORED TAIL of `lowerPropertyAssignment` (`emitObjectSet` / `lowerCheckedClassFieldSet`; plain fields only — accessor-setter and extern receivers demote typed).

Emission order is receiver → READ → RHS → binop → WRITE (ES §13.15: the read
precedes RHS evaluation; plain `=` lowers recv→RHS with NO read, so factor the
write tail — do not reuse the `=` lowerers wholesale). Property `o.x++`/`++o.x`
statement position calls the same helper with a synthetic 1 (result discarded ⇒
prefix≡postfix, as the identifier comment at 10314-10319 notes).

### S2 (M) — element compound assign + element incdec

`lowerElementCompound`: recv once + idxI32 once (5593/5668 pattern) → element
read (path behind 5842 / bounds-checked provider) → rhs → binop → the factored
store tail (`emitVecSet` vs `__vec_elem_set` provider, 5712-5720). Restrict to
f64-elem non-dynamic non-TypedArray vecs; narrowed-i32 vecs demote (#3741).

### S3 (S-M) — chained assignment statements

Peel the `=`-chain; lower each target's receiver/index left-to-right (outer
first); lower the RHS ONCE to an SSA value v; emit writes inner→outer all using
v. Spec: the inner assignment's value IS the RHS value — NEVER re-read the
inner target (a normalizing setter would diverge). Identifier-only chains
first, then plain-field property chains; accessor targets stay out.

### Ordering/soundness constraints

- Receiver and index lowered exactly once to SSA ids reused for read AND write.
- Cross-pass safety rests on effects.ts (get=readsHeap, call=read+write,
  set=writesHeap) plus the read→binop→set data chain. UNVERIFIED assumption
  (check first in S1, cheap): no IR pass reorders a readsHeap instr across a
  writesHeap/call instr — read passes/dead-code.ts and nested-stackification.ts;
  the `o.x += f(o)` equivalence test is the empirical backstop.
- Selector⇄builder parity: an arm admitted in select.ts but unmatched in BOTH
  from-ast dispatchers lands on demoteToLegacy 1769/10338 as build-stage
  `body-shape-rejected` — or an untyped throw hard-errors (#3341/#3519).
- Type restrictions inherit from `lowerCompoundAssignment` (f64-only): string
  fields, dynamic/extern receivers (call-like get/set per effects.ts:159-179)
  demote TYPED in S1, never approximated.
- A partial lift that SHIFTS rejections into `compound-assign-unsupported`
  build-stage demotes could grow that postClaim bucket and fail
  `check:ir-fallbacks` — run it locally per slice.

## Acceptance criteria

1. Per slice: the slice's FALLBACK lines disappear from the probe set
   (`.tmp/stmtmut-*.ts`) and no new bucket appears; controls keep claiming.
2. `compile({trackIrOutcomes:true})` shows kind:emitted, irBodyEmitted:true for
   each lifted shape.
3. Equivalence tests (add to tests/equivalence.test.ts): `o.x += f(o)` where f
   mutates o.x (write must be oldRead+rhs); `a[g()] += h()` (recv/idx/read/rhs
   order, each called once); `o.x++;` vs `++o.x;` statement position identical;
   chained `a = b = e()` with side-effecting e (evaluated once, both targets get
   its value); out-of-bounds `a[i] += 1` matches legacy hole/provider semantics.
4. `pnpm run check:ir-fallbacks` — unintended-bucket decrease banks via
   `--update-on-decrease`; growth anywhere fails.
5. Ratchet gates chained bare before every commit; no local test262 (CI
   merge_group diff is the conformance gate).
