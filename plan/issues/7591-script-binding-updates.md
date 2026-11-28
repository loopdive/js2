---
id: 7591
title: "Update writable script bindings from function bodies"
status: done
completed: 2026-11-27
created: 2026-11-27
priority: high
goal: core-semantics
related: [7589, 7590]
---

# Increment and decrement a script binding from a function

## Implementation plan

Resolve local bindings first. For a nonlocal identifier, request the writable module binding for the original update expression and check its owner and initialization state before reading the value. Use the existing storage, numeric conversion, and write-back operations. Share statement assignment and update dispatch between function bodies, nested statements and void expression tails.

## Results

The original S12.13_A3_T6 tests script-global increments before explicit and implicit returns and observes the results around throw/catch. It gained strict and sloppy execution. Differential controls exercise decrement, a parenthesized statement, updates inside a loop, a shadowing parameter and exceptions. A separate control checks that a const binding is refused for writing.

A source scan found five non-negative ES5 originals containing a statement-form identifier update inside a top-level function declaration where the same name has a top-level variable declaration. All ten legal variants were replayed. The parent passed 0/10 and this branch passed 2/10. The direct-call roster moved from 14/25 to 16/25 with the same gains. Both comparisons used the original harness and required standalone WasmGC emission with zero imports on passing modules. Type checking and all five focused tests passed. The broader run had 100 passes and 16 failures. All 16 failures reproduced on the unchanged parent.
