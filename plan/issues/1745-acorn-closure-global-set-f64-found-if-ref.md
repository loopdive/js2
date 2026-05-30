---
id: 1745
title: "acorn dogfood: __closure_37 global.set expects f64, found if of (ref null 3) → invalid Wasm"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, closures, type-coercion
language_feature: closures, global-set, conditional-result-coercion
goal: self-hosting-dogfood
sprint: Backlog
parent: 1711
related: [1734, 1725, 1710]
---
# #1745 — acorn closure `global.set` expects f64, finds an `if` of `(ref null 3)` → invalid Wasm

## Problem

The **next** acorn dogfood blocker after #1734 (which cleared the
`__closure_11` unguarded-`struct.get` failure). `compile(acorn.mjs)` still
returns `success=true`, but the emitted binary fails `WebAssembly.compile()`:

```
WebAssembly.compile(): Compiling function #130:"__closure_37" failed:
  global.set[0] expected type f64, found if of type (ref null 3)
  @+210580
```

The whole acorn surface stays gated on this (`binaryValidates:false`, the 5
runtime-AST-diff fixtures stay skipped).

## Root cause (hypothesis — to confirm)

`__closure_37` stores into a module global whose declared type is **f64**, but
the value it computes is the result of an **`if` block** whose result type is
`(ref null 3)` — i.e. a reference, not an f64. So a value that is conditionally
a ref (likely a captured variable's ref-cell / closure struct, type index 3)
is being written into an f64-typed global without coercion.

This is a **conditional-result → global type** coercion gap, distinct from
#1734's struct.get-receiver gap:
  - either the global's declared type (f64) is wrong for what's stored (it
    should be externref / a ref), or
  - the `if`-block result (a ref) must be coerced to f64 (boxed → unboxed, or
    via `__box_number` round-trip) before the `global.set`, and that coercion
    is missing on one arm / the whole block.

Type index 3 is a low/early struct type (likely a ref-cell `struct (field
$value (mut T))` or an early closure/$AnyString-ish type) — confirm which.

## How to reproduce

```bash
# worktree branched off origin/main, WITH the #1734 fix applied/merged
pnpm run dogfood:acorn
# → compile() success=true; WebAssembly.compile() FAILS on
#   __closure_37 global.set[0] expected f64, found if of (ref null 3).
```

A minimal in-repo reducer is part of this issue's work: a closure that writes a
**conditionally-ref value** (e.g. `g = cond ? someRefThing : otherRefThing`)
into a variable/global the compiler typed as f64 — reduce until the
`global.set[0] expected f64, found if` validator error reproduces. Pin as
`tests/issue-1745.test.ts` (compile + `WebAssembly.compile` succeed).

## Acceptance criteria

1. `WebAssembly.compile()` of compiled `acorn.mjs` no longer fails on
   `__closure_37` (the harness advances to the next blocker, if any).
2. The `global.set` operand is well-typed: either the global is declared with
   the right reference type, or the `if`-block result is coerced to f64 before
   the store.
3. A minimal `tests/issue-1745.test.ts` reducer compiles AND validates.
4. No regression in closures / global / coercion buckets or
   `tests/equivalence/`.

## Notes / scope

- Validator offset `@+210580` and function index `#130` are pin-specific
  (acorn 8.16.0); the *symbol* `__closure_37` + the
  `global.set[0] expected f64, found if of (ref null 3)` shape are the stable
  anchors.
- Surfaced by the #1710 dogfood harness immediately after the #1734 fix; this
  is the next acceptance-class (codegen-acceptance / won't-validate) gate on
  the path to #1712.

## Investigation notes (2026-05-30, recon while #1734 PR #966 in CI)

A transient module-wide scan (DBG1745: every `global.set` whose preceding
instr is an `if`) pinned the emit:

```
fn=__closure_37 globalsLen=109 global.set idx=2474 (unresolved)
  after if-result={"kind":"ref_null","typeIdx":3}
  then=[local.get, ref.cast_null]                    ;; → (ref null 3)
  else=[local.get, call, …, array.new_default, …, struct.new]  ;; → a struct ref
```

Findings:
- **Both `if` arms produce reference values** (then: a `ref.cast_null` to type
  3; else: a freshly `struct.new`'d object). So the `if`/conditional result is
  `(ref null 3)` — this is a `cond ? X : Y` (ternary) or `||`/`??` fallthrough
  whose two branches are both refs.
- The destination is a **module global** the codegen declared as **f64**, but
  it receives this ref → ill-typed `global.set`.
- The `idx=2474` printed by the scan is a **pre-finalization** global index
  (only 109 globals exist post-finalize); late/early globals get renumbered at
  emit. The *symbol* anchor is `__closure_37` + the
  `global.set expected f64, found if of (ref null 3)` shape.

**Root-cause hypothesis (to confirm during the fix):** a **closure-captured
variable** whose backing module-global was typed `f64` (the capture-global type
inference picked f64) but whose assigned value is a conditional that resolves to
a reference. Either (a) the capture-global type inference must widen to the
ref/externref type when the captured value can be a ref-producing conditional,
or (b) the conditional result must be coerced to f64 (`__box_number` round-trip
/ unbox) before the `global.set` when the global is genuinely f64. Determine
which by inspecting the source variable acorn assigns here (the ternary whose
arms are `ref.cast_null` vs `struct.new`).

**Likely sites:** closure capture-global declaration/typing in
`src/codegen/closures.ts` (`ctx.mod.globals.push` capture-cell paths ~L335/L356)
and the assignment-coercion path that writes a captured global
(`src/codegen/expressions/assignment.ts` / `identifiers.ts` global-set arm).
Reduce `let x = cond ? refThingA : refThingB; const f = () => { x = ...; };`
with the capture forcing `x` into a module global, until the `global.set
expected f64, found if` error reproduces; pin as `tests/issue-1745.test.ts`.

This is **not** the same family as #1734 (that was a struct.get-receiver guard
in method-call dispatch); #1745 is a capture-global type / conditional-result
coercion mismatch. Independent fix.
