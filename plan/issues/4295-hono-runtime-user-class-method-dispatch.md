---
id: 4295
title: "codegen: dispatch untyped user-class methods by runtime identity"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, methods, dynamic-dispatch, spread
goal: dogfood
related: [1244, 4286, 4294]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  - src/codegen/closed-method-dispatch.ts::reserveClosedMethodDispatch
  - src/codegen/closed-method-dispatch.ts::reserveClosedMethodDispatchVararg
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/calls-closures.ts::sourceDefinesFunctionMember
---

# codegen: dispatch untyped user-class methods by runtime identity

## Problem

For an `any`/unannotated receiver, method lowering scanned source classes and
selected the first class containing the requested method name. That choice was
declaration-order dependent: Hono's `app.router.add(...)` could run a different
router's private-field body against the selected router object. The JS-host
lane also lacked the closed user-method dispatcher's host argument-array
fallback, including the single dynamic spread form used for route tuples.

Do not infer a nominal class without structural type evidence. When source user
classes own the method, dispatch by the receiver's runtime class and fall back
to the host method bridge with the original arguments.

## Acceptance criteria

- [x] Two unrelated classes with the same method name select the receiver's
      actual class, independent of declaration order.
- [x] A dynamic spread vector reaches the runtime-selected method intact.
- [x] Hono invokes the selected router's `add` method rather than another
      router's private-field implementation.
- [ ] Subclass overrides win when their declared arity differs from the base
      method under both under- and over-application.
- [ ] Source class rest methods pack fixed and trailing arguments in fixed and
      dynamic-spread dispatch.
- [x] Existing closed method-dispatch and dynamic method suites pass.

## Result

Property-less `any`/unknown receivers no longer drive static class selection.
For a method whose concrete source candidates all share one fixed non-rest ABI,
the host lane reserves the runtime class ladder and builds a real JS argument
array for fallback calls. Fixed and single-spread reductions return the Node
values, and Hono advances from mis-dispatch to its next nested route-tuple
carrier defect. Different-arity overrides and class rest methods deliberately
remain outside that fast path until their dispatchers can apply full JS arity
semantics rather than silently selecting a matching base method.
