---
id: 7586
title: Resolve inherited global method reads in standalone Prepared code
status: in-progress
created: 2026-11-27
updated: 2026-11-27
priority: high
goal: core-semantics
---

## Implementation Plan

An identifier can resolve through the script global object's prototype. Exclude catalogued Object.prototype keys from the absent-name fold. For an inherited native method whose binding and prototype are unchanged throughout the program, read the same realm function object as ordinary member access. Use that resolution in function-value discovery and lowering. Defer other inherited reads until the runtime can perform the global-object lookup.

The same program-wide binding and mutation proof in `builtin-global-binding.ts` guards both inherited identities and absence. A program that can install a global property prevents the absent-name fold.

## Results

Checks cover the identity of all three native inherited methods, local shadowing, possible replacement, unsupported properties and a genuinely missing name. The 10 non-negative ES5 originals with a syntactic identifier reference named like an Object.prototype key have 11 required variants. Results match the parent, including the same two passes. This resolves incorrect answers demonstrated by the focused tests without a measured suite gain in that sample.
