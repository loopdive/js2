---
id: 7097
title: "Async-CPS gap: after an `await`, `s.length` of a string built with `s += t` reads 1 instead of 3"
status: ready
created: 2026-10-19
updated: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: async/await
goal: architecture
sprint: current
parent: 5385
related: [7094, 7096]
---

# #7097 — string accumulator state across an `await`

Found by #7094 (2026-10-19). `let s = ""; s += "a"; s += "bc"; await p;
s.length` answers 1 on the native lanes where Node answers 3. The
concatenation before the suspension is a string-builder (rope) candidate;
the value saved across the `await` appears to be the builder's first chunk
or a stale snapshot rather than the flattened string, so the resumed code
reads a one-character string.

## Plan

1. Measure: a `.tmp` matrix on native-first and standalone against Node —
   `s += t` once / twice / in a loop before the await, `s.length`, `s`
   itself, `s[1]`, `s.charCodeAt(2)` after the await; the same with the
   string created by `+` (no compound) and by template literals; with the
   string-builder lowering forced off (compile option) to confirm the site.
2. Fix at the identified site: either flatten the builder when it is saved
   into the async frame (`src/codegen/async-cps.ts` save set) or make the
   builder's length/read helpers correct on a resumed frame; keep programs
   without an `await` byte-identical.
3. Tests: a focused test under native-first and standalone vs Node.
4. Acceptance: equivalence gate "No new equivalence regressions"; no host
   import; direct-AST freeze respected.
