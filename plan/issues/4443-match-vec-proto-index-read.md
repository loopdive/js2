---
id: 4443
title: "__extern_get_idx answers undefined for a $__regexp_match_vec receiver in builtin-prototype-writing modules (R1 of #4439)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp-string-methods
goal: standalone-gap
related: [4439, 4160, 3673, 4434]
origin: "2026-08-15 wave 9 — #4439's R1 residual, pre-existing, with its repro and narrowing."
---

# #4443 — match-vec indexed read vs the builtin-prototype consult arm

## Problem & prior narrowing (READ #4439's issue file R1 FIRST)

Pre-existing, blocks the 3 remaining borrowed-match files
(`match/S15.5.4.10_A2_T17/T18`, `A1_T3`). Repro uses only the DIRECT path:

```js
Number.prototype.foo = 1;                    // any builtin-prototype write
var m = "10203040506070809000".match(/0./);
box.v = m; box.v[0]                          // → undefined
```

while `.length`, `.index`, and `m["0"]` are all correct, and a plain array
receiver is unaffected. #4439 narrowed it to a spliced arm AHEAD of the
base-vec arm in `__extern_get_idx` returning the Array-prototype consult
(`consultArray=1`) for the `$__regexp_match_vec` receiver.

## Implementation Plan

1. Reproduce with the one-define-per-module discipline (#4434's confound
   warning applies). Read the `__extern_get_idx` arm ordering
   (vec-overlay.ts / dyn-read.ts fills) and find why the match-vec receiver
   takes the proto-consult arm instead of its own indexed read.
2. Fix by ordering/gating the match-vec arm correctly; the match-vec struct
   is `$__regexp_match_vec` (native-regex.ts, REGEXP_MATCH_VEC_STRUCT) — a
   subtype of `$__vec_base`, so a base-vec-typed arm placed first should
   already serve it; find why it doesn't.
3. Verify: the repro; the 3 borrowed-match files; #4439's 18-test pin and
   the match/search collateral scope (119 files) with zero regressions;
   gc/host byte-identity.

## Acceptance criteria

- The repro reads "02"; ≥2 of the 3 blocked files flip; zero regressions in
  the #4439 collateral scope.
