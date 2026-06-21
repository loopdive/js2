---
id: 2101b
slug: externref-ancestor-implicit-ctor-fieldinit
title: "standalone: implicit derived ctor on externref-backed subclass skips ancestor field-init (new D().code=0 where A declares the field)"
status: ready
sprint: Backlog
parent: 2101
priority: low
feasibility: hard
reasoning_effort: max
area: codegen
language_feature: classes, error-subclass, construction-abi
goal: standalone-mode
related: [2101, 2188, 1965, 1366a, 1536c]
origin: "2026-06-19 — residual found while landing #2101a R5 (PR #1775). Containment-assessed: deep construction-ABI, NOT a contained fix."
---

## Problem

After #2101a (PR #1775) gave externref-backed Error subclasses an own-field
backing, the DIRECT case works (`class A extends Error { code }; new A().code`)
and a subclass that declares its OWN field + ctor works. But the **inherited**
case still returns 0:

```ts
class A extends Error { code = 0; constructor(m){ super(m); this.code = 42 } }
class D extends A {}                 // implicit derived ctor
new D("z").code                      // → 0  (want 42)
```

## Root cause (containment-assessed — NOT a contained fix)

The implicit derived ctor for an externref-backed subclass
(`class-bodies.ts` ~L1575, the `if (!ctor && isExternrefBacked)` arm) forwards
its synthetic params straight to `__new_<builtinAncestor>(...)` (e.g.
`__new_Error`) and **never runs A's constructor body** — where `this.code = 42`
lives. So `D`'s instance is a fresh `$Error_struct` with `$props == null`, and
`d.code` reads undefined → 0.

Crucially, externref-backed classes have **no `_init` function**: the init-split
(`${className}_init`, which the struct-class implicit ctor at ~L1626 *does* call
via `implicitParentInitIdx`) is explicitly gated OUT for externref-backed
classes (`class-bodies.ts` ~L827, `if (!isExternrefBackedClass) { …register
_init… }`). So there is no `A_init` for `D_new` to call.

Fixing this requires one of:
1. **Build an `_init`-style ABI for externref-backed classes** so `A`'s field
   initializers + ctor body run on a caller-allocated instance, and `D_new`
   calls `A_init(args…, self)`. This is the externref-backed analog of the
   #1965 struct init-split — a construction-ABI change with broad blast radius
   (every externref-backed ctor + super() site).
2. **Re-introduce the inline AST-replay** of ancestor field-inits + mined
   `this.x = …` assignments — explicitly REMOVED for struct classes (#1965,
   class-bodies.ts ~L1623) because it skipped every non-assignment statement of
   the ancestor ctor body. Re-adding it for externref-backed classes would
   re-introduce that latent correctness gap.

Both are deep class-construction-ABI work, beyond the #2101a R5 "own-field
storage rep" scope. The R5 storage rep is CORRECT — once A's body runs, the
field lands in `$props`. The gap is purely that A's body never executes for the
implicit-ctor multi-level case.

## Recommendation

Option 1 (externref-backed `_init` ABI) is the principled fix and dovetails with
the broader #2188 multi-level construction-threading work. Treat as an
architect-scale construction-ABI item, not a dev slice. LOW priority — the
direct + self-declared cases (the common shape) already work via #2101a.

## Repro

`tests/issue-2101a-externref-subclass-ownfield.test.ts` covers the working
cases. The deferred case (commented in #2101a's issue) is:
`class A extends Error { code=0; constructor(m){super(m);this.code=42} } class D
extends A {} ; new D("z").code` → currently 0, want 42.
