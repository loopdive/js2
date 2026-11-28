---
id: 7634
title: "Runtime-link probe: the stub parser's function ASTs lack the body span #7441 checks"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime-eval
goal: runtime-eval
related: [2928, 7441, 7632]
---

# #7634: the runtime-link probe's parser stub predates the #7441 span check

## Problem

Since #7441, `compileDynamicFunctionMeta` (`src/interp/dynamic-function.ts`) rejects a parsed function unless the
body span matches the source text:

```ts
if (!fitsFunctionSourceText(source, "anonymous", paramString, body.length, fnBody.start, fnBody.end)) {
  throw new SyntaxError("Function parameters or body do not parse on their own");
}
```

`tests/interp/runtime-function-link-probe.mjs` gives the provider a stub `parse`, which returns hand-built
`FunctionDeclaration` ASTs. Those ASTs have no `start`/`end` on the body block, so every dynamic `Function` in the
probe throws. The provider canary `providerCanary` throws on its own, without the user module.

Measured on main 28ca865e, with the user module made to compile (#7632 prototype), with the IR on and off: 11 of the
12 `executionErrors` in `tests/issue-2928-runtime-link.test.ts` come from this. The 12th is `aotThrowRoundTrip`
(#7633).

`tests/issue-2928.test.ts` passes, because its own copy of the mock sets the span by hand (`block.start = 25;
block.end = 41`). That leaves two mocks of the same parser contract: one hardcodes the offsets, and one forgot them.

## Implementation Plan

**Module.** A test-support module, `tests/interp/runtime-eval-parser-stub.mjs`, owns the one helper both mocks use.
It exports the TypeScript source text of a `withBodySpan(source, ast)` function, which the two provider sources splice
in next to their `parse`.

**Helper.** `withBodySpan` derives the span from the text it receives:
- `start` is `source.indexOf("{")`, because the stub sources' parameter lists contain no braces;
- `end` is `source.lastIndexOf("}") + 1`.

It does not restate `functionSourceBodyStart`'s formula, so the mock checks the real assembler rather than mirroring
it. It asserts that the parameter text contains no `{`, so a stub source that breaks that assumption fails loudly.

**Reuse / duplicate removed.**
- The probe's four function-AST returns go through the helper.
- `tests/issue-2928.test.ts` drops its hardcoded `25`/`41` for the same helper.

**Byte identity.** Test-only change: no `src/` file changes, so compiled output cannot change.

## Acceptance

- In `tests/issue-2928-runtime-link.test.ts`, the 11 dynamic-`Function` execution rows pass once #7632 lets the user
  module compile.
- `aotThrowRoundTrip` stays excluded, citing #7633.
- `tests/issue-2928.test.ts` still passes, with no hardcoded offsets.
- Code quality:
  - one helper, no copied formula;
  - both mocks use it.

## Note

Its own PR, landing after #7632 (plan review R3): it can only be shown green once #7632's compile fix is in,
because the probe's user module does not compile on main.
