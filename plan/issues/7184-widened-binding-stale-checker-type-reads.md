---
id: 7184
title: "Reads of a widened binding still use the initializer's checker type"
status: ready
sprint: current
created: 2026-10-28
updated: 2026-10-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
parent: 4495
related: [4495, 4204, 4206]
---

# #7184 — Reads of a widened binding still use the initializer's checker type

Residual A of [#4495](4495-string-slot-widening-dynamic-assignment.md).

## Problem

#4495 widens a binding's slot to `externref` when a reaching write stores a
value of another type. TypeScript still types the binding from its
initializer, so a read that takes its lowering from that checker type treats
the dynamic value as the stale primitive. #4495 fixed member reads, method
calls and element reads (`memberReceiverStaticType`,
`methodReceiverStaticType`, `receiverStaticJsType` in
`src/codegen/declarations/heterogeneous-scalar-var-widening.ts`) and `typeof`.
These reads are still wrong (measured on PR #6954, both lanes, node as oracle;
`id` is `function id(x) { return x; }`):

| Program | node | module | function |
| --- | --- | --- | --- |
| `var r='r'; r=id(1); '' + (r == 1)` | `true` | illegal cast | illegal cast |
| `var r='r'; r=id(1); var s=r; '' + s` | `1` | null deref | null deref |
| `function g(a){return ''+a} var r='r'; r=id(1); g(r)` | `1` | wrong | right |
| `var r='r'; var h=function(){return r}; r=id(1); '' + h()` | `1` | right | wrong |
| `var r='r'; r=id(1); function g(){return r} ''+g()` | `1` | wrong | wrong |

- **Loose equality** lowers `r == 1` through `__str_to_number(r)`.
- **An initializer** `var s = r` gives `s` the slot of `r`'s checker type.
- **A call argument** is coerced to the parameter type inferred from the stale type.
- **A closure return** over a captured, widened function local keeps the
  checker's `string` result type. The module twin is fixed by
  `widenClosureReturnForDynamicModuleBinding`, but only for a function
  *expression*. A hoisted function *declaration* is wrong at module scope too,
  on base and head (round-3 review, nit 2), so that helper does not reach
  declarations. The local has no declaration-keyed verdict that another
  function's codegen can reach.

## Implementation Plan (sketch)

- **Where.** The guard `slotIsDynamicButStaticallyPrimitive` in
  `heterogeneous-scalar-var-widening.ts` already answers "is this read's
  checker type stale". Each consumer swaps one checker query for the guarded
  helper, as `compilePropertyAccess` and `compileReceiverMethodCall` do:
  - loose equality (`binary-ops.ts`, beside the strict-eq twin at `:1634`);
  - the initializer's slot type (`statements/variables.ts`);
  - call-argument coercion;
  - the closure return ABI.
- **Closure return.** It needs the mixed-assignment carrier verdict keyed by
  declaration, so another function's codegen can read it. Extend
  `widenClosureReturnForDynamicModuleBinding` to it rather than adding a twin.
- **Reuse.** No new predicate: every site uses the existing guard.
- **Placement (round-3 review, nit 4).** `memberReceiverStaticType`,
  `methodReceiverStaticType` and `receiverStaticJsType` are read-side receiver
  typing, but they sit in the declaration-side
  `declarations/heterogeneous-scalar-var-widening.ts`. Move them to
  `codegen/widened-receiver-type.ts` beside their consumers as this issue
  extends them. Route their `getTypeAtLocation` / `getAnyType` through the
  oracle where it can answer.
- **Acceptance.**
  - Each row is right on 4/4 cells (standalone and gc, module and function).
  - The playground corpus stays byte-identical.
  - **Quality:** each call site is a one-line swap, and the logic lives beside the guard.
