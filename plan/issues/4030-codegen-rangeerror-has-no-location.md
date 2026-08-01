---
horizon: s
id: 4030
title: "A RangeError escaping into the codegen catch is reported with no location"
status: ready
created: 2026-08-01
updated: 2026-08-01
assignee: unassigned
priority: medium
feasibility: easy
reasoning_effort: low
task_type: observability
area: codegen, observability
goal: npm-library-support
sprint: current
es_edition: n/a
related: [4019]
---

# #4030 — attach the throwing site to opaque codegen errors

## Problem

#4019 surfaced to the user as exactly this, and nothing else:

```text
Codegen error: Maximum call stack size exceeded
```

No file, no function, no frame. The generic `catch` in `generateMultiModule`
relabels any thrown `Error` with its `message` and discards the stack. For a
`RangeError` from unbounded recursion the message alone is useless: it names
neither the recursion nor the input that triggered it.

Localising it cost a full instrumented re-run of a ~9-minute compile with a
hand-patched `catch` — on a graph where each iteration is expensive.

## Why it matters beyond convenience

A `RangeError`/`TypeError` reaching that catch is **always a compiler bug**, never
a user diagnostic. Reporting it without provenance makes every such bug cost a
bespoke instrumentation cycle, and it is indistinguishable from a legitimate
user-facing compile error in the result payload.

## Proposed change

- Under a debug env flag (mirroring `JS2WASM_IR_POSTCLAIM_LOG` / the new
  `JS2WASM_COMPILE_PROFILE`), write the full stack to stderr.
- Unconditionally, include the innermost `src/` frame in the diagnostic message
  for non-`CodegenError` exception types, so the default output still points
  somewhere.
- Consider classifying internal exception types (`RangeError`, `TypeError`)
  distinctly from deliberate codegen diagnostics in the result payload.

## Acceptance criteria

- An internal exception during codegen reports at least one `src/` frame by
  default.
- The debug flag yields the full stack.
- No change to deliberate `CodegenError` diagnostics.
