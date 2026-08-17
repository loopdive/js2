---
id: 4548
title: "WasmGC-lane AOT tier: compile bytecode to WasmGC-native code against our runtime — the tiering of #4404 without the linear heap or the membrane"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: performance
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2860, 2928, 4404, 4546, 4547]
# id 4548 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: sole open PR was 4639
# (ci/npm-compat-refresh, artifact-only), which adds no issue file.
---

# #4548 — A WasmGC-lane AOT tier

## What this is, relative to #4404

**#4404 — "QuickJS bytecode to Wasm tiering: call-boundary promotion first,
same-invocation OSR second"** specifies tiering whose generated module is a
*QuickJS tier*: it imports the engine's linear memory and keeps values rooted
in engine-owned frames. That is right for the linear lane.

This issue is the **WasmGC-lane variant**: the same tiering shape — interpret
first, compile hot functions, promote at call boundaries, OSR later — but the
compiled tier operates on **our** WasmGC runtime. Values are native `$Object` /
box-family references throughout.

The payoff is the one strategy 2c could not deliver
(`docs/architecture/runtime-eval-interpreter.md` records it rejected: handle
table, identity **broken**): **no membrane, no handle table, identity
preserved**, because nothing crosses a heap boundary.

## Why the WasmGC lane needs its own answer

In standalone WasmGC there is no engine at all, so the interpreter is the only
dynamic tier and anything not AOT-compiled stays in it permanently. That ties
directly to **#2860 — "Umbrella: close the standalone-vs-js-host test262 gap
(~20,500 host-free, honest metric #2879/#2360)"**. The linear lane can lean on
the engine; this lane cannot, which is precisely why a compiled tier matters
more here.

## The measured shape of the opportunity

From #4404's baseline (M4 / Node 24.4.1):

| | our interpreter | QuickJS-NG (wasm) | AOT side module |
| --- | ---: | ---: | ---: |
| cold process | 459.59 ms | 186.50 ms | **2.73 s** |
| prepared execution | 103.92 ms | 745 µs | **21.59 µs** |

Compiled code is ~35× faster than the engine on prepared execution, and ~2.73 s
cold. That asymmetry *is* the argument for tiering rather than for choosing one
tier: interpret immediately, compile in the background, promote when ready.

Note the cold number is the existing proof-of-concept routing source through
the full TypeScript front end. Compiling from bytecode instead is a large part
of what this issue must show is cheaper — and #4547 is the front-end half of
that.

## Scope

- A bytecode → WasmGC translator producing a side module against our runtime.
- Call-boundary promotion first; same-invocation OSR second, and only if the
  first stage's numbers justify it.
- An explicit, tested **fallback**: constructs the translator does not support
  stay in the interpreter. Coverage will never be total, and a silent
  miscompile is far worse than a missed promotion.
- Guards for unboxed numeric regions, with boxed state reconstructible at any
  deopt point.

## Acceptance criteria

- [ ] A hot function compiles and is promoted at a call boundary, with
      before/after on a committed benchmark lane, measured by the author.
- [ ] Object identity is preserved across promotion — the same object observed
      by interpreted and compiled code is the same object. No handle table.
- [ ] Unsupported constructs demote to the interpreter with a structured
      reason, and a test asserts a demoted function still produces correct
      results.
- [ ] Compile latency is reported alongside throughput; a tier that wins on
      steady state and loses more on cold is not a win, and the crossover must
      be stated.
- [ ] No regression in the test262 eval-dependent buckets.

## Non-goals

- The linear lane's tier (#4404).
- Interpreter throughput (#4546) — complementary, not a substitute: this issue
  reduces how much work stays in the interpreter, it does not make it faster.
