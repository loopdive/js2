---
horizon: m
id: 3657
title: "IR: ambient boolean host call rejected in ESLint Linter class method"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir, host-interop
language_feature: ambient-functions
goal: npm-library-support
sprint: current
es_edition: ES2015
related: [1371, 2693, 2781, 3325, 3518, 3653]
---

# #3657 — IR ambient host call with a boolean result

## Problem

The real-`espree`/real-`esquery` host-delegation seam in
`tests/issue-2693-host-delegated-select.test.ts` contains:

```ts
declare function __host_is_statement(code: string): boolean;

class Linter {
  verify(code: string): string {
    if (__host_is_statement(code)) {
      // rule logic
    }
    return "";
  }
}
```

When the test is allowed to execute (its path-vacuity defect is #3653), current
`origin/main` fails before Wasm:

```text
Codegen error: IR path failed for Linter_verify:
ir/from-ast: call to unknown function "__host_is_statement"
in Linter_verify [IR-FALLBACK]
```

The simpler #2693 demo still passes with ambient imports returning numbers and
strings. #3325 also proves runtime dependency wiring for ambient functions.
This issue is the IR call-graph/lowering gap before that runtime path.

## Scope

- Recognize a referenced ambient `declare function` as a typed external/host
  call when lowering a class method.
- Preserve its declared parameter and boolean result types.
- Record the host capability in the prepared import manifest before lowering.
- Keep unknown undeclared functions fatal; this is not a general
  string-whitelist escape hatch.

## Acceptance criteria

- A reduced class-method fixture calling
  `declare function predicate(s: string): boolean` compiles and validates.
- Injected host predicates returning true and false both produce the expected
  Wasm-visible branch result.
- Missing dependencies retain the documented #3325 behavior; this issue does
  not silently invent a predicate result.
- `tests/issue-2693-host-delegated-select.test.ts`, after #3653, loads real
  `espree`/`esquery`, compiles, instantiates, and passes its four runtime cases.
- Numeric/string ambient-call fixtures from #2693 and #3325 remain green.

## Implementation (2026-07-26)

- Added one checker-backed resolver for exact, fixed-arity primitive calls from
  top-level class members to same-file user `declare function` stubs. Symbol
  identity, rather than callee text, distinguishes the ambient declaration from
  shadows, imports, lib globals, and unknown functions.
- Recorded each certified call as an exact AST-node lowering plan. The class
  member IR builder reuses the existing typed direct-call lowering only for
  those planned nodes.
- Added a final-context preflight that proves declaration collection produced
  the matching `env` function import with the planned parameter/result ABI
  before the class member is lowered.
- Converted the real espree/esquery seam from `it.fails` to an ordinary Node
  JS-host test and routed its four host functions through `buildImports`.

## Verification (2026-07-26)

- `tests/issue-3657.test.ts` proves genuine `Gate_check` IR emission, validates
  the module/import manifest, exercises true and false predicate results, and
  pins the #3325 missing-dependency no-op behavior.
- The real espree/esquery test compiles, instantiates, and passes all four
  semicolon-rule cases. After the ambient calls clear this issue's prior
  unknown-call invariant, its mixed string/number message assembly takes the
  existing #2781 safe legacy demotion; that fallback is not a compile blocker.
- The numeric/string #2693 demo and all six #3325 ambient dependency tests
  remain green.
- `pnpm run typecheck` and `pnpm run check:ir-fallbacks` pass.
