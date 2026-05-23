---
id: 1394
sprint: 52
title: "class method-closure caching: C.prototype.method returns stable singleton closure"
status: done
created: 2026-05-09
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: class, closures
goal: spec-completeness
depends_on: [1388]
---
# #1394 — Class method-closure caching

## Background

PR #305 (regression fix for #1388) deliberately reverted the per-access closure
allocation for `ClassName.prototype.<method>` property access. The original handler
emitted a freshly-allocated closure on every access, breaking method identity:
`c.m === C.prototype.m` returned false (each side returned a different closure ref).
478 tests under `language/{expressions,statements}/class/elements/*` exercise this
via `verifyProperty` and turned pass→fail. The handler was intentionally omitted
at `src/codegen/property-access.ts:1305-1313`, leaving `C.prototype.<method>` to
fall through to the legacy generic externref path (returns null).

## Problem caused by the tradeoff

With `C.prototype.method` returning null, any test that calls:
```ts
const method: any = C.prototype.method;
method([]);          // ← null invocation → silent failure, wrong error
method.call(c, []); // ← via 'this' receiver → may work differently
```
…silently fails instead of throwing the expected TypeError. This affects ~190
class/dstr tests (async-gen, gen, regular method variants) that test TypeError
propagation through method destructuring parameters.

Investigation by dev-1389-2 (2026-05-09): the async-gen destructuring code itself
is correct — `method.call(undefined, [])` throws correctly. The null comes from
`C.prototype.method` returning null, not from any destructuring bug.

## Fix

Implement per-class × per-method singleton closure caching:

1. **Cache structure**: a per-class table (likely a WasmGC array or a
   `struct { ref $closure_N }` allocated once at class-definition time) that maps
   method index → singleton closure ref.

2. **Emission**: when a class is defined, emit `struct.new $MethodN_closure` for
   each method and store in the cache. The cache lives on the class object or a
   parallel module-level GC slot.

3. **Property-access path**: restore the `ClassName.prototype.<method>` handler at
   `src/codegen/property-access.ts:1305-1313` to read from the cache table instead
   of allocating a new closure. This gives stable identity: every access returns the
   same cached ref.

4. **Identity invariant**: `c.m === C.prototype.m` must hold — both sides go through
   the same cache entry (the instance-method fast path can share the cache with the
   prototype path, or the instance path can delegate through the prototype).

5. **Scope**: regular methods, generator methods, async generator methods. Async
   methods also need this — `C.prototype.asyncMeth` has the same identity issue.

## Risk

High — touches class definition codegen and property-access dispatch. Must not
regress the 478 wins from #1388. Run `npm test -- tests/equivalence.test.ts` and
targeted class/elements tests before pushing.

## Expected impact

~190 class/dstr tests (currently failing due to null invocation). Possibly also
unlocks some class/elements descriptor tests that depend on stable prototype method refs.

## Files

- `src/codegen/index.ts` — class definition emission, add cache table allocation
- `src/codegen/property-access.ts` — restore handler at line ~1305, read from cache
- `src/codegen/expressions.ts` — instance method access may also need cache read

## Investigation

Filed from dev-1389-2 investigation of task #41 (2026-05-09). Worktree
`issue-class-dstr-element-null` has .tmp/ probes only, no source changes — can be
reused or discarded for this senior-dev handoff.

## Implementation Plan

### Status snapshot (architect review, 2026-05-20)

Significant work has already landed for #1394 across three commits — do **not**
re-implement from scratch:

- `23bf1c932 feat(#1394)` — introduced `emitCachedMethodClosureAccess` in
  `src/codegen/closures.ts:3063` and the cache map
  `ctx.methodClosureGlobals: Map<string, number>` in
  `src/codegen/context/types.ts:585`.
- `154bcbc43 revert(#1394)` — temporarily dropped the instance-method cache
  because of a key-mismatch regression (`var C = class {…}` patterns).
- `4edc9d357 fix(#1394)` — fixed the root cause: a dual class-registration
  bridge in `src/codegen/declarations.ts:2127–2156` that mirrors the user
  identifier `C` into `classExprNameMap` so the prototype-access path and the
  instance-access path resolve the same synthetic `__anonClass_N` cache key.
  Then re-enabled the instance-method cache at
  `src/codegen/property-access.ts:1954–1982`.

Currently working (verified by `tests/issue-1394.test.ts`):

- `c.m === C.prototype.m` for `class C { m() {} }` ✔
- `c.m === C.prototype.m` for `var C = class { m() {} }` ✔ (dual-reg bridge)
- `C.prototype.m === C.prototype.m` repeated access ✔
- `C.prototype.m` is non-null ✔
- Distinct classes get distinct cache keys ✔ (`A.prototype.m !== B.prototype.m`)

### Remaining gaps (what this issue still owes)

The acceptance criteria above are not fully met. Three observable gaps remain:

1. **Generator / async / async-generator methods** — `tests/issue-1394.test.ts:87`
   is still `it.todo("identity holds across method kinds — deferred to
   dual-reg fix")`. The dual-reg fix is now landed, so this test should be
   activated and **may already pass**; if not, the trampoline shape needs
   per-kind adjustment (see §Changes/B below).
2. **Element-access spelling** — `C['m']` and `C.prototype['m']` do **not** go
   through the cache. `src/codegen/property-access.ts:2686–2691` still emits
   `ref.null.extern` for `ctx.classMethodSet.has(fullName)`, and there is no
   element-access branch for `C.prototype['m']` at all. That breaks
   `C['m'] === C.prototype['m']` and `c['m'] === C.prototype['m']` (both
   spec-required, and exercised by several `class/elements/syntax/*-name-*`
   test262 cases that use computed property names).
3. **Subclass identity** — `class D extends C {}; (new D()).m === C.prototype.m`
   must hold (D inherits `m` from C, so the cache key must resolve to
   `C_m`, not `D_m`). The current instance-access path keys off the static
   type of `c`, which TS narrows to `D`, producing cache key `D_m` (no
   entry) → `funcMap.get("D_m")` returns `undefined` → falls through to the
   null path. This must walk the prototype chain at compile time.

### Root cause for the residual regressions in PR #334's first attempt

Documenting this so the dev avoids re-introducing it:

| Symptom in 2026-05-09 CI (PR #334 v1) | Cause |
|---|---|
| 299 regressions on `class/elements/*` | `c.m` cache key = `__anonClass_0_m`, `C.prototype.m` cache key = `C_m`. Two globals → two externref refs → identity fails. |
| 478 regressions after revert (PR #305) | Proto path returned cached singleton, instance path returned `ref.null.extern`. `null === <cached>` is false → all `verifyProperty(C.prototype, "m", {value: m})` shapes fail. |

The fix in 4edc9d357 normalises the key resolution. **Do not** add new lookups
that bypass `classExprNameMap` — they will reintroduce the mismatch.

### Changes

**A. Activate and harden the cross-method-kind identity test
(`tests/issue-1394.test.ts:87`)**

Replace `it.todo(...)` with a concrete test that covers all four method kinds:

```ts
it("c.m === C.prototype.m across method kinds (regular, gen, async, asyncGen)", async () => {
  const wasm = await compileToWasm(`
    class C {
      m(): number { return 1; }
      *g(): Generator<number> { yield 1; }
      async a(): Promise<number> { return 1; }
      async *ag(): AsyncGenerator<number> { yield 1; }
    }
    export function test(): number {
      const c = new C();
      if (c.m !== C.prototype.m) return 1;
      if (c.g !== C.prototype.g) return 2;
      if (c.a !== C.prototype.a) return 3;
      if (c.ag !== C.prototype.ag) return 4;
      return 0;
    }
  `);
  expect((wasm as any).test()).toBe(0);
});
```

If this passes as-is, great — close the gap by also activating the test in
test262 (`class/elements/*-name-*` shapes will start landing).

If it fails because the trampoline signature is wrong for generators/async,
adjust `emitCachedMethodClosureAccess` (`src/codegen/closures.ts:3063`):

- **Generator methods** (`ctx.generatorFunctions.has(methodName)`) —
  `sig.results` is already `[externref]` (the JS Generator object); the
  trampoline's `call funcIdx` returns externref directly. No code change
  needed; this should just work.
- **Async methods** (`ctx.asyncFunctions.has(methodName)` and NOT in
  `generatorFunctions`) — the method's wasm return type is the unwrapped
  `T` (e.g. `f64`), but a caller invoking `var fn = c.a; fn()` expects a
  `Promise<T>` externref. The existing direct-call site wraps via
  `wrapPromiseResolve` in `src/codegen/expressions.ts:175`. The trampoline
  must do the same when the method is in `asyncFunctions`. Add after the
  trampoline's `{op: "call", funcIdx: methodFuncIdx}` push:

  ```ts
  if (ctx.asyncFunctions.has(methodName)) {
    // T → Promise<T>: convert primitive to externref if needed, then
    // wrap in Promise.resolve. Reuses the same lowering as direct call
    // sites (#919). The wrapper struct's lifted signature must already
    // be (...userParams) -> [externref] for this to be valid.
    emitPromiseResolveWrap(ctx, /*trampolineBody*/ trampolineBody, sig.results[0]);
  }
  ```

  This requires extracting the Promise-wrap emission from `expressions.ts:175`
  (`wrapPromiseResolve`) into a helper that writes into an arbitrary `Instr[]`
  (right now it writes to `fctx.body`). Suggested signature:
  `emitPromiseResolveWrapInto(ctx, instrs: Instr[], valueType: ValType): void`.

  Also: when registering the wrapper struct's `liftedFuncTypeIdx`, results
  must be `[{kind: "externref"}]`, not the unwrapped T — call
  `getOrCreateFuncRefWrapperTypes(ctx, userParams, [{kind: "externref"}])`
  for the async branch.
- **Async-generator methods** — return type is already externref (AsyncGenerator
  object), same as generators. No special handling.

**B. Element-access cache path** (`src/codegen/property-access.ts`)

There are two element-access call sites that need updating to mirror the
property-access spelling:

1. `C['m']` — at line ~2686 in `compileElementAccess` (or
   `compileElementAccessExpression` — whichever handles
   `ClassName[stringKey]`). Currently:

   ```ts
   if (ctx.classMethodSet.has(fullName)) {
     const funcIdx = ctx.funcMap.get(fullName);
     if (funcIdx !== undefined) {
       fctx.body.push({ op: "ref.null.extern" });   // ← replace
       return { kind: "externref" };
     }
   }
   ```

   Replace with the same cached-closure read used at line 1318–1330 for
   `C.method` (static methods) and line 1361–1383 for `C.prototype.method`
   (instance methods). Since `C['m']` without `.prototype` historically
   matched the "Instance method accessed as `ClassName.method` (without
   prototype) — unusual" branch at line 1331–1339, decide whether to:
   - **Preferred:** treat `C['m']` as equivalent to `C.prototype['m']`
     (this matches V8/SpiderMonkey behaviour — `C['m']` on a class with
     an instance method `m` resolves to the prototype slot only when
     `m` is also defined statically; otherwise it returns `undefined`).
     Per the ES spec this is just an `OrdinaryGet` on `C`, so for a
     pure instance method `C['m']` should be `undefined`. Match this by
     keeping the current null return — **no change** to line 2686.
   - **Test against test262** — find at least one test that pins this
     behaviour before changing it.

2. `C.prototype['m']` — at line 2697+ in the
   `ClassName.prototype[key]` block. Today this is wired for accessors only.
   Add a sibling branch that mirrors the property-access path at line
   1361–1383:

   ```ts
   // (#1394) ClassName.prototype['m'] — cached singleton, same key as
   // the dot-form ClassName.prototype.m so identity holds across spellings.
   if (key !== undefined) {
     const methodFullName = `${resolvedClass}_${key}`;
     if (ctx.classMethodSet.has(methodFullName) && !ctx.staticMethodSet.has(methodFullName)) {
       const funcIdx = ctx.funcMap.get(methodFullName);
       const structTypeIdx = ctx.structMap.get(resolvedClass);
       if (funcIdx !== undefined && structTypeIdx !== undefined) {
         if (emitCachedMethodClosureAccess(ctx, fctx, methodFullName, funcIdx, structTypeIdx)) {
           return { kind: "externref" };
         }
       }
     }
   }
   ```

   Place this **after** the existing accessor branch but **before** any
   generic externref fallback. Required so test262
   `class/elements/syntax/valid/grammar-method-named-await.js` etc.
   (computed-name patterns that use bracket access) succeed.

**C. Subclass inheritance — prototype-chain key walk**
(`src/codegen/property-access.ts:1934–1992`)

Today the instance-access path does:

```ts
const typeName = resolveStructNameForExpr(ctx, fctx, expr.expression);  // → "D"
const methodFullName = `${typeName}_${propName}`;                       // → "D_m"
if (ctx.classMethodSet.has(methodFullName)) { … }                       // false
```

For inherited methods this falls through to the null path. Fix: walk the
class extends chain at compile time:

1. Add a helper in `src/codegen/property-access.ts`:
   ```ts
   /** Walk classExtends chain to find the class that owns `methodName`.
    *  Returns the full method name (e.g. "C_m") or undefined. */
   function resolveOwningClassMethod(
     ctx: CodegenContext,
     startClass: string,
     methodName: string,
   ): { owner: string; fullName: string } | undefined {
     let cls: string | undefined = startClass;
     const seen = new Set<string>();
     while (cls && !seen.has(cls)) {
       seen.add(cls);
       const full = `${cls}_${methodName}`;
       if (ctx.classMethodSet.has(full)) return { owner: cls, fullName: full };
       cls = ctx.classExtends.get(cls);   // existing map populated by collectClassDeclaration
     }
     return undefined;
   }
   ```
2. In the instance-method branch (~line 1936), replace
   `const methodFullName = \`${typeName}_${propName}\`` with:
   ```ts
   const ownerInfo = resolveOwningClassMethod(ctx, typeName, propName);
   if (!ownerInfo) /* fall through */;
   const methodFullName = ownerInfo.fullName;
   // structTypeIdx for the trampoline's `this` should be the OWNING
   // class's struct, so the receiver-type matches the method's first
   // param. Otherwise `ref.null <Dstruct>` wouldn't validate against
   // a method declared with `(ref <Cstruct>) -> …`.
   const fullStructTypeIdx = ctx.structMap.get(ownerInfo.owner);
   ```
3. Same change in the prototype-access branch at line 1361–1383: walk
   from the owning class. **But** here the user wrote `C.prototype.m`
   so `className = "C"` is already the lookup root — the chain walk is
   only needed if someone writes `D.prototype.m` for an inherited `m`.

Cache identity: because both `(new D()).m` and `C.prototype.m` resolve to
the same `methodFullName = "C_m"`, both end up at the same cache global.
✔ Identity invariant holds across the chain.

### Wasm IR pattern (for reference — already emitted by
`emitCachedMethodClosureAccess`)

```wasm
;; Lazy-init read of $__method_closure_C_m (externref, mut, init=null)
global.get $__method_closure_C_m
ref.is_null
(if
  (then
    ref.func $__obj_meth_tramp_C_m_cached
    struct.new $__fn_wrap_N            ;; closure struct holding funcref
    extern.convert_any                  ;; → externref
    global.set $__method_closure_C_m
  )
)
global.get $__method_closure_C_m       ;; result on stack
```

### Edge cases

- **Bound methods** (`Function.prototype.bind`) — out of scope. The cache
  stores the *unbound* method closure; `c.m.bind(c)` allocates a new
  externref via the runtime bind path. Identity check `c.m.bind(c) === c.m.bind(c)`
  is **expected to be false** per spec (each `.bind` returns a fresh
  exotic function). No change needed.
- **`super.m`** — out of scope here. `super.m` is compiled as a direct
  call against the parent class method (`src/codegen/expressions/calls.ts`
  super-call branch); it does not go through property-access. Identity
  is observable only when stored: `const f = super.m`. If a test262 case
  surfaces this, file a follow-up — do not block #1394 on it.
- **Computed method names** (`class C { [k]() {} }`) — if `k` is a
  compile-time constant string, `resolveClassMemberName` resolves it and
  the cache works. If `k` is a runtime value, the method is registered
  under whatever name `resolveClassMemberName` returns (`undefined` →
  skipped at class-bodies.ts:302); no cache, no identity invariant —
  this matches the current null-externref legacy behaviour.
- **Re-assignable methods** — `C.prototype.m = newFn` should *replace*
  the cached value (so subsequent `c.m` returns `newFn`). The current
  cache is read-only after first init; mutation of `C.prototype.m` is
  not supported. Out of scope here (separate issue); the cache deliberately
  uses the bare prototype slot model, not a full prototype-object map.
- **Class re-declaration** — multiple sibling `class C {}` blocks in
  the same module produce distinct synthetic names per class node, so
  cache keys don't collide. ✔
- **No host JS dependency** — the cache global lives in Wasm linear
  module state; `emitCachedMethodClosureAccess` emits no imports. Works
  in WASI/standalone mode. ✔ (no fallback needed for dual-mode.)
- **Function-index shifts from `addUnionImports`** — the trampoline is
  registered via `ctx.numImportFuncs + ctx.mod.functions.length`, and
  cache reads use `global.get`. Neither is sensitive to late import
  injection. ✔

### Files to modify

- `src/codegen/closures.ts:3063` — `emitCachedMethodClosureAccess`: add
  the async-promise-wrap branch and the wrapper-struct result-type
  override for async methods.
- `src/codegen/property-access.ts:1934–1992` — instance access: insert
  `resolveOwningClassMethod` walk; use owner's struct type for trampoline.
- `src/codegen/property-access.ts:1361–1383` — prototype access: same walk
  for `D.prototype.m`-where-m-is-inherited.
- `src/codegen/property-access.ts:2697+` — `ClassName.prototype[key]` add
  cached-closure branch mirroring the dot-form spec'd above.
- `src/codegen/expressions.ts:175` — extract `wrapPromiseResolve` body
  into a helper `emitPromiseResolveWrapInto(ctx, instrs, valueType)` so
  the closures trampoline can reuse it.
- `tests/issue-1394.test.ts:87` — replace `it.todo(...)` with the
  cross-method-kind identity test from §Changes/A.
- `tests/issue-1394.test.ts` — add a subclass-inheritance identity test:
  ```ts
  it("inherited method: (new D()).m === C.prototype.m", …)
  ```
- `tests/issue-1394.test.ts` — add an element-access identity test:
  ```ts
  it("C.prototype['m'] === C.prototype.m", …)
  ```

### Verification

```bash
# Targeted
npm test -- tests/issue-1394.test.ts
npm test -- tests/equivalence/issue-1388.test.ts   # must stay green

# Broader (the cache touches a hot path)
npm test -- tests/equivalence.test.ts

# Scoped test262 (CI will validate full run)
pnpm run test:262 -- --categories language/expressions/class language/statements/class
```

### Expected impact

The bulk of the +478 / -120 swing was recovered by 4edc9d357. Remaining
incremental wins from this gap closure:

- ~30–60 tests under `class/elements/syntax/valid/grammar-*-name-*`
  (bracket-access spelling identity).
- ~20–40 tests under `class/extends/*` (inherited-method identity via
  prototype chain).
- ~10–20 async/generator class-method extraction tests
  (`*-as-yield-operand-*`, `*-as-await-operand-*` patterns) that today
  return null externref for the extracted-method-then-invoke shape.

Net estimate: **+60 to +120 test262 passes**.

### Risk

Medium — most plumbing exists and the dual-registration bridge has
settled. New risks:

- Promise-wrap-in-trampoline (async branch) is the only Wasm-IR shape
  change; verify the wrapper-struct result type matches the trampoline's
  emitted return type or it will refuse to validate.
- Prototype-chain walk in the instance branch changes the cache key
  for inherited methods — confirm `ctx.classExtends` is populated for
  every class shape (including `var C = class extends Base {}`) before
  shipping. If it is not, fall back to current behaviour and file the
  population gap as a follow-up.

## Suspended Work

- **PR:** https://github.com/loopdive/js2/pull/410
- **Branch:** `issue-1394-method-closure-caching`
- **Worktree:** `/workspace/.claude/worktrees/issue-1394-method-closure-caching`
- **HEAD:** `e34c6e7937ce34d8bfe13b71fb350d5efea364bd`
- **Status:** ci-wait

### Implemented (committed in e34c6e793)

Closed the three architect-spec'd gaps on top of cache work landed in 4edc9d357:

- **Change A**: `tests/issue-1394.test.ts:87` `it.todo` activated. Cross-kind identity (regular / gen / async / asyncGen) passes as-is — dual-reg bridge from 4edc9d357 was sufficient; no trampoline shape change needed.
- **Change B**: cached-closure branch for `C.prototype[key]` in `src/codegen/property-access.ts` (~line 2719) mirroring the dot-form at 1361–1383. Uses the same `${className}_${key}` cache global → identity holds across spellings.
- **Change C**: instance-access path walks `ctx.classParentMap` to the topmost class owning the same `funcIdx`, so `(new D()).m === C.prototype.m` for inherited methods. Override detection via funcIdx inequality. Uses owner's struct type for the trampoline receiver.

### Tests

- 8/8 in `tests/issue-1394.test.ts` (3 new + 5 existing).
- 27/27 in class-related `tests/equivalence/*-class*` files.
- 7/7 in `tests/equivalence/issue-1388.test.ts` (the test the PR #305 revert protected).
- Pre-existing failures in `tests/classes.test.ts` etc. are unrelated (already failing on main).

### Resume steps

1. Wait for `/workspace/.claude/ci-status/pr-410.json` with matching `head_sha`.
2. Run `/dev-self-merge 410`. **High-risk PR** (touches hot codegen path) — review the regression-bucket breakdown carefully before merging. If MERGE: `GATE_BYPASS=1 gh pr merge 410 --admin --merge`. If ESCALATE: tech-lead.
3. Post-merge cleanup.

### Follow-ups (out of this PR)

- `C['m']` without `.prototype` — spec says `undefined` for instance-only methods; current null fallback matches spec.
- `super.m` extraction identity.
- Async promise-wrap inside the cached trampoline (not needed — cross-kind test passes without it).
