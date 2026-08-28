---
id: 5096
title: "A user class whose name shadows an ambient global is never constructed — `new X()` throws \"X is not a constructor\""
status: ready
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class-shadowing
goal: correctness
origin: 3481
---

# #5096 — a global-shadowing user class is unconstructable

Split out of [#3481](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3481-bigint-symbol-coercion-value-rep)
step 2 (PR #5101). The step-2 slice added a `new SharedArrayBuffer(length)`
Symbol guard in the generic `new` path, so it needed a test proving the guard
does not hijack a same-named user class. Writing that test surfaced something
larger: **the user class does not work at all**, with or without the guard.

**PRE-EXISTING and unrelated to #3481's fix** — identical on `origin/main` and on
the step-2 branch (A/B below). #5101's test asserts only that the failure is
still the pre-existing one and *not* the guard's message, with a comment
pointing here.

## Repro

```ts
class SharedArrayBuffer {
  v: number;
  constructor(_v: any) { this.v = 7; }
}
new SharedArrayBuffer(1).v;   // → TypeError: SharedArrayBuffer is not a constructor
                              //   spec: 7
```

The throw comes from the runtime's generic construct bridge
(`src/runtime.ts`, the `new Ctor(...args)` line in the extern-class /
`__construct_closure` path) — i.e. the call was routed to the **ambient global**
instead of to the user's class. In a JS-host lane the host `SharedArrayBuffer`
is not callable that way, so it surfaces as "not a constructor"; the underlying
bug is the routing, not the message.

## It is NOT SharedArrayBuffer-specific — that was the misleading first read

Every global-shadowing name behaves the same, and a name that shadows nothing
works. Measured in one module:

| declaration | `new X(...)` | verdict |
| --- | --- | --- |
| `class SharedArrayBuffer` | `TypeError: SharedArrayBuffer is not a constructor` | **wrong** |
| `class ArrayBuffer` | `TypeError: ArrayBuffer is not a constructor` | **wrong** |
| `class DataView` | `TypeError: DataView is not a constructor` | **wrong** |
| `class Map` | `TypeError: Map is not a constructor` | **wrong** |
| `class NotAGlobalAtAll` | `11` | ok |
| `const Local = class { v = 2 }` (non-global name) | `2` | ok |

Scope does not change it: a `class ArrayBuffer` declared **inside a function
body** fails the same way (`TypeError: ArrayBuffer is not a constructor`), so the
discriminator is purely "the binding's name matches an ambient global", not
"declared at module top level".

So the correct framing is a **shadowing-resolution bug in `new` dispatch**: the
builtin-global arms of `compileNewExpression`
(`src/codegen/expressions/new-super.ts` → `tryCompileBuiltinGlobalNew`
/ `tryCompileIndexedBuiltinNew`) claim the call by NAME before the local binding
is consulted, or `ctx.classSet` / `resolvesToAmbientGlobal` does not see the
user declaration for these names.

Worth checking as part of the same fix: the same name-first resolution likely
affects `function SharedArrayBuffer() {}`-style shadows and `let Map = class …`
re-bindings, and it is the mirror image of the guard conditions #5101 relies on
(`resolvesToNamedAmbientGlobal(ctx, expr.expression, "SharedArrayBuffer") &&
!ctx.classSet.has("SharedArrayBuffer")`) — if `classSet` were authoritative here,
those guards would already be doing the right thing for the shadowed case.

## A/B evidence

| side | commit | `class Map` → `new Map().v` |
| --- | --- | --- |
| `origin/main` | `220ce6c491` | `TypeError: Map is not a constructor` |
| #3481 step-2 branch | `923a35fe59` | `TypeError: Map is not a constructor` |

Identical, so #5101 neither caused it nor is masked by it.

## Why this matters beyond the repro

test262 shadows intrinsics routinely to test resolution and to stub hostile
globals, and any such file currently dies at the shadow rather than at the
behaviour under test. Impact was **not** sized here — sizing it needs a scan for
files that declare a class/function named after an intrinsic, which is the first
thing the implementer should do so the fix has a measured cohort rather than a
single repro.

## Acceptance

- `class X { … }` where `X` names an ambient global constructs the USER class;
  `new X()` returns the user instance.
- Works for a top-level declaration and for one inside a function body.
- The ambient global is still reachable where it is not shadowed, and the
  builtin fast paths (`new ArrayBuffer(8)`, `new Map()`, `new DataView(buf)`)
  are unchanged when no user binding exists — verify by byte-identity on a
  corpus, since these are the hottest builtin lowerings.
- Zero pass→fail overall.

## Notes for the implementer

#5101 added `tests/issue-3481-step2-symbol-arg-revalidation.test.ts` with a case
"the SharedArrayBuffer guard does not hijack a same-named user class", which
today asserts the failure is the pre-existing "not a constructor" one rather
than the Symbol guard's message. When this lands, that case should be tightened
to assert the user class's value (`7`).
