---
id: 4623
title: "two-lane: `<plain object>.isPrototypeOf(v)` compiles the receiver/argument to ref.null extern — answers false with no constructor anywhere; blocks S13.2.2_A1_T1/_T2"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: prototype-chain
goal: standalone-gap
related: [4506, 4480]
origin: "dev-4506 residual (2026-08-23): WAT-decoded — the highest-value single defect left in the fnctor/prototype families. Reproduces on --js-host too (two-lane), per #4480's 2026-08-20 record."
---

# #4623 — isPrototypeOf receiver compiles to ref.null extern

## Problem (measured by dev-4506, WAT-decoded)

```js
var P = { q: 1 };
var o = Object.create(P);
P.isPrototypeOf(o)   // → false;  "q" in o → true, same module
```

No constructor involved anywhere. WAT decode on the campaign branch: the
call site emits `global.get <P>; …; ref.null extern; call
$__isPrototypeOf` — the ARGUMENT (or receiver, verify which slot) is
compiled to `ref.null extern` instead of the object's carrier, so the
runtime chain walk starts from null and answers false.

This is the general form of the wrong boolean #4480 recorded on
2026-08-20, and it **also reproduces on `--js-host`** — a two-lane defect,
so the fix needs a two-lane test. It is what actually blocks
`language/statements/function/S13.2.2_A1_T1.js` and `_T2` (per #4506's
issue file, which has the full provenance).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-verify
   the WAT shape on current campaign HEAD (a770288c7 or later) — #4506's
   chain-walk classification arms landed since the decode.
2. Find where the `.isPrototypeOf(x)` call site resolves its argument:
   the classifier added by #4506 (`fnctor-escape-gate.ts` /
   `classifyUse`) vs the call lowering's coercion of the argument to
   externref. The defect signature — a *proven-live* local/global
   compiled as `ref.null extern` — smells like a null-narrowing or
   default-value arm in type-coercion for an unresolved nominal type, not
   a dispatch miss. Read `src/codegen/type-coercion.ts` (`coerceType`
   ref/ref_null → externref arm) and the `__isPrototypeOf` registration.
3. Fix so the argument carries the real object reference in BOTH lanes.
4. Two-lane A/B: the probe above + S13.2.2_A1_T1/_T2 + a scoped
   `language/statements/function` + `built-ins/Object/prototype/isPrototypeOf`
   sweep, standalone AND js-host lanes, base copies at first edit.
5. Pins: tests/issue-4623.test.ts, both lanes (host lane via the
   omit-4th-arg driver convention — passing "gc" corrupts options).
