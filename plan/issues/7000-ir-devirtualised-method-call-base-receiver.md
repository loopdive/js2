---
id: 7000
title: "ir: instance-method calls on a base-typed receiver are statically devirtualised to the declared class's method (`a: A` ⇒ `call $A_v`), so a subclass override is skipped — `callV(new B())` and `this.v()` inside `A.w` return A's result; legacy uses `__tag` virtual dispatch (#1299); verify skips `class.call` as resolver-typed"
status: done
completed: 2026-10-15
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
  # 2026-10-15 (impl, step b): the selector refusal (+helpers) and the
  # `class.call` target-identity verify rule.
  - src/ir/select.ts
  - src/ir/runtime/verify.ts
# 2026-10-15 (impl, step b): one `class-method-virtual` arm each in the
# instance-method and getter arms of `isPhase1Expr`, and the builder backstop
# call in `lowerMethodCall`.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/from-ast.ts::lowerMethodCall
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

## Implementation notes (2026-10-15)

**Shipped: step (b) (selector refusal) + backstop + step 4 (verify rule). Step (a) (real IR virtual dispatch) is NOT implemented — design below.**

- **Predicate** — `src/ir/class-overrides.ts` `staticMemberBindingIsUnsound(receiver, className, member, resolveVariable)`:
  syntactic, conservative scan of every class-like node in the source file
  (declarations, class expressions, nested classes) that transitively
  `extends` the receiver's class by binding name and declares an own instance
  member of that name (method, accessor, field, parameter property, or a
  computed name). A class with a non-identifier `extends` (`extends mix(A)`)
  counts for every class. **Exemption**: a receiver that is EXACTLY its static
  class — `new C()` or a `const` initialised with `new C()` of the same class
  — keeps the direct call (`const a: A = new B()` is NOT exempt).
- **Selector (step b)** — `isPhase1Expr` refuses with the new typed reason
  `class-method-virtual` on the instance-method arm, the class getter-read arm
  (accessor only — fields are own data properties and stay direct) and
  `preflightClassPropertyWrite` (setter). This covers `callV(a: A)` and
  `this.v()` inside `A.w` (step 3, same predicate). Callers of a refused unit
  follow the existing call-graph closure (`test` in the repro).
- **Builder backstop** — `from-ast` `demoteIfVirtualMember` before each
  `emitClassCall` (method / getter / setter) demotes a class-typed receiver
  the selector could not attribute. Measured: with the selector check
  disabled, the backstop alone gives the correct 22 under IR-first.
- **Verify (step 4)** — `TYPE_RULE_STATUS["class.call"]` is now `checked`: when
  the instr carries an exact `target` and the receiver is class-typed, the
  target must equal the target of the member resolved on the receiver's
  shape chain (same walk as `findClassMember`). A member the walk cannot see
  stays unjudged (no false positives on resolver-typed shapes).
- **Getter variant** — the IR now refuses `a.g` with an overridden getter, but
  the result is still 100 (node 200) because LEGACY has the same bug. Needs its
  own issue (legacy getter dispatch on a base-typed receiver).
- **Measurements**
  - Full `tests/equivalence` (8 shards, instrumented build that logged every
    `class-method-virtual` refusal/backstop hit): **0** sites — no equivalence
    program calls an overridden member through a base-typed receiver; no new
    equivalence regressions (the 22 failures are all baselined).
  - `check:ir-fallbacks`: unchanged (no unintended / post-claim growth; the
    playground corpus has no such site). `check:ir-only`: READY.
  - `tests/equivalence/issue-7000-ir-virtual-dispatch.test.ts`: repro, `this.v()`,
    3-level chain (override only on the grandchild), `const a: A = new B()`,
    exact-instance exemption, negative control (exported `callV` keeps
    `return_call` to `A_v`, no branch). 7/9 of the original rows fail on the base.
- **Known limit** — the scan is per source file; a subclass declared in ANOTHER
  module of a multi-file compile is not seen.
- `scripts/gen-ir-adoption.mjs` gained the bucket row and a post-claim
  capability-gap row for `class-method-virtual`; `plan/log/ir-adoption.md`
  regenerated.

### Remaining design — step (a): IR virtual dispatch

1. New IR instr (or a `dispatch: "virtual"` flag on `class.call`) carrying the
   ordered candidate list `{ classId, target }` for every class at or below the
   receiver class that declares the member, computed in from-ast from
   `cx.classShapes` (requires every overriding subclass to have a projected
   shape; otherwise keep demoting).
2. Lower through a `BackendEmitter` intent so WasmGC and linear share it:
   WasmGC = `struct.get $base 0` (`__tag`) + `br_table`/`if` cascade, each arm
   `ref.cast` to the candidate's struct and `call` its target; linear = the tag
   word at offset 0 and the same cascade. Reuse legacy's lessons from
   `src/codegen/expressions/virtual-dispatch.ts`: per-arm arity padding
   (#4644), result-type unification with `extern.convert_any` widening (#5178),
   pre-registered numeric boxing (#5352), and transactional bail-out.
3. Start with the narrow slice where every candidate has an identical IR
   signature (same params/result) — no unification needed — and keep the
   `class-method-virtual` refusal for the rest; then drop the selector arm for
   the lowered slice.
4. Getter/setter variants reuse the same instr with `memberKind`.
