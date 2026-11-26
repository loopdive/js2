---
id: 7462
title: "Prepared path: a closure that writes a script var aborts; `new X` as a direct `+` operand refuses"
status: in-progress
created: 2026-11-23
updated: 2026-11-26
priority: medium
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7462 — Prepared path: a closure that writes a script var aborts; `new X` as a direct `+` operand refuses

## Problem

Two shapes found during #7354 G1, both present on main: (1) a closure that writes a script-level `var` (`var n = 0; var f = function(){ n++; }; f();`) ends in the run-time abort ("nondefaultable reference widening"); (2) a `new` expression used directly as an operand of `+` (`"" + new TypeError("m")`) refuses, although the same value through a variable works.

## Acceptance criteria

- Both programs give node's answer.
- Each with a wrong twin that fails.

## Implementation Plan

Measured 2026-11-26 on main `6694a8b8391`, strict Prepared entry (`prepared-program-required`, `standalone`,
`wasmgc`), each program run against `node`. Probes: `.tmp/probe-7462*.mts` (not committed).

### Gap 1 — a write to a script var from inside a function

**Reproduction.** Both gaps reproduce. Gap 1 does not show the message the issue names: "nondefaultable reference
widening" did not appear. The program compiles and validates; the closure body becomes an abort body (#7354 U), and
`__module_init` traps `RuntimeError: unreachable`. node returns in every row.

| Program (each then `if (n !== 1) throw 1;`)                         | Result on main                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `var n = 0; var f = function(){ n++; }; f();`                       | abort body `ir/from-ast: increment/decrement of undeclared "n" in <module-init>__closure_0` |
| `var n = 0; var f = function(){ n += 1; }; f();`                    | abort body `ir/from-ast: compound assign to undeclared identifier "n" in <module-init>__closure_0` |
| `… for (var i = 0; i < 3; i++) n++; …` in the closure                | same `increment/decrement of undeclared "n"`                                              |
| `var n = 0; function g(){ n++; return; } g();`                      | abort body `increment/decrement of undeclared "n" in g`                                   |
| `var n = 0; function g(){ n += 1; } g();`                           | abort body `compound assign to undeclared identifier "n" in g`                            |
| `var n = 0; function g(){ n++; } g();`                              | abort body `ir/from-ast: unsupported expression kind PostfixUnaryExpression in g` (gap 1b) |
| `function g(){ var i = 0; i++; } g();` (a local, no script var)     | same `unsupported expression kind PostfixUnaryExpression in g` (gap 1b)                   |
| `n = n + 1`, `n = 1` in the closure; `n = n + 1` in `g`; a closure reading `n` | **pass**                                                                       |
| `var n = "5"; n++;` and `var n = 0; n += 2;` at top level            | **pass** (module-init has `n` in scope as `moduleGlobal`)                                 |

**Root cause (1a).** A function nested in module-init or declared at top level does not have the script's `var` in
`cx.scope`. A read falls back to the resolver: `classifyIdentifierRead` → `resolveModuleBinding`
(`src/ir/identifier-read.ts:58`). A plain write falls back as well: `lowerIdentifierAssignment` resolves the binding
readable, then writable, checks the owner, then checks TDZ (`src/ir/from-ast.ts:13218-13243`). The two update writers
look only at the scope and stop on a miss:

- `lowerCompoundAssignment`, `src/ir/from-ast.ts:13343-13349`;
- `lowerIncrementDecrement`, `src/ir/from-ast.ts:13519-13525`.

Both already lower `moduleGlobal` storage: global get, number or dynamic arm, global set. The missing piece is
resolving that storage, nothing else. These two functions also share a scope / captured-cell / `storage` prologue
that is copied word for word (`13343-13353` and `13519-13530`).

**Root cause (1b).** In a void function, a trailing `x++;` takes `lowerTail`'s void expression-statement arm
(`src/ir/from-ast.ts:2826-2870`). That arm has its own branches for a call, `id =`, `o.p =` and `a[i] =`, then calls
`lowerDiscardedExpression` → `lowerExpr`, which has no update-expression arm
(`unsupported expression kind`, `src/ir/from-ast.ts:5389`). The mid-body walkers call
`lowerAdoptedMutatingStatement` (`2467`, `12696`); the void tail does not. The dynamic-return tail already reuses
the mid-body path (`2815-2820`). The closure in 1a has a dynamic result, which is why only function declarations hit 1b.

**Change.**

1. New `src/ir/identifier-write.ts`, the write twin of `identifier-read.ts`: one pure function
   `classifyIdentifierWrite(id, writeValue, cx)` returning one of:
   - `{ kind: "scope", binding }`;
   - `{ kind: "module-binding", binding }`: resolved readable, then writable with `writeValue`, with
     `requireMatchingModuleBindingOwner` (`src/ir/ast-lowering-plans.ts:467`) applied;
   - `{ kind: "unresolved" }`.

   It emits nothing.
2. `src/ir/from-ast.ts`. All three identifier writers ask `classifyIdentifierWrite`:
   - `lowerIdentifierAssignment` replaces its inline readable/writable/owner sequence and passes `rhs`, as today.
   - `lowerCompoundAssignment` and `lowerIncrementDecrement` share one storage prologue in place of the duplicated
     one. A `module-binding` answer becomes `{ kind: "moduleGlobal", globalRef, type }` storage. The TDZ check
     (`lowerResolvedModuleBindingTdzCheck`, `4889`) is emitted before the old value is read (GetValue comes first;
     the assignment keeps its check after the RHS). The write value is the update expression itself (`id.parent`).
     Its checker type is the stored value's type, so the Prepared resolver's mutability check
     (`src/ir/program-source-units.ts:107`) and the ordinary resolver's representation proof both get the right
     question. With no write value, `const n` would be accepted.
3. `lowerTail`'s void expression-statement arm: call `lowerAdoptedMutatingStatement(stmt.expression, cx)`
   immediately before its final `lowerDiscardedExpression`, then terminate. Put the call **after** the three `=`
   arms: the ordinary pipeline claims the chain tail `a = b = 1` (measured: `ir=["g"]`), and moving the chain into the
   adopted arm's `lowerBinary` would change its bytes. The ordinary pipeline does not claim the shapes the new arm
   reaches, a void-tail `i++` and `o.x += 1` (measured: `ir=[]`).

**Leave it better.** The moduleGlobal / slot / cell read-and-write triplet appears about eight times in these two
functions. Fold it into `readStorage` / `writeStorage` next to the prologue if gc bytes stay identical. Otherwise file
the cleanup as a follow-up and link it.

### Gap 2 — `new X(…)` directly as a `+` operand

**Reproduction.** These refuse at compile (`success=false`) with
`ir/from-ast: '+' operands not provably both-number or string-concatenable (string/unprovable) — the unboxed numeric-add / string-concat fast path is unsound here; demote to the SAFE dynamic '+' (emitAnyAdd) in <module-init>`:

- `"" + new TypeError("m")`;
- `new TypeError("m") + ""` (the message reads `unprovable/string`);
- `"" + new Error("m")`;
- `function C(){} "" + new C()`.

Through a variable they pass: `var e = new TypeError("m"); "" + e` and `var c = new C(); "" + c`.

**Root cause.** `provenAdditiveOperands` (`src/ir/from-ast.ts:14395-14409`) asks `additiveOperandProof` (`14427`) →
`addsAsCarrier` → `expressionProducesDynamic` → `producesCarrier(expr, dynamicLeaves(cx))` (`14862-14891`). The
leaves in `yieldsCarrier` (`src/ir/analysis/carrier-expression.ts:52-70`) cover identifiers, member reads, calls and
`+`. They have no case for `new`, so the operand falls to the checker. The checker types it as an object, which is
`unprovable`. The lowering itself already produces the carrier. `lowerNewExpression` sends a callee that is a dynamic
binding, or a realm intrinsic such as `TypeError` (`bindingHoldsDynamic` → `readsDynamicGlobal`,
`src/ir/function-object-lowering.ts:363-368`), or a top-level function value such as `C`, to `lowerDynamicConstruct`.
That emits `dyn.construct`, whose result is dynamic (`src/ir/from-ast.ts:8445-8450`). The variable form works because
the variable's home is the carrier. The predicate and the lowering disagree about `new`. Gap 2 and gap 1 do not share
a cause.

**Change.**

1. `src/ir/from-ast.ts`: lift the condition at `8447-8449` into one predicate, `constructsDynamic(expr, cx)`:
   `ts.isIdentifier(expr.expression)` and (`bindingHoldsDynamic` or a top-level function value with no scope
   binding). `lowerNewExpression` uses it in place of the inline condition. `dynamicLeaves` answers the new leaf with
   it.
2. `src/ir/analysis/carrier-expression.ts`: add one optional `construct?: (expression: ts.NewExpression) => boolean`
   to `CarrierLeaves`, next to `call`. `leaf()` answers `ts.isNewExpression(e) && leaves.construct?.(e) === true`.
   The selector's leaves (`select.ts:6494`, `select-object-statics.ts`) leave it unset, so selection does not change.

Earlier arms in `lowerNewExpression` win over `dyn.construct`: Promise delay, open carrier, primitive wrapper, Map,
static RegExp. Each keys on an ambient name that `bindingHoldsDynamic` does not answer for. A primitive wrapper is
already `addsAsCarrier`.

### Tests — `tests/issue-7462-prepared-script-var-writes.test.ts`

Reuse `runPrepared` / `abortBodies` / `yieldToRpc` from `tests/helpers/prepared-node-agreement.ts`; do not copy a
`run()`. Each program runs twice: once with node's answer, which must return, and once with a wrong answer, which
must throw. Also check `node(right) === "returned"`.

- Gap 1a, in a closure:
  - `n++`, `n--`, `++n`, `n += 1`, `n -= 2`;
  - `n++` in a `for` loop (3);
  - `var n = "5"` then `n++` (6: ToNumber of the carrier);
  - `var s = "a"` then `s += "b"` (the dynamic `+=` arm).
- Gap 1a, in `function g`: `n++; return;` and `n += 1`.
- Gap 1b: `function g(){ n++; }` and `function g(){ n -= 1; }` with a script `n`; `function g(o){ o.k++; }` if the
  member arm is admitted on this lane, otherwise leave it out.
- Gap 2:
  - `"" + new TypeError("m")` = `"TypeError: m"`, and the same with `new` on the left;
  - `"" + new Error("m")`;
  - `function C(){}` then `"" + new C()` = `"[object Object]"`;
  - the wrong twin of each.
- Still not handled, each pinned by its name so the slice that admits it updates the list:
  - `var f = function(){ var r = n++; return r; }`: abort body `unsupported expression kind PostfixUnaryExpression`
    (an update used as a value is a separate gap);
  - `var f = function(){ function h(){ n++; } h(); }`: abort body `nested func must have a return type annotation`;
  - `let n = 0; var f = function(){ n++; }`: refuses with `runtime callable __new_ReferenceError needs runtime function
    materialization` (the TDZ guard, the same refusal `n = n + 1` already gets on main);
  - `const n = 0; var f = function(){ n++; }`: abort body `write to immutable module binding n`, next to the checker's
    `Cannot assign to 'n'` diagnostic. This proves the update passes a write value.
- Rerun `tests/issue-7354-*.test.ts`, `tests/test262-prepared-*.test.ts` and `tests/issue-7338*.test.ts` (the carrier
  predicate).

### Risks

- **Ordinary-pipeline bytes must stay identical.** All three changes live in `from-ast.ts`, which both pipelines
  share. They are reached only where the ordinary selector claims nothing. It refuses `module-update` and
  `tail-module-compound` (`src/ir/select.ts:4614`, `6598`), and it claims none of the gap programs; measured:
  `irCompiledFuncs` holds no `g` or `h` and no module-init. The `construct` leaf does make
  `expressionProducesDynamic` true for `new <dynamic callee>` in claimed ordinary units on a native-dynamic lane, if
  any exist. Gate: compare sha256 of the gc and standalone binaries before and after on the equivalence corpus plus
  `website/playground/examples/`, using `.tmp/base.ts` copies captured at the first edit. Any difference in bytes is a
  blocker to explain or remove.
- **Size budgets.** `src/ir/from-ast.ts` sits exactly at its LOC ceiling (17,340 lines, `scripts/loc-budget-baseline.json`).
  The change must be net ≤ 0 lines there: moving the resolution sequence out and folding the duplicated prologue pays
  for the new code. `lowerTail` is 274 lines against a 300 threshold. No `loc-budget-allow` or `func-budget-allow`.
- `const`, and `let` TDZ, are pinned above, so a lost write value or TDZ check is caught.

### Code-quality acceptance criterion

- One write-resolution authority, `identifier-write.ts`, beside `identifier-read.ts` and in the same shape.
  `lowerIdentifierAssignment`, `lowerCompoundAssignment` and `lowerIncrementDecrement` all use it. No second copy of
  the readable → writable → owner sequence remains, and the duplicated update prologue is gone.
- One `constructsDynamic` predicate, shared by `lowerNewExpression` and `dynamicLeaves`. One `construct` leaf, placed
  beside `call`. No `+`-specific special case.
- The void tail reuses `lowerAdoptedMutatingStatement`; it gets no new arm of its own.
- No new demote label, no defensive branch, `from-ast.ts` net ≤ 0 lines. A fresh-context adversarial review on the diff
  and this plan, with its verdict recorded in the PR body.
