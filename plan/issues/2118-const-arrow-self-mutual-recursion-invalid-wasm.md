---
id: 2118
renumbered_from: 1951
title: "self/mutually-recursive const-arrow closures emit invalid Wasm (struct.get type mismatch) or runtime ref.cast traps"
status: done
completed: 2026-06-17
assignee: sendev-closures
sprint: 63
created: 2026-06-10
updated: 2026-06-17
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures
goal: compilable
related: [897, 1312, 1314, 1178]
origin: "2026-06-10 deep-audit sweep (closures agent): verified on main"
---

# #2118 — `const f = (n) => ... f(n-1)` produces an invalid module

## Problem

The arrow-closure self-recursion pattern fails Wasm validation; mutual
recursion between two const-arrows either fails validation or traps at runtime
with `ref.cast failed`. Loud failure (not silent), but a core functional-style
pattern that blocks plausible programs.

## Repro (verified on main)

```ts
export function test(): number {
  const f = (n: number): number => n <= 1 ? 1 : n * f(n - 1);
  return f(5);
}
```

| probe | wasm | node |
|-------|------|------|
| above | `WebAssembly.Module doesn't validate: struct.get structref to type (ref null <struct:10>) expected (ref null <struct:6>)` | `120` |
| `let f` variant / extra captured counter | same class of validation error | `120` |
| mutual minimal (`const a = (n)=>n===0?0:b(n-1); const b = (n)=>a(n);`) | runtime `ref.cast failed` | `0` |

Controls: named function expression `const f = function fact(n){…fact…}` OK
(`120`); top-level declarations OK; non-recursive closure pairs OK.

## Root cause

`src/codegen/closures.ts` `compileArrowAsClosure` capture analysis
(:1459-1526) captures the closure's *own binding* (`f`) as an ordinary
variable. The hoisted local for `f` is typed as one wrapper/closure struct
while the closure being constructed gets a different (subtype) struct
(:1536-1630); the inner call through the captured `f` then does `struct.get`
against the wrong struct typeIdx → validation failure, or (mutual case) a
`ref.cast` to the wrong struct type that traps. Special-casing exists for
*named function expressions* (`__self`, :1339, :1482) but not for
`const f = arrow`.

## Fix direction

Detect self-capture (closure's referenced name is the variable being
initialized with this closure) and capture via a mutable ref-cell typed to the
*shared wrapper* struct, or reuse the named-funcexpr `__self` mechanism.
Mutual recursion needs captured-closure-typed locals to use the shared wrapper
supertype consistently at call sites. Architect-level: type strategy for
recursive closure environments.

## Acceptance criteria

- Self-recursive const/let arrow validates and returns `120`
- Mutual const-arrow pair returns `0` (and deeper cycles work)
- Named-funcexpr fast path unregressed

## Dupe check

Grepped `recursive closure|self-recursive|arrow.*recursive`, `mutual`,
`factorial|fibonacci`: #897 (top-level fib, done), #1312 (nested async
fn-decl with captures, done), #1314/#1301/#1063 (other closure codegen, done),
#1178 (stack exhaustion, done). Const-arrow self/mutual recursion is untracked.

## Resolution (2026-06-17 — self-recursion fixed; mutual split out)

**Root cause (confirmed):** `compileArrowAsClosure` captured the closure's own
binding `f` as an ordinary variable. The outer slot for `f` is `externref`
(function types resolve to externref) and is still *uninitialized* when the
closure is built, so the self-capture was boxed into a `__ref_cell_externref`;
the construction prologue then `ref.cast`s that ref-cell to the closure struct,
which fails Wasm validation (`struct.get expected (ref null N) found (ref null
M)`). Named function expressions already routed self-refs through the `__self`
lifted param (index 0); arrow-bound names did not.

**Fix (`src/codegen/closures.ts`, all in `compileArrowAsClosure`):**
1. Detect the **self-binding name** — the arrow is the `initializer` of a
   `const`/`let` `VariableDeclaration` with an identifier name.
2. **Skip capturing** that name (alongside the existing named-funcexpr
   self-skip).
3. Register the name against `__self` (param 0) in the lifted `localMap` and a
   temporary `closureMap` entry whose `structTypeIdx = selfTypeIdx` (the
   `__self` param's *actual* type — the wrapper **base** struct on the
   capture-subtype path, else the specific struct), `funcTypeIdx =
   liftedFuncTypeIdx`. Recursive `f(...)` calls then dispatch via `call_ref`
   through the closure's own struct.
4. Save/restore the outer `closureMap` entry so the temporary self entry does
   not leak into the enclosing scope (where `f` still resolves to its slot).

The `selfTypeIdx`-not-`structTypeIdx` choice is load-bearing: when the
recursive arrow *also captures another variable* (`captures.length > 0`),
`__self` is typed as the wrapper base, not the concrete subtype, so the
funcref `struct.get` must run against the base type. Covered by the
`self-recursive arrow that also captures an outer variable` test.

**Validated** (`tests/issue-2118.test.ts`, 6 cases): const/let factorial → 120,
fib (two self-calls) → 55, self+capture → 48, nested-fn self-recursion → 10,
non-recursive arrow regression guard → 42. Typecheck clean; closure-test sweep
(80 tests across 12 files) green (the `illegal-cast-closures-585` LinkError
failures are a pre-existing test-harness import gap on `upstream/main`,
reproduced identically without this change).

**Mutual recursion deferred to a follow-up (not regressed — never worked).**
`const a = (n)=>b(n-1); const b = (n)=>a(n)` is a distinct *forward-reference*
defect: when `a` is built, the not-yet-declared peer `b` is force-boxed as an
externref ref-cell, but `b`'s closure struct is later stored directly, leaving
two conflicting "box for b" representations → runtime `illegal cast` at the
*construction* site in the outer function. Fixing it cleanly needs the peer
bindings hoisted/typed against a shared wrapper supertype before either
closure is constructed (the architect-level "recursive closure environment
typing" noted under Fix direction). Tracked as a follow-up; acceptance
criterion 2 (mutual pair → 0) intentionally left for that issue.
