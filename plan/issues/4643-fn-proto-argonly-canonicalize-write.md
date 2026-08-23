---
id: 4643
title: "standalone: raw callable reaches $proto at C1-reconstructed arg-only sites — one write, three wrong answers (w.marker undefined, isPrototypeOf false, getPrototypeOf false); canonicalize at the write"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: prototype-chain
goal: standalone-gap
related: [4637, 4639, 4506]
origin: "2026-08-23 cross-lane verification thread (#4637/#4639): dev-4639 found an UNCATCHABLE illegal-cast trap on the merged head; dev-4637 verified and isolated it to this shape with controls. The lead removed the trap (test-before-cast in __extern_get's fnctor-proto-start arm) — this issue is the CORRECTNESS half."
---

# #4643 — canonicalize the callable-into-$proto write

## Problem (measured 2026-08-23 on the merged campaign head, three lanes)

```js
var P = function () {};
P.marker = "m";
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
```

| observable | before the lead's mitigation | after | spec |
| --- | --- | --- | --- |
| `w.marker` | **UNCATCHABLE trap** (`illegal cast in __extern_get`) | `undefined` | `"m"` |
| `P.isPrototypeOf(w)` | `false` | `false` | `true` |
| `Object.getPrototypeOf(w) === P` | `false` | `false` | `true` |
| `w instanceof G` | `true` | `true` | `true` |

Established facts (each measured, none guessed — full chain in #4637's and
#4639's issue files):

- The shape needs BOTH ingredients: a FUNCTION-valued prototype AND
  arg-only instantiation. Swap `P` for an object literal and everything is
  correct. The reachability came from #4639's C1 (`NewExpression`-argument
  escape-gate classification); the trap predated nothing — the tip
  answered the same three wrong values minus the trap.
- All three wrong answers share ONE upstream cause: a raw CALLABLE is
  already sitting in `$proto` before any consumer runs, written by a path
  that BYPASSES `__object_create` — #4637's A1 canonicalization choke
  point. `__getPrototypeOf`/`__isPrototypeOf` ref.test and answer false;
  `__extern_get`'s fnctor-proto-start arm ref.cast and trapped (now
  test-before-cast, the lead's mitigation — `object-runtime.ts` ~L2079).
- The write path is NOT identified. Both lanes explicitly declined to
  guess. Candidates to check first (unverified): the S2 fnctor-prototype
  store that `__fnctor_proto_start` reads (`emitFnctorProtoGet` land),
  and the `_fnctorProtoLookup` registration.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding) — including
   methodology item 7 (this issue exists because of that blind spot).
2. TRACE the write: instrument `__fnctor_proto_start`'s store side for the
   repro; find where `G.prototype = P` (P callable) lands the raw closure.
   WAT decode before designing. Do not fix the consumers — three of them
   already disagree; fix the WRITE so all consumers see a canonical
   `$Object` (reuse #4637's `proto-function-value.ts` canonicalize + its
   reverse map so `getPrototypeOf` answers the real function).
3. Acceptance: the three-row table above all-spec-correct; the
   `SUCCESSOR (see #4643)` it.fails pin in tests/issue-4639.test.ts flips
   positive; #4637's CROSS-LANE PREDICTION pin becomes meaningful (score
   31 for the var-then-arg twin is already banked — re-measure the inline
   shape).
4. Verify: #4637's 1,372-row sweep scope re-run before/after (own runs,
   both arms); pins 4637 (19) + 4639 (17) green; zero regressions. Pin
   discipline per the thread's rules: every new pin verified to FAIL on
   base, and pins must EXERCISE the read, not just assert identity
   relations.
