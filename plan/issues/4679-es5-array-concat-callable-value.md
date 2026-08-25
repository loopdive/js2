---
id: 4679
title: "ES5 standalone Array.prototype.concat callable-value cluster"
status: done
created: 2026-08-25
updated: 2026-08-25
goal: standalone-gap
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/closure-exports.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/closure-exports.ts::emitClosureCallExportN
---
# Issue 4679: ES5 standalone Array.prototype.concat callable-value cluster

The native variadic closure ABI and exact intrinsic installation path make the
two residual ES5 concat rows executable without host imports.
