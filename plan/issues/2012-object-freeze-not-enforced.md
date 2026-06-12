---
id: 2012
title: "Object.freeze: no strict-mode TypeError on write, isFrozen false — tracking only fires for identifier args, struct receivers get no integrity bit"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [797, 359]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2012 — freeze of inline literal is a no-op

## Problem

```ts
const o: any = Object.freeze({a: 1});
let threw = false;
try { o.a = 2; } catch { threw = true; }
threw + "," + o.a + "," + Object.isFrozen(o)
// wasm: "false,1,false"   node: "true,1,true"  (module code is strict)
```

(The write does fail — but silently, and isFrozen misreports.)

## Root cause

`src/codegen/expressions/calls.ts:3770-3830` — `frozenVars` tracking only
fires for identifier args (an inline literal arg gets nothing), and
struct-typed receivers end at "For struct/ref types, compile-time tracking
is sufficient — return as-is" (calls.ts:3828) with no runtime integrity
bit and no strict-write throw; `isFrozen` then consults only
`ctx.frozenVars`/host path and reports false.

## Fix direction

Stamp a runtime frozen bit (sidecar or hidden field) on freeze for struct
receivers; check it in the property write path (strict → throw TypeError)
and in isFrozen.

## Acceptance criteria

- Repro matches Node; frozen identifier-arg behavior unchanged

## Dupe check

#797d and #359 done; residual not listed in #1971. New.
