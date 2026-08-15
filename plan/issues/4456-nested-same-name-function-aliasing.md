---
id: 4456
title: "Same-named nested function declarations in different scopes alias to ONE closure value (R8 of #4437 — correctness bug)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: function-declarations
goal: standalone-gap
related: [4437, 3123, 3316]
origin: "2026-08-15 wave 10 — #4437's R8: `p === q` and `q() === 1` for two different nested declarations named the same; flagged there as a real correctness bug deserving its own issue."
---
# #4456 — nested same-name function declarations alias

READ FIRST: #4437's issue file R8 (the repro: two functions each declaring a
nested `function inner(){...}` with different bodies — both outer functions
return the SAME closure value, and calls run the wrong body). Root-cause the
closure-mint keying (suspect: a name-keyed singleton where a per-declaration
key is required — cf. `ensureMethodClosureSingleton`'s keying and the
closure-mint sites in closures.ts / declarations hoisting). Measure the
affected population from the corpus yourself (base runs yours); fix with a
declaration-identity key; controls: closure-heavy stride sample, capture-ABI
suites (#3123/#3316 constraints), gc/host byte-identity.
