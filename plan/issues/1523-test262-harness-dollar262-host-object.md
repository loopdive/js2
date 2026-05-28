---
id: 1523
title: "test262 harness: provide `$262` host-object API (createRealm / detachArrayBuffer / agent / global)"
status: done
created: 2026-05-20
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: test-runner
language_feature: test262-harness
sprint: Backlog
es_edition: n/a
test262_category: multiple (generators, Atomics, AbstractModuleSource)
test262_count: 341
related: [1357]
---
# #1523 — Wire up the `$262` test262 host-object in the runner

## Problem

Test262 conventions define an ambient `$262` object that suite tests
rely on for realm creation, ArrayBuffer detach, agent messaging, and
global access. Our runner currently does not expose `$262`, so 341
tests fail with:

```
L41:3 $262 is not defined
```

These tests aren't testing whether `$262` works — they need it as a
*precondition* (e.g. to detach a buffer, then verify ArrayBuffer
semantics).

## Failing test examples

- `test/language/expressions/generators/eval-body-proto-realm.js` — uses `$262.createRealm`
- `test/built-ins/AbstractModuleSource/prototype.js` — `$262.AbstractModuleSource`
- `test/built-ins/Atomics/notify/notify-with-no-agents-waiting.js` — `$262.agent.*`
- `test/built-ins/Atomics/wait/no-spurious-wakeup-on-xor.js` — `$262.agent.*`
- `test/built-ins/Atomics/wait/bigint/no-spurious-wakeup-on-exchange.js` — `$262.agent.*`

## Reference

Spec: <https://github.com/tc39/test262/blob/main/INTERPRETING.md#host-defined-functions>
Required surface (subset relevant to current failures):

| Member | Use |
|--------|-----|
| `$262.createRealm()` | spawn a fresh realm (proto-realm tests) |
| `$262.detachArrayBuffer(buf)` | mark an ArrayBuffer detached |
| `$262.global` | back-reference to the realm's global object |
| `$262.gc()` | force a GC (FinalizationRegistry tests; can be no-op) |
| `$262.evalScript(src)` | sloppy-mode eval (already partially wired via eval) |
| `$262.agent.{start,receiveBroadcast,…}` | worker-style messaging |

`$262.agent.*` is gated by SharedArrayBuffer/Atomics support (#665);
the realm/detach/global subset is independently useful.

## Acceptance criteria

- `$262.createRealm`, `$262.detachArrayBuffer`, `$262.global`,
  `$262.gc`, `$262.evalScript` are exposed in the test262 runner.
- At least 100 of the 341 `$262 is not defined` tests now reach the
  assertion phase (pass or assertion-fail, not CE).
- `$262.agent.*` may remain a stub that throws "agent unsupported"
  until SharedArrayBuffer lands — those tests are skipped today
  anyway via test category filters.

## Estimated impact

Up to **341 test262 fails** unblocked, with realistic ~150 immediate
passes after realm/detach/global are wired (Atomics-dependent tests
still need #665).

## Resolution

Added a `needs262` flag to `buildPreamble` in `tests/test262-runner.ts`
that injects a `let $262: any = { ... }` object when the test body
references `$262`. The stub exposes `global`, `gc`, `evalScript`,
`detachArrayBuffer`, `createRealm`, `agent.*`, `IsHTMLDDA`,
`AbstractModuleSource`. `detachArrayBuffer` sets the `__detached__`
sidecar (same mechanism as `$DETACHBUFFER`); `createRealm` returns a
self-referential bare realm; `agent.*` are no-op stubs.

### Validation
Local probe (50 randomly-sampled `$262`-using tests):
- Before: 50/50 `compile_error` (`$262 is not defined`).
- After:  0  `compile_error`, 11 `pass`, 39 `fail` (downstream
  semantics — `eval is not a function`, `safeBroadcast`, etc., which
  are out of scope here).

Non-`$262` regression sample (30 Math built-ins): unchanged (28 pass,
2 fail).
