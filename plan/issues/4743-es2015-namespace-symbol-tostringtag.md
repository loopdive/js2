---
id: 4743
title: "ES2015 standalone Math and Reflect Symbol.toStringTag descriptors"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
es_edition: es6
language_feature: Symbol.toStringTag
goal: standalone-mode
source_loc_cap: 180
loc-budget-allow:
  - src/codegen/builtin-static-globals.ts
func-budget-allow:
  - src/codegen/builtin-static-globals.ts::pushBuiltinNamespaceObject
related: [2907, 4740, 4741]
---

# #4743 — standalone namespace `Symbol.toStringTag` descriptors

## Problem

The standalone compiler materializes `Math`, `JSON`, and `Reflect` as native
namespace carriers. `JSON` seeds its own non-enumerable `Symbol.toStringTag`
property, but the analogous `Math` and `Reflect` properties are omitted. A
computed read therefore returns `undefined`, and `propertyHelper.js` reports
that the symbol is not an own property. This is separate from #4741's native
string null conversion and #4740's collection prototype mapping.

## Exact baseline

The fresh standalone baseline JSONL fetched on 2026-08-25 (oracle version 13)
records both exact ES2015 rows as standalone failures while the host lane passes:

```
test/built-ins/Math/Symbol.toStringTag.js
  host: pass
  standalone: fail — Expected SameValue(«undefined», «"Math"») to be true

test/built-ins/Reflect/Symbol.toStringTag.js
  host: pass
  standalone: fail — Symbol() should be an own property
```

The corresponding `JSON/Symbol.toStringTag.js` row is already pass in both
lanes, proving that the existing JSON namespace seed is the intended substrate.

## Bounded implementation plan

1. Extend the existing standalone namespace-carrier initialization to seed the
   `Math` and `Reflect` `Symbol.toStringTag` data properties with their exact
   string values.
2. Preserve the spec descriptor flags (`writable: false`, `enumerable: false`,
   `configurable: true`) and the existing identity-stable well-known-symbol
   key path. Leave JSON, host mode, and unrelated namespace properties alone.
3. Add focused host/standalone controls for both exact Test262 files, a direct
   value check, and an ordinary namespace control to prove no host import leak.

## Acceptance

- Both exact rows change from standalone 0/1 to 1/1 while host remains 1/1.
- `Math[Symbol.toStringTag] === "Math"` and
  `Reflect[Symbol.toStringTag] === "Reflect"`; descriptors match Test262.
- Standalone direct probes instantiate with zero host imports.
- Production source remains below the 180-LOC cap; TS5/TS7, focused tests,
  lint/format, issue checks, and LOC/function budgets pass.

## Test Results

- Exact Test262 rows: Math and Reflect both pass in host and standalone (4/4).
- Focused zero-import namespace control: pass; focused Vitest total 5/5.
- TypeScript 5/7, Biome, Prettier, LOC/function budgets, and issue checks: pass.
- Production change: 24 net LOC in the issue-approved namespace carrier.
