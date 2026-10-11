---
id: 6862
title: "tailwindcss standalone-dynamic: stack-balance CE — `__anon_87_parseCandidate` entry references a local the function does not declare (boxed-capture prologue)"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: high
horizon: m
feasibility: medium
task_type: bug
area: compiler
goal: standalone-mode
---

## Problem

Once [#6754](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6754-standalone-map-subclass-struct-layout)
is fixed, this is the only remaining compile error on the tailwindcss 4.3.3
`standalone-dynamic` lane. Measured 2026-10-05 with
`npx tsx scripts/generate-npm-compat-report.mjs --only tailwindcss --no-write --perf-only --lane standalone-dynamic`:

```
Codegen error: stack-balance invariant (entry): '__anon_87_parseCandidate' references local 37,
but only 2 params + 10 locals are declared (locals: 2:__fnmemo_s_0, 3:__boxed_C, 4:__boxed_w,
5:__boxed_T, 6:__boxed_A, 7:__boxed_K, 8:__tdz_box_i, 9:__tdz_box_w, 10:__tdz_box_T, 11:__tdz_box_K;
body: [local.get 2, ref.is_null, if { ref.func …, i32.const 2, ref.null.extern, local.get 7,
local.get 37, struct.new 674, local.tee 3, …, local.get 35, struct.new 674, local.tee 4,
local.get 39, struct.new 674, local.tee 5, … }]
```

The function-memo (`__fnmemo_s_0`) entry prologue builds the boxed-capture
cells (`__boxed_C/w/T`) from locals 35/37/39. Those indices are the enclosing
function's slots, not the inner function's. So the memo prologue was emitted,
or copied, under the wrong function context. The issue file listed this
diagnostic as "reported, not this issue".

## Next step

Reduce `parseCandidate` from `package/dist/lib.mjs` to a fixture. Its shape is
a nested function with boxed `let` captures plus a `__fnmemo` memoized closure.
Then find which pass emits the memo prologue against the outer `fctx`.
