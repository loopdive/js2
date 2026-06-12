---
id: 2110
renumbered_from: 1951
title: "self/mutually-recursive const-arrow closures emit invalid Wasm (struct.get type mismatch) or runtime ref.cast traps"
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
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

# #2110 — `const f = (n) => ... f(n-1)` produces an invalid module

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

## Closed as duplicate (2026-06-12)

Duplicate of #2118 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2118.
