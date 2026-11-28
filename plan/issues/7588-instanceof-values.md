---
id: 7588
title: "Use the realm instanceof operation for evaluated constructor operands"
status: done
completed: 2026-11-27
created: 2026-11-27
priority: high
goal: core-semantics
related: [7587, 7561]
---

# Evaluate instanceof through the realm operation

## Implementation Plan

Retain the known class, function and wrapper plans. For other operands on the function-object lane, evaluate both values in source order and use the existing runtime operation for callability and prototype lookup. Compare the entire ES5 instanceof directory against the parent with the original harness and cover order, exceptions and callable targets against Node.

## Results

On the main-based branch, 8 of the 69 legal variants across all 35 ES5 instanceof originals passed, compared with 4 on its parent. The four gains were S11.8.6_A2.4_T2 and S11.8.6_A3 in both modes. All previously passing variants still passed. The passing artifacts used required Prepared WasmGC, zero module imports and the original test harness. Node differential checks cover a constructor returned by a function, effects before a non-callable target throws, and the left callee throwing first.

A direct call compiled with a void return is still refused when used as an operand. Resolving that requires the direct-call value representation.
