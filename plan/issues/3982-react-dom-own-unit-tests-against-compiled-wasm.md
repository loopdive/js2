---
id: 3982
title: "Run react-dom's own unit tests against compiled react-dom"
status: backlog
sprint: current
created: 2026-08-01
updated: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: test
area: dogfood
language_feature: compiler-internals
goal: dogfood
related: [3958, 3977]
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/call-identifier.ts
  - src/runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/statements/variables.ts
  - src/codegen/index.ts
  - src/codegen/registry/imports.ts
  - src/codegen/closures.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/stack-balance.ts
  - src/codegen/context/types.ts
  - src/codegen/string-ops.ts
  - src/codegen/binary-ops.ts
  - src/codegen/array-methods.ts
  - src/compiler.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
  - src/codegen/extern-declarations.ts
func-budget-allow:
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/runtime.ts::resolveImport
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/runtime.ts::<anonymous>#78
  - src/codegen/index.ts::ensureStructForType
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/runtime.ts::_wrapForHost
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  - src/import-resolver.ts::preprocessImports
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/runtime.ts::_safeSet
---

# Run react-dom's own unit tests against compiled react-dom

## What was done

`tests/dogfood/react-dom-upstream-suite.mjs`, built on the #3958 React suite
rather than beside it: the test extractor (`react-upstream-extract.mjs`) and the
`expect` shim (`react-upstream-shim.mjs`) are reused verbatim, because
react-dom's tests are the same Jest + JSX + `describe`/`it` shape from the same
repository at the same commit. The suite reuses React's already-verified
checkout, so the two cannot drift onto different revisions of the same repo —
the setup asserts the shared tag and commit and fails loudly otherwise.

Three things genuinely differ, and each is why a separate harness exists:

1. **Two published CJS modules** make up the implementation — the shared entry
   plus the 536 KB client renderer — and each needs its OWN function scope.
   react and react-dom both declare a top-level `noop`, so a bare concatenation
   dies with `Duplicate identifier 'noop'` before a single test runs.
2. `require("react")` / `require("react-dom")` / `require("scheduler")` inside
   those modules are rewired to the in-module values, so what runs is the
   published implementation wired to the published implementation. `scheduler`
   is not in the react-dom tarball and is an empty object; anything that needs
   it fails identically on both sides.
3. The implementation is compiled **alone first** (the #3977 lit lesson).

**166 of 2003 upstream react-dom tests are currently admitted**. These are
original upstream tests whose scaffolding the shared extractor and jsdom-based
host can reproduce without React's private Jest module system.

## Suspended handoff (2026-08-03)

GitHub tracking issue: [#4075](https://github.com/loopdive/js2/issues/4075).

The initial parse blocker is fixed. React 19.2.6 plus the published ReactDOM
shared/client production modules now compile to a valid Wasm module (about
548 KB of source), and the harness can execute original upstream tests against
that module under jsdom.

The first admitted upstream test remains red:

```text
ReactDOM unknown attribute › unknown attributes › removes values null and undefined
native: pass
compiled Wasm: fail (expected "something", observed undefined)
```

### Exact remaining compiler blocker

React reaches `enqueueUpdate` with the HostRoot fiber, an initialized update
queue, and a non-null root. The generated body for `updateContainerImpl`,
however, omits the first side-effecting call in React's comma expression:

```js
null !== element &&
  (scheduleUpdateOnFiber(element, rootFiber, lane),
   entangleTransitions(element, rootFiber, lane));
```

`entangleTransitions` is emitted; `scheduleUpdateOnFiber` is replaced with a
dropped default value. This is not a SequenceExpression evaluator bug. The
callee belongs to a deferred capturing sibling cycle and has no registered
function/capture ABI when the ordinary caller is emitted.

Reserving that cycle before its first caller restores the scheduler call, but
then reveals the deeper ABI problem: `performSyncWorkOnRoot` supplies 108
capture arguments to a `flushPendingEffects` body whose final type requires
117 (`WebAssembly.compile(): not enough arguments on the stack for call`). At
reservation time the callee reports 107 capture parameters; after later
dependencies are emitted its final ABI grows. The next implementation needs a
dependency-aware prepare-before-emit phase that freezes the entire cycle's
capture ABI before any caller body is generated. Merely increasing the existing
32-round cycle loop does not solve the ordering problem.

This work is suspended at the user's request. The branch intentionally retains
the last valid-module state and does not commit the speculative early-cycle
reservation that creates invalid Wasm.

### Reproduction

```bash
DOGFOOD_REACT_DOM_ADMIT_ALL=0 \
DOGFOOD_REACT_DOM_TEST_LIMIT=1 \
pnpm run dogfood:react-dom-upstream-suite
```

## Acceptance criteria

- [x] The corpus is react-dom's own test sources at a verified commit shared
      with the react suite.
- [x] Original upstream tests are extracted and unsupported infrastructure is
      reported separately rather than replaced by invented tests.
- [x] `admitted + rejected == upstreamTestsSeen` is asserted.
- [x] The implementation is compiled alone and reported by name with the
      compiler's own message when it fails.
- [x] react-dom's published client module compiles to a valid Wasm module.
- [x] The native oracle and compiled lane run under the same jsdom host setup.
- [ ] Freeze deferred capture-cycle ABIs before compiling ordinary callers.
- [ ] Make the admitted upstream ReactDOM tests green against compiled Wasm.

## Permanent test reference

`tests/dogfood/react-dom-upstream-suite.test.ts` — pin/commit assertions run
always; the full run is gated behind `DOGFOOD_REACT_DOM_UPSTREAM=1`.

```bash
pnpm run dogfood:react-dom-upstream-suite
DOGFOOD_REACT_DOM_UPSTREAM=1 pnpm exec vitest run tests/dogfood/react-dom-upstream-suite.test.ts
```
