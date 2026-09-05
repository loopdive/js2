---
id: 4697
title: "ES2015 object-literal method arguments with trailing-comma calls"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
es_edition: es2015
language_feature: arguments-object
task_type: bug
area: codegen
related: [4695, 2704, 2725]
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #4697 — ES2015 method arguments and trailing-comma calls

## Scope

This bounded slice owns exactly these five current-main Test262 rows:

- `test262/test/language/arguments-object/meth-args-trailing-comma-undefined.js`
- `test262/test/language/arguments-object/meth-args-trailing-comma-null.js`
- `test262/test/language/arguments-object/meth-args-trailing-comma-single-args.js`
- `test262/test/language/arguments-object/meth-args-trailing-comma-multiple.js`
- `test262/test/language/arguments-object/meth-args-trailing-comma-spread-operator.js`

Generator, async, class, private-method, host-import, and mapped descriptor
rows remain out of scope. The mapped descriptor work in #4695 is not part of
this change.

## Current baseline (upstream/main `028eb69ae`)

The exact five rows all compile and fail at runtime (`0/5` pass). Each method's
assertions do not contribute the expected `callCount`; the final assertion
reports `Expected SameValue(«0», «1»)`. The failures reproduce through the
authoritative `runTest262File` original-harness path, including its strict
rerun. Controls already pass: class-method null, class-expression-method null,
function-declaration null, and function-expression null trailing-comma rows.

## Root-cause implementation plan

Trace the object-literal `MethodDeclaration` lowering in
`src/codegen/literals.ts` and the receiver-method dispatch in
`src/codegen/expressions/call-receiver-method.ts` /
`src/codegen/expressions/object-method-rest-abi.ts`. The baseline WAT shows the
method body forked to a per-literal function because harness and test literals
share a deduplicated struct shape, while the direct `obj.method(...)` arm
re-looked up the shared, empty placeholder in `funcMap`. Record each method
declaration's actual function handle, recover a single-assignment `var` object
initializer for the direct-call proof, and preserve the selected handle through
the existing argument-count/extras setup and late re-lookup. Preserve
left-to-right evaluation, receiver binding, spread expansion, and the existing
class/function paths.

Add a focused regression test only if an existing equivalence test cannot assert
the five shapes; do not alter Test262 sources. Keep all compiler-source changes
under **180 changed source LOC**.

## Controls

- Plain object-method call without a trailing comma, with and without an
  `arguments` read, to ensure the fix is not comma-only dead-code.
- Existing class-method, class-expression-method, function-declaration, and
  function-expression trailing-comma rows above (all baseline pass).
- The five exact rows in both normal and strict original-harness variants.
- A spread control without a trailing comma and a non-method direct call to
  guard spread expansion and generic closure dispatch.

## Acceptance

- All five exact rows pass through `runTest262File` on host/gc, including the
  strict rerun where applicable.
- Controls remain passing with no new compile errors, traps, or wrong values.
- No source edits touch generator/async/class/private-method/host-import or
  mapped-descriptor paths.
- `git diff --stat` reports no more than 180 changed source LOC; focused
  TypeScript/equivalence checks and the normal pre-push checks pass.

## Test Results

- Baseline on upstream/main: exact rows `0/5` pass; controls `4/4` pass.
- After fix: exact rows `5/5` pass through `runTest262File` (host/gc original
  harness, including strict reruns); controls remain `4/4` pass.
- Source diff: 32 changed lines across five compiler files, under the 180-line
  cap.
- `tsc --noEmit`: pass; TypeScript 7 `tsc --noEmit -p tsconfig.ts7.json`: pass.
- Prettier check on changed files: pass.
