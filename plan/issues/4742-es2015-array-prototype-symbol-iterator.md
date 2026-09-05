---
id: 4742
title: "ES2015 standalone Array.prototype Symbol.iterator"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: es6
language_feature: array-iterator, Symbol.iterator
goal: standalone-mode
source_loc_cap: 180
depends_on: [4739]
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/proto-index-store.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccess
---

# #4742 — standalone `Array.prototype[Symbol.iterator]`

## Problem

The authoritative ES2015 residual snapshot reports that the standalone lane
returns `undefined` for `Array.prototype[Symbol.iterator]`, while the exact
Test262 row expects the intrinsic array-iterator method. Host mode passes.

## Implementation plan

1. Reproduce `test/built-ins/Array/prototype/Symbol.iterator.js` on current
   upstream main in host and standalone lanes, plus identity and
   non-constructibility controls.
2. Trace the existing standalone well-known-symbol property path and expose
   the already implemented array iterator method through the narrowest native
   prototype arm, preserving identity and descriptor behavior.
3. Add exact host/standalone coverage and sibling controls, keep production
   growth below 180 net LOC, and run all repository gates and hooks.

## Implementation

Build on #4739's native-prototype symbol descriptor foundation. Register the
`@@1` Array prototype member as an identity alias of `values`, seed its boxed
well-known Symbol into the mutable native-prototype companion, and allow native
Symbol keys through the companion normalizer without coercion. Reads, writes,
deletes, own-property checks, and descriptors therefore observe one entry.

## Test results

- Baseline snapshot: host pass; standalone failed because the value was
  `undefined`.
- Exact standalone `Array/prototype/Symbol.iterator.js`: pass, including
  writable/non-enumerable/configurable behavioral verification.
- Host identity and descriptor control: pass.
- Standalone `Symbol.iterator/not-a-constructor.js`: pass.
- #4739 Function `@@hasInstance` regression controls: 2/2 pass.
- Focused Vitest total: 5/5 pass. TypeScript 5 and TypeScript 7: pass.
