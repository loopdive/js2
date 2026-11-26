---
id: 7478
title: "Standalone link + eval mention: a throw inside a call with a `false` argument is skipped (unearned Temporal passes)"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, link, runtime-eval
goal: core-semantics
related: [7376, 7479, 5383, 4242, 6420, 6605, 6643]
import-cycles-allow:
  - largestSccSize: 709 # 2026-11-26 (#7478): src/codegen/closures/method-dispatch-entries.ts (ladder entry selection, extracted from closure-exports.ts and shared with the new provider predicate) joins the existing codegen SCC; folding it back into closure-exports.ts would breach that file's LOC budget
---

# #7478 — linked standalone unit that mentions `eval` skips a throw

## Problem

In a standalone compile that links a provider (`compileWithTemporalGlobal`)
and whose source mentions `eval` anywhere, even a dead `globalThis.eval;`:

```js
function g(m) { throw "in"; }
g(false);
throw "after";
```

- **Measured, 2026-11-26, main `6694a8b8`:** the unit throws `"after"`. It
  throws `"in"` in three other cases: when it is not linked, when it has no
  eval mention, and with `g("x")` or `g()`. The `false` argument matters.
- **Effect:** every harness `assert(false, msg)` is skipped in such a unit.
  The test262 runtime shim's `$262` mentions `eval`, so standalone Temporal
  rows on main can score passes they did not earn:
  - `verifyProperty(Temporal.PlainTime, "name", { value: "Nope" })` passes.
  - The real verdict of `Temporal/PlainTime/name.js` is
    `Test262Error: name should be an own property`.
- **Found while** root-causing the #7376 revert.

## Root cause

- **Why the `eval` mention matters.** It makes every top-level function a
  live binding. `__module_init` wraps `g`'s closure in a runtime-eval carrier,
  and `g(false)` becomes a dynamic call:
  `__apply_closure(carrier)` → `__runtime_eval_call_aot` →
  `__apply_closure(g)`.
- **Why linking matters.** In that second `__apply_closure`, the #6420 peer arm
  (`object-runtime.ts` `fillApplyClosure`) forwards to the provider's
  `__apply_closure` whenever bit 0 of the provider's
  `__js2wasm_link_callable_kind` is set.
  - That bit was plain `__is_callable`, which is structural: it is true for any
    closure, the consumer's included.
  - The provider's `__call_fn_method_N` ladder has no arm for `g`'s funcref
    type, so it returns the undefined sentinel and `g` never runs.
- **Why `false`.** The only call site specialises `m` to i32. That gives
  `(self, i32)`, a funcref type only the consumer minted.
- **It is not boolean-specific.** Any signature the provider lacks is dropped:
  `function g(m){ return 7 } g("x")` returns 0 against a provider without
  that signature.

## Implementation Plan

- **Module.** `src/codegen/standalone-link-boundary.ts`, the provider's
  `callableKind`. Bit 0 becomes
  `__is_callable(v) & !undispatchable(v)`, where undispatchable means a
  closure-root value that neither this module's `__call_fn_method_*` ladder
  nor its native-prototype arm claims. The consumer then keeps such a
  closure on its own ladder. Provider-owned closures are unaffected.
- **Reuse.** The dispatcher's entry selection moves out of
  `emitClosureMethodCallExportN` into
  `src/codegen/closures/method-dispatch-entries.ts`
  (`collectMethodDispatchEntries`). The dispatcher and the new predicate
  share it, so there is one source of truth for "which closures this module
  dispatches". `closure-exports.ts` shrinks.
- **Import cycle.** The new module imports `closure-dispatch-rest` and
  `transferred-native-proto`, and is imported by `closure-exports` and
  `standalone-link-boundary`. All four are already in the codegen SCC, so any
  module that serves both sides sits in it too. That accounts for the
  `largestSccSize` grant 708 → 709.
- **Rejected.** A consumer-side guard that skips the peer arm for any
  closure the consumer can dispatch. It broke #6643: a provider method run
  on the consumer's ladder reads the wrong `__current_this` (see #7479).
- **Quality criterion.** No duplicated ladder selection and no special case
  per type.
- **Unchanged.** gc output and unlinked standalone output are
  byte-identical. Only the provider binary changes.

## Acceptance

1. The repro throws `"in"` in every variant.
2. A pin test fails on main and passes with the fix.
3. Before the PR opens: the standalone rows that flip pass→fail are counted
   per edition, with a sample list. ES5 rows are called out explicitly.
