---
id: 4371
title: "Dynamic class-object reads expose throwing placeholders for declared static methods"
status: done
sprint: 78
created: 2026-08-11
updated: 2026-08-18
completed: 2026-08-11
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, static-methods, dynamic-property-access
goal: npm-library-support
related: [1395, 3024, 3961, 3995]
loc-budget-allow:
  - src/codegen/expressions/extern.ts
  - src/codegen/index.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/runtime.ts::resolveImport
---

# Bridge declared static methods through dynamic class-object values

## Problem

React's original `ReactJSXTransformIntegration` suite carries a component class
through an element record and invokes a declared static method through the
record's dynamic `type` field:

```ts
class StaticMethodComponent {
  static someStaticMethod(): string { return "someReturnValue"; }
}
return createElement(StaticMethodComponent).type.someStaticMethod();
```

The direct `StaticMethodComponent.someStaticMethod()` path calls the compiled
Wasm function. The dynamic path materializes the class-object singleton, but
`__register_class_object` records only a CSV list of method names. The runtime
therefore exposes a descriptor-compatible placeholder JavaScript function whose
body deliberately throws. The compiled static method is present in the module,
but the dynamic class-object surface has no connection to it.

This is a generic class-value defect, not React-specific behavior. A static
method added later with `C.m = fn` already works because it is stored in the
sidecar; a static method declared in the class body must reach the same real
callable surface without changing the class object's Wasm identity.

## Acceptance criteria

- [x] A class carried through an `any`-typed object field can invoke its
      declared static method with zero or multiple arguments.
- [x] Reading the same declared static method as a value yields a callable
      backed by the compiled Wasm body, not a throwing placeholder.
- [x] Static-method descriptor flags remain writable, non-enumerable, and
      configurable, and existing delete/reassignment semantics remain intact.
- [x] Class objects retain their existing singleton and closed-struct identity;
      dynamic `new K()` and standalone no-host behavior do not regress.
- [x] React's original static-method integration test passes.

## Design

Keep the existing class-object singleton and name allowlist. In JS-host builds,
register each declared static method's real closure alongside the class object
when the singleton is first materialized. Store that closure in the class
object's descriptor-aware sidecar with normal class-method attributes. Host
property reads can then use the existing Wasm-closure wrapper and callback
dispatch rather than inventing a second static-call ABI or guessing an export
name. Standalone remains unchanged: it has no host registration imports and
already calls statically known class methods inside Wasm.

## Evidence

- `tests/issue-4371-dynamic-class-static-method-bridge.test.ts`: 3/3 pass.
- Adjacent class-object, reflection, dynamic-construction, and static-method
  regressions: 37/37 pass.
- React's original `ReactCreateElement` and
  `ReactJSXTransformIntegration` static-method tests both pass against compiled
  Wasm. The third matching `ReactJSXRuntime` test remains native-harness
  incompatible because that harness does not yet provide `ReactJSXRuntime`;
  it is not a compiled-runtime divergence.
