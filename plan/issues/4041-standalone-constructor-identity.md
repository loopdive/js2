---
id: 4041
title: "Prototype / `constructor` identity differs in standalone — obj.constructor is not the expected function, plus an env::Object_set_constructor host-import leak"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-mode
related: [1781, 4040]
---

# Prototype / `constructor` identity differs in standalone — obj.constructor is not the expected function, plus an env::Object_set_constructor host-import leak

## Problem

**~35 goal-scope files that PASS in the host lane and FAIL in standalone** (part
of the #4040 902-file gap). Two related signatures:

```
 14  Test262Error: The value of obj.constructor is expected to equal the value of …
 11  Test262Error: The value of n_obj.constructor is expected to equal the value of …
 10  standalone target emitted host imports: env::Object_set_constructor, env::…
```

The third is the tell: standalone **refuses** a host import that the gc lane
satisfies, so `constructor` is never wired up — and the first two are what that
looks like from the test's side. Areas: `Object/prototype` 15,
`Number/prototype` 15, plus `Object/getOwnPropertyDescriptor` 12.

## Why it is a good candidate

It is a **host-import leak with a named import** (`env::Object_set_constructor`),
which is the most tractable shape in the standalone gap: the refusal names the
exact capability, and the fix is a Wasm-native implementation of one well-defined
operation rather than a semantics investigation.

## ⚠ Before sizing

- **Verify the two `constructor` signatures are ONE mechanism**, not two. `n_obj`
  vs `obj` suggests different fixtures, but the assertion is identical — check the
  bodies, not the message.
- **`runTest262File` does NOT apply the #2961 host-import refusal**, so any lever
  whose mechanism is "stop emitting a host import" reads as **+0 locally** — the
  import is simply satisfied there. Measure by (a) censusing the import count
  going 1 → 0, and (b) deriving the CI delta from the worker's rule, labelled as a
  derivation. Do not call it measured.
- Check whether the fix also flips files in the 1,344 both-fail set; if it does,
  say so separately — that is host-lane value, not gap closure.
