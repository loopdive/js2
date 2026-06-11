---
id: 2082
title: "implicit derived-class constructor (WasmGC-struct path) synthesized with zero params — new Dog('rex') constructs with name=null"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1833, 2078]
origin: "2026-06-11 WAT quality review (fable agent): runtime-verified on current main"
---

# #2082 — 'null barks': parent ctor assignments replayed with unresolved names

## Problem

```ts
class Animal { name: string; constructor(name: string) { this.name = name; } speak() { return this.name + " barks"; } }
class Dog extends Animal { }
new Dog("rex").speak()
// wasm: "null barks"   node: "rex barks"
```

WAT evidence: `(func $Dog_new (result (ref null $Dog)))` — zero params;
`ref.null extern / struct.set $Dog 1`; call site evaluates the argument
then DROPS it (`…"rex" / drop / call $Dog_new`).

## Root cause

`src/codegen/class-bodies.ts:1292-1356` — the implicit derived ctor on the
WasmGC-struct path is synthesized with zero parameters, then replays the
parent ctor's assignments (`this.name = name`) in a scope where `name`
doesn't resolve; the unresolved identifier silently compiles to ref.null
(the silent-null fallback is a second smell worth a loud diagnostic). The
externref-backed path (class-bodies.ts:1263-1289, fixed by #1833/PR 1255)
already forwards correctly — only the struct path is broken.

## Fix direction

Synthesize the implicit ctor with the parent ctor's parameter list and
forward (`constructor(...args){ super(...args) }`, §15.7.14), mirroring
the #1833 fix onto the struct path. Make unresolved-identifier-to-null a
compile error while there.

## Acceptance criteria

- Repro returns "rex barks"; multi-arg and multi-level chains correct
- #1833's externref-path tests unchanged

## Dupe check

#1833 (in-review, externref/builtin-parent path only — agent verified the
struct path still broken on current main), #251 (done, diagnostics), #1551
(explicit super arg eval), #2018. New.
