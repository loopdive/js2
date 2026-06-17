---
id: 2023
title: "new.target compiles to constant i32 1 — identity comparisons (new.target === A) always wrong"
status: done
completed: 2026-06-17
assignee: sendev-recur
sprint: 63
created: 2026-06-10
updated: 2026-06-17
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [189, 1366]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2023 — new.target is a truthiness stub

## Problem

```ts
class A { tag: string; constructor() { this.tag = new.target === A ? "direct" : "sub"; } }
class B extends A {}
new A().tag + "|" + new B().tag
// wasm: "sub|sub"   node: "direct|sub"
```

## Root cause

`src/codegen/expressions.ts:1209-1217` — inside any constructor
`new.target` lowers to `i32.const 1` (truthiness stub introduced by #189
to clear compile errors), so identity comparisons and propagation through
super chains are wrong. class-bodies.ts:2008 notes newTarget-threading
"deferred to #1366b/c".

## Fix direction

Thread a constructor-identity parameter through ctor calls (set at the
`new` site, forwarded by super()) — a class-id i32 is enough for `===`
against statically known classes. Function-call (non-new) invocation
should yield undefined.

## Acceptance criteria

- Repro matches Node through super chains
- `new.target` truthiness uses unchanged

## Dupe check

#189 done (introduced the stub); #538 older. Wrong-value semantics not
filed; nearest live anchor #1366. New.

## Implementation notes (#2023, sendev-recur, 2026-06-17)

**Root cause (confirmed).** `new.target` lowered to `i32.const 1` inside any
constructor (the #189 truthiness stub). The same class body is compiled *once*
and reused both for `new C()` and for the `super()` path of a subclass, so the
value genuinely varies at runtime — there is no per-constructor constant. A
purely static fold cannot express this; a runtime carry is required.

**Design — compile-away runtime carry (no host import, no signature churn).**
A single mutable i32 module global `__new_target_classid` holds the class-id of
the class named at the *outermost* `new` site:
- each local class gets a stable 1-based i32 id (`classNewTargetIds`);
- `new C(...)` sites (legacy `compileNewExpression`, struct path) save the
  previous global into a temp, set it to `C`'s id *after* args are on the stack
  but *before* the `_new` call, then restore the saved value after the call —
  so a nested `new` inside a ctor body nests correctly;
- `super(...)` lowers to a direct `_init` call and deliberately never touches
  the global, so the derived-most id survives the whole super chain;
- the `new.target` expression inside a ctor reads the global (i32, non-zero ⇒
  truthiness uses unchanged); `new.target === SomeClass` lowers in
  `compileBinaryExpression` to an i32 compare against the class id *before*
  operands compile (a bare class identifier does not lower to a value).

**Gated on `usesNewTarget`** (a cheap one-shot AST pre-scan in `generateModule`/
`generateMultiModule`). When false — the overwhelming common case — none of the
machinery is emitted and class call sites are byte-for-byte unchanged.

**IR interaction.** The IR `new`-expression lowering does not thread the id, so
when `usesNewTarget` is set, the IR function selection is emptied and every
function compiles via legacy (which carries the threading). new.target is rare,
so the throughput cost is negligible; this avoids a parallel IR implementation.

**Files:** `src/codegen/new-target.ts` (new — scan, id registry, global,
emitters), `src/codegen/expressions.ts` (read in ctor), `src/codegen/
binary-ops.ts` (`new.target === Class` compare), `src/codegen/expressions/
new-super.ts` (save/set/restore at new sites), `src/codegen/class-bodies.ts`
(id assignment), `src/codegen/index.ts` (pre-scan + IR gate), `src/codegen/
registry/imports.ts` (global-index fixup), context type + create-context.

**Tests:** `tests/issue-2023.test.ts` — identity through 3-level super chains,
truthiness, nested `new` in a ctor body (restore correctness), outside-ctor
falsy, named-funcexpr self-recursion control unregressed.

**Not in scope:** mutual/self-recursive const-arrow closures (#2118, separate).
