---
id: 7121
title: "CE: `v instanceof F` with a parameter `F` shadowing a top-level `function F` mutates a sealed prepared scope"
status: done
completed: 2026-10-22
created: 2026-10-22
sprint: current
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: crash-free
related: [7106, 7120]
# 2026-10-22: one shadow-gate call ahead of the name-keyed instanceof arms (logic lives in expressions/instanceof-shadowed-rhs.ts)
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions.ts
# 2026-10-22: same gate call inside the two instanceof dispatchers
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileHostInstanceOf
  - src/codegen/expressions.ts::compileExpressionInner
---

# CE: `instanceof` on a parameter that shadows a top-level function constructor

## Reproduction (measured 2026-10-22 on main 8b707ede0f)

```ts
function F() {}
export function probe(v: any, F: any) {
  return v instanceof F;
}
```

Compile fails on `--target standalone` and on the default gc target:

```
Codegen error: ABI draft ir-binding:v1:support:ir-unit%3Av1%3Air-source…:top-level-function:0000000000000000:function-value-trampoline:0000000000000000
would mutate sealed prepared scope prepared-component:ir-unit:v1:ir-source…:root:top-level-function:0000000000000000
```

- `probe` itself is refused by IR selection (`body-shape-rejected`), and the
  top-level `F` ships an IR body. The failure comes while legacy compiles
  `probe`.
- A plain read of the same shadowing parameter (`return F;`) compiles.
- So the trigger is the `instanceof` right operand: a function-value
  trampoline is drafted for the TOP-LEVEL `F`, although the occurrence binds
  the parameter, after `F`'s prepared scope was sealed.

Found while building the #7106 `dyn.instanceof` arm (#6848), whose refusal
test uses a top-level `var F` instead of `function F` because of this. It is
identical without that change, and on the #6847 stack base.

## Likely cause (to confirm)

Legacy's `instanceof` dispatch keys the right operand by its NAME (`ctorName
= expr.right.text`). The fnctor arm (`tryEmitNativeUserCtorInstanceOf`, or the
function-object value path behind it) then resolves `F` as the top-level
function constructor, ignoring that the identifier binds the parameter. The
draft is the symptom; the name-keyed lookup is the bug. A shadowed name must
reach `emitDynamicInstanceOf`, the generic runtime operator.

## Acceptance criteria

- The reproduction compiles on standalone and default gc, and
  `probe(new F(), F)` / `probe({}, F)` answer as node.
- The top-level-`F` arms still apply when the identifier really binds the
  top-level function.

## Resolution (2026-10-22)

Confirmed: the cause was the name-keyed dispatch. Stack of the CE:
`tryEmitNativeUserCtorInstanceOf` → `emitFnctorProtoGet` →
`ensureFuncClosureSingleton` observes `F`'s function-value trampoline while
legacy compiles `probe`; `ProgramAbiSourceCallableRegistry.planRetained` then
plans it into the sealed scope of the IR-compiled top-level `F`.

It was a silent miscompile too, not only a CE: where the module did compile,
`probe([], Array)` and `probe([], Object)` answered `false` (score `1` vs
node's `10101`), because the shadowed name was answered as the top-level `F`.

Fix: `src/codegen/expressions/instanceof-shadowed-rhs.ts`
(`instanceofRhsShadowsModuleName`). An `instanceof` RHS identifier whose
checker declaration is a parameter, catch variable or function-local
`var`/`let`/`const`, and whose name also names a module-level declaration or
a builtin global, skips every name-keyed arm (`resolveInstanceOfRHS` in
`expressions.ts`, and the arms of `compileHostInstanceOf`) and goes to
`emitDynamicInstanceOf`, which reads the binding's value.

Left out on purpose: function-local `class`/`function` declarations that
shadow a module-level name (the name tables register those by their own
name); and a CLASS value reaching the generic operator answers `false` on
every lane even unshadowed (`function probe(v, C) { return v instanceof C }`
with `probe(new A(), A)`), which is a separate gap in the dynamic path.

Test: `tests/issue-7121-instanceof-shadowed-ctor-name.test.ts`, standalone and
default gc, with and without `experimentalIR`, compared to node.
