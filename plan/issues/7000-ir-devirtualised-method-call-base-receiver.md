---
id: 7000
title: "ir: instance-method calls on a base-typed receiver are statically devirtualised to the declared class's method (`a: A` ⇒ `call $A_v`), so a subclass override is skipped — `callV(new B())` and `this.v()` inside `A.w` return A's result; legacy uses `__tag` virtual dispatch (#1299); verify skips `class.call` as resolver-typed"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: classes, inheritance, virtual-dispatch
goal: ir-full-coverage
related: [1299, 3522, 7001]
# 2026-10-15: audit finding; from-ast.ts / lower-generic.ts may need a dispatch arm.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/lower-generic.ts
---

# IR devirtualises method calls on base-typed receivers

Found by the 2026-10-15 audit (IR typing lane). IR-only; confirmed on standalone and gc with the IR path on (default).

## Repro (node → wasm)

```ts
class A { v(): number { return 1; } w(): number { return this.v() * 10; } }
class B extends A { v(): number { return 2; } }
function callV(a: A): number { return a.v(); }
export function test(): number { const b = new B(); return callV(b) + b.w(); }  // node 22, wasm 11
```
`experimentalIR: false` → 22. The getter variant (`a.g` overridden) is wrong in BOTH lanes (100 vs 200) — fix the IR half here, file the legacy getter half separately if it is a different site.

## Root cause

- `src/ir/from-ast.ts:9627-9651` resolves the method against the receiver's DECLARED class shape (`findClassMember(recvType.shape, …)`) and emits `builder.emitClassCall(recv, methodName, "method", args, method.returnType, method.target)` with a fixed `target`.
- `src/ir/lower-generic.ts:2186-2201` lowers `class.call` to a plain `call $<declaredClass>_<method>`. No `__tag` dispatch; legacy has `src/codegen/expressions/virtual-dispatch.ts` (#1299).
- `src/ir/runtime/verify.ts:1886` `TYPE_RULE_STATUS["class.call"]` is `skip: "resolver-typed"`, so verify cannot see it.

## Implementation Plan

1. Decide per call site whether devirtualisation is SOUND: it is, iff no class in the program that is a subtype of the declared receiver class overrides the method (or the method is `private`/the class is `final`-by-construction: no subclass exists). The class shape model (`classShapes` in `planIrOverlay`, `src/codegen/index.ts:2973+`, and `src/ir/select.ts` class-member gates) already knows the inheritance graph; add `overriddenInSubclass(shape, methodName)`.
2. If overridden: either (a) lower `class.call` to the SAME virtual dispatch the legacy lane emits (reuse `virtual-dispatch.ts`'s table/`__tag` switch as a `BackendEmitter` intent so WasmGC and linear get one implementation), or (b) have the selector REJECT the call shape with a new typed reason (`class-method-virtual`) so the function demotes to legacy — (b) is the quick, safe first step; (a) is the real fix. Land (b) first if (a) exceeds the horizon, and record the demote count on `tests/equivalence` in this file.
3. Also handle `this.v()` inside a base-class method (the receiver is `this: A` but may be a subclass instance) — same predicate.
4. Verify: register a `class.call` rule that at least checks the target function's declared receiver type is a supertype of the receiver value's static type (turns a future drift into a verify failure instead of wrong output).
5. Tests: the repro, the `this.v()` case, a 3-level chain (C extends B extends A, call through `A`), and a negative control (no override → still a direct call; assert via WAT that `call $A_v` remains).

## Acceptance

- Repro matches node on both lanes with IR on.
- `check:ir-fallbacks` unintended buckets do not grow (if you chose (b), update the baseline with `--update-on-decrease` only; growth needs a note here).
- `tests/equivalence/*class*`, `*inherit*` pass.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7000-ir-devirtualised-method-call-base-receiver.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
