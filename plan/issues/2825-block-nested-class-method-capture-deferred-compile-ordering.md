---
id: 2825
title: "Bug C (class-method half, spec'd): block-nested class compiled eagerly, so captured-globals promotion never fires for an outer block-let"
parent: 2818
related: [2820, 2818, 2826, 2811, 2669, 1672]
status: ready
created: 2026-06-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2015
language_feature: closures
goal: spec-completeness
sprint: current
horizon: m
architect_spec: done
---

# #2825 — Bug C (class-method half): block-nested class compiled eagerly → captured-globals promotion skipped

The actionable, spec'd carve of **#2818** (the class-method context of the
`ary-ptrn-rest-obj-prop-id` block-`let`-capture cluster — the `meth-…` /
`gen-meth-…` / `private-meth-…` members and their `-dflt` / `-static`
variants). Sibling carve: **#2826** (the async/generator CPS-capture half).
Implements #2818's "Direction (for the architect)"; #2818 stays the parent
bucket.

This is a **distinct subsystem** from #2820 / #2826: class methods do not take
lifted leading capture params — they capture an outer local by **promotion to a
`__captured_<name>` global** (`promoteAccessorCapturesToGlobals`). The bug is a
**class-body-compile ordering** defect that makes that promotion never run for a
block-nested class.

## Reproduction (verified on current main, host/gc lane)

```ts
export function test(): number {
  { let s = 42; class C { m(): number { return s; } } return new C().m(); }
}
// => 0   (should be 42)

// arrow inside the method — the method's capture channel never fires at all
export function t3(): number {
  { let s = 42; class C { m(): number { const g = () => s; return g(); } } return new C().m(); }
}
// => 0   (should be 42)
```

Control that **PASSES** (same class at **function scope**, not in a block):

```ts
export function t2(): number {
  let s = 42; class C { m(): number { return s; } } return new C().m();
}                                                       // => 42 ✓
```

(Empirically reproduced via `compileAndInstantiate` on `369f37442cd`: block
variants return `0`, the fn-scope control returns `42`.)

## Root cause (verified)

Class **bodies** are compiled in a pre-pass, `compileClassesFromStatements`
(`src/codegen/declarations.ts:4169`). A class declaration is handled at
`declarations.ts:4181-4193`:

```ts
if (ts.isClassDeclaration(stmt) && stmt.name && !isAmbient) {
  if (insideFunction) {
    ctx.deferredClassBodies.add(stmt.name.text);   // defer → compiled in compileNestedClassDeclaration
  } else {
    compileClassBodies(ctx, stmt, funcByName);     // eager
  }
}
```

The function-body recursion **passes `insideFunction = true`**
(`declarations.ts:4214`). **But the nested-scope recursions drop it** — the block
recursion at `declarations.ts:4222-4223`:

```ts
} else if (ts.isBlock(stmt)) {
  compileClassesFromStatements(stmt.statements);   // ← second arg omitted → insideFunction defaults to FALSE
}
```

and likewise the `if` / `for` / `while` / `switch` / `try` / labeled recursions
(`declarations.ts:4215-4251`). So a class nested in a **block inside a function**
is treated as **NOT** `insideFunction` → its body is compiled **eagerly** in the
pre-pass, at module-compile time, **before** the enclosing function `$test` runs
and before block-`let s` is a promotable local.

Consequences (WAT-confirmed in #2818):

1. The eager body compile resolves `s` against an empty `localMap` → falls to the
   `ref.null.extern` graceful default (`src/codegen/expressions/identifiers.ts`),
   so `$C_m` compiles to `ref.null extern; return` (→ `0` numeric / `null`).
2. `promoteAccessorCapturesToGlobals` (`src/codegen/closures.ts:345`) never runs
   in a context where `s` is a local, so **no** `__captured_s` global and **no**
   `local.get s; global.set __captured_s` sync is emitted in `$test`.
3. When `$test` is later compiled and `compileStatement` reaches `class C`,
   `compileNestedClassDeclaration` (`nested-declarations.ts:82`) **early-returns**
   at lines 99-106 because `structMap.has("C") && !isDeferred` (C was collected
   *and* eagerly compiled, and never added to `deferredClassBodies`), so the
   promotion loop (`nested-declarations.ts:125-138`) + `compileClassBodies`
   (line 147) at the textual, in-scope position are skipped.

The fn-scope control passes because the class is a **direct** function-body
statement → reached with `insideFunction = true` → **deferred** → promotion runs
at the textual position, after `let s`, with `s` in `localMap`.

Note the COLLECTION pass `collectClassesFromStatements`
(`declarations.ts:2986`) recurses into blocks too (line 3024) and *does* register
the struct + method stubs up-front — that part is correct and must stay; only
the **body-compile timing** is wrong.

## Implementation Plan

### Fix — defer block-nested class bodies (propagate `insideFunction`)

Treat a class nested in any control-flow scope **inside a function** exactly like
a direct function-body class: defer it to `compileNestedClassDeclaration`, which
runs at the textual position (after `let s`) where promotion can see the local.

**File: `src/codegen/declarations.ts`**, function `compileClassesFromStatements`
(line 4169): propagate the current `insideFunction` value through every
nested-scope recursion that currently drops it:

- `ts.isBlock` (line 4223): `compileClassesFromStatements(stmt.statements, insideFunction)`
- `if` then/else (lines 4217, 4220)
- `for` / `for-in` / `for-of` / `while` / `do` body block (line 4233)
- `switch` clause statements (line 4237)
- `try` / `catch` / `finally` blocks (lines 4240, 4242, 4245)
- labeled-statement block (line 4249)

Each must forward the **current** `insideFunction` (not a hardcoded `true`): a
**top-level** (module) block must stay `insideFunction = false` so its class is
still compiled eagerly (no enclosing fctx exists to defer into). The
function-decl recursion at line 4214 and the arrow/fn-expr recursions in
`compileClassesFromFunctionBody` (lines 4258-4269) already pass `true` — leave
them.

With this, a block-nested-in-function class is added to `deferredClassBodies`;
`compileNestedClassDeclaration` then takes the `isDeferred === true` path (skips
the 99-106 early-return), runs the promotion loop (125-138) with `s` live in
`localMap` → emits `__captured_s` + the `local.get s; global.set` sync in
`$test`, and `compileClassBodies` (147) compiles `$C_m` to read
`global.get __captured_s`. Method, and any arrow inside it, both resolve `s`.

### Why this is the right lever (vs. patching the early-return)

The alternative (#2818 candidate 2: run `promoteAccessorCapturesToGlobals` on
the `structMap.has` early-return path) would have to **re-compile** an already-
emitted `ref.null` method body — messy and duplicative. Deferral reuses the
**existing, proven** mechanism that already makes direct-function-body classes
work; it changes *when* the body is compiled, not *how*.

### Edge cases

- **Reachability of the deferred body**: deferral compiles the body only when
  `compileStatement` reaches the class declaration during function compilation.
  `compileStatement` visits **every** statement of every block (it does not skip
  on runtime conditions — both `if` arms, loop bodies, etc. are compiled), and
  direct-function-body classes already rely on this guarantee, so the
  reachability profile is identical. **Risk to verify**: a block-nested class
  whose enclosing function is itself *never compiled* (dead/uncalled nested fn)
  was eagerly compiled before and would now be deferred-and-unreached → its
  method stub (created in the collection pass) would have no body. Confirm such
  shapes either still get compiled or are harmless (validate full CI; if a gap
  appears, add a post-pass sweep that `compileClassBodies` any name left in
  `deferredClassBodies`).
- **`-dflt`** (param-default initializers referencing the outer local, e.g.
  `m(x = s) {}`): already covered — the promotion loop scans `member.parameters`
  initializers via the `paramInits` `extraNodes` arg
  (`nested-declarations.ts:127-136`, `closures.ts:359-365`).
- **`-static` / generator / async-generator / private methods**: the promotion
  loop currently handles `MethodDeclaration` / `Constructor` / get/set accessors
  (`nested-declarations.ts:125-137`). Verify static + private + `*`/`async *`
  method members are included (they are `MethodDeclaration` nodes; private uses a
  `PrivateIdentifier` name but is still a method). Extend the member filter if a
  generator/async-generator/static/private member is missed.
- **Mutable vs immutable capture / #1672 stale-global-sync**: if the method
  observes a *later* write to `s`, the promoted global must be re-synced. This is
  the #1672 stale-`__captured_<name>` hazard. With deferral the initial
  `local.get s; global.set` is emitted **after** `let s`'s store (correct
  initial value); for subsequent mutation, follow the existing
  `wasCapturedGlobalBefore` re-sync pattern in
  `variables.ts` (the `(#1672)` block) so writes to `s` after the class
  declaration also update the global.
- **TDZ**: a `let`/`const` read before init promotes its `__tdz_<name>` flag to a
  global too (`closures.ts:426-448`). Because deferral runs promotion *after*
  `let s` initialised, the common case is "already initialised"; preserve the TDZ
  flag promotion for the read-before-init shape (block-nested class whose method
  is invoked while `s` is still in TDZ).
- **Same-named classes in sibling blocks** (`{ class C {} } { class C {} }`):
  `structMap` / `deferredClassBodies` are name-keyed, so the second `C`'s deferral
  is consumed by the first's `delete` — a **pre-existing** name-collision
  limitation, not introduced here; note it but it is out of scope.
- **Module-top-level block** (`{ let s; class C { m(){return s;} } }` at module
  scope): stays `insideFunction = false` → eager, unchanged by this fix. The
  block-`let` is a module global there, a different channel; track separately if
  the cluster needs it (the test262 cluster wraps in functions, so this fix
  covers it).

### Scoped repro / acceptance

Add `tests/issue-2825.test.ts`:

- `test` and `t3` (arrow-in-method) above return **42** (and a string variant
  returns the captured string).
- Control `t2` (fn-scope class) still returns 42.
- `-static`, generator-method, and private-method variants of the block-nested
  capture return the captured value.
- A `-dflt` variant (`m(x = s) { return x; }`) returns 42.
- fn-scope accessor-capture regression control (#1672) unchanged.

### test262 paths this unblocks (conformance target)

The class-method members of the `ary-ptrn-rest-obj-prop-id` cluster (and the
broader block-nested-class-method-capture class), e.g. the `meth-…` /
`gen-meth-…` / `private-meth-…` (+ `-dflt` / `-static`) dstr members where the
method reads an outer block-scoped `let`. (The cluster is dominated by these
members per #2818.)

### Full-merge_group regression guard (REQUIRED)

Changing class-body-compile *timing* is broad-impact. **Validate on full CI /
`merge_group`, not a scoped sweep** (per project policy for broad-impact codegen
ordering changes). Watch specifically for:

- fn-scope class-method / accessor capture (#1672) — must stay green,
- any class nested in a loop / `if` / `try` whose body previously compiled
  eagerly (now deferred) — confirm no `class-body` / missing-method regressions,
- the standalone floor (object-identity / native-equality) is unaffected (this
  is purely a host/gc class-body ordering change), but confirm on merge_group
  since the floor only runs there.

## Dependencies

- **In-lane** (class-collection ordering + captured-globals promotion;
  `declarations.ts` / `nested-declarations.ts` / `closures.ts`). **No** overlap
  with #2820 / #2826 (those touch `variables.ts` slot reuse and
  `nestedFuncCaptures` leading-param capture — disjoint files/mechanism), so this
  composes cleanly with both.
- No dependency on the parallel substrate work ($Object dynamic reader /
  any-receiver dispatch / host-`calls.ts` / acorn / NM). Captured-globals
  promotion is a closures/codegen-ordering concern.

## Acceptance criteria

- `{ let s=42; class C { m(){ return s; } } new C().m(); }` returns 42 (string +
  numeric), and the arrow-inside-method variant too.
- `meth-…` / `gen-meth-…` / `private-meth-…` (+ `-dflt` / `-static`) cluster
  members return pass.
- No regression in fn-scope class-method/accessor capture (#1672), the #2820
  function-declaration fix, or TDZ throws — on full merge_group.
