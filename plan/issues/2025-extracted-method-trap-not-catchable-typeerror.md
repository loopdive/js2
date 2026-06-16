---
id: 2025
title: "calling an extracted method (const f = a.m; f()) traps uncatchably instead of throwing catchable TypeError"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2108
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1949, 581]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2025 — null-this trampoline trap escapes try/catch

## Problem

```ts
class A { x = 42; m(): number { return this.x; } }
const a = new A(); const f = a.m;
try { return "got:" + f(); } catch (e) { return "threw"; }
// wasm: trap "dereferencing a null pointer" escapes the try/catch
// node: "threw" (TypeError: this is undefined)
```

Extraction of methods that don't touch `this` works.

## Root cause

`src/codegen/closures.ts:3264-3269` — extraction trampoline passes
`ref.null <objStruct>` for `this` by documented design ("methods that DO
use `this` will trap inside the body"); divergence is trap-vs-catchable
TypeError (error model). Family: #581 (struct.get on ref null
catchability).

## Fix direction

Emit a null-check prologue in the trampoline (or at `this`-deref sites in
methods reachable via extraction) throwing the JS TypeError exception tag
instead of trapping.

## Acceptance criteria

- Repro returns "threw" with TypeError; bound/direct calls unchanged

## Dupe check

#1949 (call/apply thisArg) adjacent but distinct; #581 is the general
family. New.

## Implementation (2026-06-16)

The method-extraction trampoline lives in `buildTrampolineThisSlot`
(`src/codegen/closures.ts`), shared by the object-literal (`emitObjectMethodAsClosure`),
cached class-method (`emitCachedMethodClosureAccess`), and per-call-site paths
(all rebuilt by `finalizeMethodTrampolines`). It resolved `this` from
`__current_this` (#2015) and, on the unbound-extraction null arm, forwarded
`ref.null`. When the method body then did `this.x` (`local.get 0; struct.get`),
the `struct.get` on a null ref **trapped uncatchably**, escaping the user's
try/catch.

Fix:
- `buildTypeErrorThrow(ctx, msg, fctx?)` — generalised `buildDestructureNullThrow`
  in `src/codegen/destructuring-params.ts` into a message-parameterised, JS-host
  + standalone (`__new_TypeError` / `__throw_type_error`) catchable-TypeError
  throw returned as `Instr[]`.
- `buildTrampolineThisSlot` now takes `methodUsesThis`. On the null-`this` arm it
  throws a catchable TypeError when the method reads `this`, else forwards the
  harmless `ref.null` (so extracting a `this`-free method still works — the issue
  note's required case).
- `methodReadsThisParam(ctx, methodFuncIdx)` decides `methodUsesThis` by walking
  the now-final compiled method body for any `local.get 0` (recursive via
  `walkInstructions`; locals are function-scoped so index 0 is always `this`).
  Computed in `finalizeMethodTrampolines` (initial-emit placeholders pass `false`
  and are overwritten by finalize).
- Index-shift safety: `ensureTypeErrorThrowImports(ctx)` pre-registers the
  throw's late imports ONCE before the finalize loop, so the in-loop throw adds
  no new import mid-pass (which would shift `call methodFuncIdx` forwarders that
  were already built at pre-shift indices — the cause of an early
  `extern.convert_any expected anyref, found call of type f64` invalid module).

## Test Results (2026-06-16)

`tests/issue-2025.test.ts` — 7/7 pass:
- extracted this-using method → catchable "threw" (acceptance criterion)
- caught value `instanceof TypeError` → true
- extracted this-using method with args → catchable
- direct call `a.m()` → 42 (unchanged)
- extracted `this`-free method → 7 (no spurious throw)
- value-receiver dispatch `o.m()` after extraction → 42 (no regression)
- standalone mode → catchable "threw"

Regression check (worktree vs. clean baseline): #1118, #1394, #1602,
#1602-regress-direct-call, #1636s1, #1636-s1-tojson, #1702, #1672 async-gen
trampoline, generator-methods/-destructuring all pass. The few file-level
failures (`classes.test.ts`, `class-methods.test.ts`, `class-method-calls.test.ts`
`string_constants` harness-stub; `object-literal-getters-setters > setter
stores value`) reproduce IDENTICALLY on clean origin/main — pre-existing, not
caused by this change. typecheck / lint / format all clean.
