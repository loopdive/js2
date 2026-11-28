---
id: 7570
title: "Use realm numeric conversion for unary bitwise NOT"
status: done
completed: 2026-11-27
created: 2026-11-27
updated: 2026-11-27
priority: high
goal: core-semantics
related: [7564]
---

# Unary bitwise NOT

Evaluate the operand once. On the Prepared realm path use the same numeric conversion as Number and Math, then the existing bitwise XOR with minus one for the ECMAScript 32-bit result. The closed realm currently excludes BigInt and Symbol from its carrier. The ordinary pipeline retains its existing operand check.

Compare all 14 ES5 originals in the bitwise-NOT directory with the unchanged dependency in both modes. Exercise boolean and string conversion, wrapping at 32 bits, observable object conversion order, abrupt completion and the BigInt admission boundary.

On the actual #7531 dependency, eight of 14 files pass in both modes, up from five (16/28 versus 10/28 executions, zero losses). On the local integration with #7516, #7567, #7569 and the #7561 wrappers, the identical roster reaches 12/14 (24/28 versus 10/28 with the wrappers alone, zero losses). Only eval and new Object() remain on that integration. Each successful execution required Prepared emission, no imports, and successful module initialization. The six focused tests and project typecheck passed on the isolated branch.
