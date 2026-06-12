---
id: 2025
title: "calling an extracted method (const f = a.m; f()) traps uncatchably instead of throwing catchable TypeError"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
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
