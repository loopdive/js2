---
id: 7589
title: "Preserve the JavaScript result of a value-less direct call"
status: done
completed: 2026-11-27
created: 2026-11-27
priority: high
goal: core-semantics
related: [7588]
---

# Read the result of a value-less call

## Implementation plan

Record the JavaScript result on the direct call signature when a synchronous ordinary function has a body with no value-returning statement and a void Wasm result. Use the existing return walker, which excludes nested functions and classes. Emit the call before producing the realm's undefined value. Use the same signature when classifying operands. Calls in statement position keep their existing lowering.

## Results

A source scan of non-negative ES5 originals under language found 13 files containing a top-level function declaration with no value-returning statement and a call to that name outside an expression statement. All 25 legal variants ran with the original harness. The parent passed 0/25 and this change passed 10/25. Three call-expression files and two function-statement files gained both modes. Every passing module used required standalone Prepared WasmGC emission and imported nothing.

Four Node comparisons check fallthrough with a side effect, bare return, an exception, and an explicit numeric return. Seven neighboring failures reproduce on the unchanged parent. Six request the removed host-assisted profile and one expects a value-returning method to be refused. A return followed by unreachable code still fails in statement-list lowering.
