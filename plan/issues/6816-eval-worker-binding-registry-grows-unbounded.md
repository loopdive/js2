---
id: 6816
title: "runtime-eval: the eval Worker's `bindingById` registry grows with every eval call and is never released — a long-lived instance that evals in a loop leaks"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: runtime
language_feature: eval
goal: core-semantics
related: [6790, 6779, 1006]
requested_by: ttraenkler/claude-review
origin: "noticed by the #6790 implementation (2026-10-02) while scoping the other process-lifetime registries per instance; left out of its scope"
---
# #6816 — one more process-lifetime registry

## Problem

#6790 scoped three process-lifetime registries in `src/runtime.ts` per
instance. The eval provider's Worker side (`src/runtime-eval*.ts` /
`src/runtime/dynamic-function-import.ts` — the `bindingById` map that gives
each eval'd function access to its captured bindings) was left out: entries are
added per `eval(...)` / `new Function(...)` call and never removed, so an
instance that evals in a loop (`for (let i = 0; i < 1e5; i++) eval("i + 1")`)
grows the map without bound, and the bindings it references stay reachable.

## Correction

- Key the registry per instance (the #6790 pattern) so disposing an instance
  drops it.
- Release an entry when its eval result can no longer reach it: for a direct
  `eval` whose result is a primitive the entry can be dropped on return; for a
  `new Function` result tie the entry's lifetime to the function object (a
  `FinalizationRegistry` on the host, or an explicit release when the
  function's closure record is collected).

## Acceptance

- A test that evals 10 000 primitive expressions on one instance keeps the
  registry size bounded (assert on an exported size or a debug hook).
- The existing eval tests (`tests/issue-1006.test.ts`, `tests/issue-6779-*.test.ts`)
  stay green under both policies.
