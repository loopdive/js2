---
id: 1553
sprint: 52
title: "spec gap: let/const/var destructuring declarations — residuals after #1432/#1450/#1454/#1550"
status: decomposed
created: 2026-05-20
investigated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: declarations, destructuring
goal: spec-completeness
parent: 779
related: [1432, 1450, 1454, 1550]
---
# #1553 — `let`/`const`/`var [pattern] = value` declaration-form destructuring residuals

## Problem

ECMA-262 §14.3 (let/const) and §14.3.2 (var) declaration evaluation uses
`BindingInitialization` with `LexicalEnvironment` / `VariableEnvironment`
respectively. The same algorithm function-decl params use, but the
declaration emitter has its own lowering path in `src/codegen/statements.ts`.

**93 test262 cases** under
`test/language/statements/{let,const,variable}/dstr/` still fail with
`assertion_fail` in the May 2026 baseline, even though the same patterns
in function-decl form (`statements/function/dstr/`) pass.

Top sub-buckets:

| Cluster | Count | Pattern |
| --- | --- | --- |
| `ary-ptrn-elem-*` | 27 | `let [a, b = init] = arr` — init firing or throwing |
| `obj-ptrn-prop-*` | 24 | `let {p: a, q: b} = obj` — property re-key |
| `ary-init-iter-*` | 9 | `let [a] = throwingIter()` — iterator close, get-err |
| `obj-ptrn-id-init-*` | 9 | `let {fn = function(){}} = {}` — fn-name |
| `ary-ptrn-rest-*` | 6 | `let [...rest] = arr` — rest binding |
| `obj-ptrn-rest-getter` | 3 | `let {...rest} = obj` — getter side-effects |
| `obj-init-null` / `obj-init-undefined` | 6 | `let {a} = null` — must TypeError |
| `obj-ptrn-list-err` | 3 | computed key / property eval err propagation |
| `ary-ptrn-empty` | 3 | `let [] = nonIterable` — should observe iterator |
| `ary-ptrn-elision` | 3 | `let [, x] = arr` — elision iter step |

Sample failures:

```js
// statements/variable/dstr/ary-ptrn-elem-id-init-throws.js
var thrown = new Test262Error();
assert.throws(Test262Error, function() {
  var [x = function() { throw thrown; }()] = [];
});

// statements/let/dstr/obj-ptrn-prop-obj-value-undef.js
assert.throws(TypeError, function() {
  let { w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: undefined };
  // Wait, this should NOT throw — w's default fires because w is undefined.
  // The current bug: we still try to destructure `undefined` BEFORE checking
  // the default. So we throw "Cannot destructure undefined" instead of using
  // the default.
});
```

(The second example shows the canonical bug: nested default + property
value `undefined` — default must fire before nested destructure.)

## Failure count

**93** tests across declaration-form `dstr/` folders. Estimated unlock
after fix: ~70 (some are downstream of #1454 iterator-protocol; sibling
issues will absorb those).

## Root cause

`src/codegen/statements.ts` `compileVariableDeclaration` (or similar) emits
a declaration-specific destructure loop instead of delegating to the
shared `destructureParam*` helpers used by function declarations:

1. **No re-use of fix from #1432** — `compileVariableDeclaration` likely
   handles trivial patterns inline and bails to a runtime helper for
   non-trivial ones. The bail-out helper may differ from
   `destructureParamArray`.

2. **Nested default not gated** — for `let {w: {x,y,z} = {x:4,y:5,z:6}} = {w:undefined}`:
   - Outer: read `w` → `undefined`.
   - Inner: default `{x:4,y:5,z:6}` should fire because the value (`undefined`)
     equals undefined.
   - Then destructure `{x:4,y:5,z:6}` into x,y,z.
   We probably try to destructure `undefined` *before* checking the default.

3. **`null`/`undefined` source** — `let {a} = null` must throw `TypeError`
   per §7.3.20 `RequireObjectCoercible`. The current code may produce
   `a = undefined` silently.

4. **`var [x = throwingExpr()] = []`** — when the iterator is exhausted,
   `v = undefined`, default fires, throws — we must propagate the original
   thrown value, not swallow.

5. **`let {fn = function(){}} = {}`** — see #1450 NamedEvaluation.
   Declaration-form may not invoke the helper that #1450 fixes.

6. **`let {...rest} = obj`** — rest binding in declarations uses
   `CopyDataProperties`. Non-enumerable filtering must apply (same bug
   as #1552 catch-rest).

## Acceptance criteria

1. `test/language/statements/let/dstr/obj-ptrn-prop-obj-value-undef.js`
   passes — nested default fires when value is `undefined`.
2. `test/language/statements/variable/dstr/ary-ptrn-elem-id-init-throws.js`
   passes — initializer's thrown value propagates.
3. `test/language/statements/const/dstr/obj-init-null.js` passes —
   destructuring `null` throws `TypeError`.
4. `test/language/statements/let/dstr/obj-ptrn-id-init-fn-name-class.js`
   passes — NamedEvaluation via #1450 also fires for `let` declaration.
5. `test/language/statements/variable/dstr/ary-ptrn-rest-obj-prop-id.js`
   passes — rest with object pattern (cross-check #1432).
6. Declaration-form `assertion_fail` count reduces by **≥ 60**.
7. `tests/issue-1553.test.ts` with one focused case per shape.

## Implementation plan

### Step 1 — locate the declaration destructure emitter

```bash
grep -nR "compileVariableDeclaration\|VariableDeclarator\|destructureDecl" src/codegen
```

Identify whether `let [pattern] = expr` / `var {pattern} = expr` /
`const [pattern] = expr` all share one emitter or diverge.

### Step 2 — delegate to the shared helper

Reuse the **same** `destructureParam*` helpers used by function parameters
and (after #1552) catch clauses. The init value to feed them is just
the RHS of the declarator:

```ts
function compileVariableDeclarator(ctx, decl) {
  if (decl.id.type === 'Identifier') {
    // existing simple path
    return;
  }
  // Pattern path:
  compileExpression(ctx, decl.init);  // pushes externref onto stack
  const rhsLocal = ctx.addLocal('__decl_rhs', 'externref');
  emit(Op.local_set, rhsLocal);
  destructureParam(ctx, decl.id, rhsLocal, { mode: 'decl', kind: decl.kind });
}
```

The `mode: 'decl'` flag may be needed so the helper uses
`InitializeReferencedBinding` vs `PutValue` semantics on the LHS
(matters for `const`).

### Step 3 — null/undefined coercibility check at top

Before invoking the destructure loop on an object pattern, emit:

```wasm
local.get $rhs
call $__require_object_coercible    ;; throws TypeError if null/undef
```

For array patterns, the spec calls `GetIterator(rhs)`, which throws
TypeError if `rhs` is `null`/`undefined` (because there's no @@iterator).
This is automatic if we use the IteratorRecord path from #1454.

### Step 4 — nested-default-before-destructure

When emitting destructuring of an object pattern element where the
**target** is itself a pattern with a default initializer
(`{w: {x,y} = {x:1,y:2}}`), the order MUST be:

1. Read property `w` from RHS → `v`.
2. If `v === undefined` AND initializer is present, evaluate initializer
   → `v`.
3. Then destructure `v` into `{x, y}`.

If step 2 is missing, step 3 receives `undefined` and crashes. Verify
the shared helper does step 2 universally.

### Step 5 — `const` immutability

`const [a, b] = arr` — each `a`, `b` is a `const` binding. Re-assignment
attempts must throw `TypeError`. The shared helper should use
`InitializeReferencedBinding` (writeable=false) for const, vs
`PutValue` for let/var. Verify this binding-kind propagation.

### Step 6 — `tests/issue-1553.test.ts`

```ts
runCases('issue-1553 decl dstr', [
  ['let-obj-default-nested',
   `let { w: { x, y, z } = { x: 1, y: 2, z: 3 } } = { w: undefined };
    JSON.stringify([x,y,z])`, '[1,2,3]'],
  ['var-init-throws',
   `let t='ok';
    try{var [x=(function(){throw 'bang'})()]=[]}catch(e){t=e};t`, 'bang'],
  ['const-null-throws',
   `let kind='none';try{const {a} = null}catch(e){kind=e&&e.name||String(e)};kind`, 'TypeError'],
  ['let-rest',
   `let [a,...rest] = [1,2,3,4]; JSON.stringify([a,rest])`, '[1,[2,3,4]]'],
  ['let-rest-non-enum',
   `let o={a:1};Object.defineProperty(o,'x',{value:9,enumerable:false});
    let {...r}=o; JSON.stringify(r)`, '{"a":1}'],
  ['fn-name-decl',
   `let {fn = function(){}} = {}; fn.name`, 'fn'],
]);
```

## Files to inspect

- `src/codegen/statements.ts` — `compileVariableDeclaration`,
  `compileVariableDeclarator`.
- `src/codegen/destructuring-params.ts` — shared helper.
- `src/codegen/destructuring.ts` (if separate) — declaration-form
  legacy path.
- `src/runtime.ts` — `__require_object_coercible` (add if missing),
  `__copy_data_properties`.

## Dependencies

Most of the unlock here is **ripple from #1450/#1454/#1550** once the
shared helper is the single source of truth. Land those siblings first;
the residual focused fixes for declaration-mode (binding kind, top-level
null/undefined coercibility) are then small.

## Out of scope

- Hoisting semantics for `var` (declaration moves to top of enclosing
  function/script) — separate concern.
- TDZ for `let`/`const` before initialization — already supported.
- For-loop init binding pattern scope — tracked by #1452/#1453.

## Investigation 2026-05-20 (dev-1553) — NEEDS-SPEC

Smoke-tested 6 representative shapes against current main. Confirmed the
issue is bigger than a localized fix: bugs span 5 distinct codegen paths
in `src/codegen/statements/destructuring.ts` plus collateral concerns in
`type-coercion.ts` and `array-methods.ts`. **A targeted single-call-site
patch is not sufficient.**

### Reproductions on current main

| Probe | Source | Current result | Expected |
| --- | --- | --- | --- |
| `let {w:{x,y,z}={x:1,y:2,z:3}}={w:undefined}` (typed struct RHS) | typed path | throws TypeError | x=1,y=2,z=3 |
| `let {w:{x,y,z}={...}} = ({w:undefined} as any)` (externref RHS) | externref path | throws TypeError | x=1,y=2,z=3 |
| `let {w:{x,y,z}={...}} = ({w:null} as any)` | externref path | "no-throw" (silent) | TypeError |
| `let [x = (function(){throw 'bang'})()] = []` | tuple/vec path | x=NaN, no throw | throws 'bang' |
| `let [x = bump()] = [undefined as any]` | vec(f64) path | count=0, x=NaN | count=1, x=42 |
| `let {fn = function(){}} = ({} as any)` | externref path | fn.name = "" | fn.name = "fn" |
| `let {...r} = obj-with-non-enum` | externref rest | excludes wrong props | excludes only non-enum |

### Root causes identified (5 distinct subsystems)

1. **`compileExternrefObjectDestructuringDecl` (destructuring.ts:842-854)** —
   nested ObjectBindingPattern/ArrayBindingPattern branch silently drops
   `element.initializer`. Sister function for arrays at lines 1031-1056
   does handle it. **Partial fix tested**: copying the array branch's
   default check to the object branch lets `(... as any)` cases
   proceed past the null/undef gate, BUT…
2. **`__extern_get` cannot read fields of a WasmGC struct exposed as
   externref** — when the default `{x:1,y:2,z:3}` compiles to a struct
   ref and we `extern.convert_any` + use externref destructure, the
   host import `__extern_get(obj, "x")` returns `undefined` for every
   field because a wasm struct is opaque to JS property access. So
   even after fix (1) lands, the recursive descent into the default
   produces all-undefined bindings. **This is the blocker** — the
   externref helper cannot operate on struct-typed defaults.
3. **`compileObjectDestructuring` typed-struct path (destructuring.ts:509-598)** —
   has no `element.initializer` handling for nested object/array
   patterns at all. Independent of (1)/(2).
4. **`null` RHS on nested element** — `compileExternrefObjectDestructuringDecl`
   has a top-level null guard but no per-element guard for "value is
   null AND target is a binding pattern" — `null !== undefined`, so the
   default does NOT fire; spec requires destructuring `null` → TypeError.
5. **f64-array OOB and `[undefined]`** — `emitBoundsCheckedArrayGet`
   returns the sNaN sentinel for OOB; `emitDefaultValueCheck` matches
   that sentinel. But for `[undefined]` (explicit `undefined` value in
   an `any[]` source), the f64 element gets a *generic* NaN (or 0), not
   the sentinel — so the default never fires. f64 cannot distinguish
   "no value" from "the value was literally undefined".
6. **Vec rest with literal source** (`let [a, ...rest] = [1,2,3,4]`) —
   produced `[1,0]` (rest collapsed to length integer). Likely
   localMap collision: `ensureBindingLocals` pre-allocates `rest` as
   externref, then `allocLocal` at the rest-binding site adds a *second*
   slot with the vec-ref type but later reads pick up the wrong slot.
7. **NamedEvaluation** (#1450) is wired for function params but the
   declaration path doesn't trigger it — `let {fn = function(){}} = {}`
   leaves `fn.name === ""`.
8. **CopyDataProperties for rest** — externref rest binding inverts
   what it includes vs excludes (host `__extern_rest_object` semantics
   suspect; needs cross-check against #1552 catch-rest fix).

### Why a one-call-site fix isn't enough

The issue file's recommendation — "delegate to the shared
`destructureParam*` helpers used by function parameters" — is the right
fix. The current declaration path has its own twin loops (typed-struct
and externref) that have diverged from the param path in:

- Default-on-undefined-OR-null gating
- Default value coercion when default is itself a struct/vec
- NamedEvaluation invocation
- Rest binding enumerable filtering

**Estimated change**: replace ~600 lines in `compileObjectDestructuring` /
`compileExternrefObjectDestructuringDecl` / `compileExternrefArrayDestructuringDecl`
with a thin wrapper that funnels into `destructureParam*` from
`src/codegen/destructuring-params.ts` (~1425 lines, already battle-tested
for params + catch). That helper would need a `mode: 'decl' | 'param' | 'catch'`
flag and a binding-kind hint (`let | const | var`) — likely 50-100 lines
of additions there.

**Files touched (minimum estimate, > 5):**
- `src/codegen/statements/destructuring.ts` (rewrite 3 export funcs)
- `src/codegen/statements/variables.ts` (call new entrypoints)
- `src/codegen/destructuring-params.ts` (add decl mode, NamedEvaluation hook)
- `src/codegen/type-coercion.ts` (default sentinel handling for f64)
- `src/codegen/array-methods.ts` (`emitBoundsCheckedArrayGet` undefined sentinel propagation)
- `src/runtime.ts` (`__require_object_coercible`, `__extern_rest_object`
  enumerable semantics fix if (8) confirmed)
- `tests/issue-1553.test.ts` (new file)

**Recommendation: route to architect** for a step-by-step spec that
sequences the helper merge so it stays under PR-review size. Probable
slicing:

- **1553a**: Add `decl` mode to `destructureParamObject` + null/undef gate
  + thread NamedEvaluation hook. Land first, no behavior change for
  param/catch callers.
- **1553b**: Switch `compileObjectDestructuring` (typed-struct path) to
  call `destructureParamObject({mode:'decl'})`. Deletes ~250 lines.
- **1553c**: Switch externref decl path to same helper. Deletes ~200 lines.
- **1553d**: Same for arrays.
- **1553e**: Fix f64-undefined-in-array sentinel propagation (orthogonal —
  may end up as its own issue).

Each slice should be < 200 LOC delta and individually testable. Attempting
all in one PR would land an unreviewable patch and risk regressions on
the ~1100 currently-passing dstr cases.

## Suspended Work

No partial implementation kept. The single change I prototyped (adding
the nested-default `if` to `compileExternrefObjectDestructuringDecl`)
was reverted because (1) it does not pass any test262 case end-to-end
without the matching fix to default-struct destructure semantics, and
(2) it would mask the real architectural gap.

Worktree `/workspace/.claude/worktrees/issue-1553-dstr-residuals` is
clean (no commits) and can be removed.

## Architect spec 2026-05-20 (arch-1553b) — DECOMPOSED

Confirmed the 5-sub-issue decomposition and wrote per-sub implementation
plans. The slicing follows the dev's investigation but refines bug-to-slice
mapping. Sub-issue files live in `plan/issues/sprints/53/`:

| Sub | Title | Depends | LOC delta | Bugs closed |
| --- | --- | --- | --- | --- |
| **1553a** | Add `decl` mode + `bindingKind` opts to `destructureParamObject`/`Array` helpers (foundation, additive) | — | +150 | (none — plumbing only) |
| **1553b** | Route typed-struct object decl path through helper (decl-mode) | 1553a | −260 | bug 3 (typed nested default), bug 2 partial |
| **1553c** | Route externref-fallback object decl path through helper (decl-mode) | 1553a, 1553b | −130 | bug 1, bug 2, bug 4, bug 8 |
| **1553d** | Route array decl path (typed-vec + externref) through `destructureParamArray` | 1553a, 1553c | −890 | bug 6 (vec rest), array-side bug 4, iter-close |
| **1553e** | f64 array literal with explicit `undefined` must trigger destructuring default | — | +30 | bug 5 (independent of helper) |

### Sequencing

1. **1553a first** — additive, no behaviour change, unblocks everything.
2. **1553b** — smallest behaviour-change PR, validates the decl-mode
   plumbing on the typed-struct lane (lowest risk surface).
3. **1553c** — externref decl object path; closes the "structural
   blocker" (bug 2 — `__extern_get` on WasmGC struct) via the
   helper's `ref.test`+`ref.cast` fast path.
4. **1553d** — array decl paths; largest deletion (~890 LOC), highest
   review burden but most unlock (≥35 test262 cases).
5. **1553e** — orthogonal; can land any time, independent of 1553a-d.

### Total expected unlock

- 1553b: ≥18 cases
- 1553c: ≥24 cases (after #1552 lands)
- 1553d: ≥35 cases
- 1553e: ~8-12 cases
- **Total: ~85-100 case flips**, comfortably meeting the
  acceptance criterion 6 (≥60 case reduction).

Dependency on sibling issues:

- **#1450** (NamedEvaluation): in-review. 1553b/c inherit the fix
  automatically once #1450 lands in main.
- **#1454** (iterator protocol): partially merged. 1553d depends on
  `__array_from_iter` + `__extern_get_idx` host imports being stable.
- **#1552** (catch-rest): in-review. 1553c's rest-binding fix
  consumes the corrected `__extern_rest_object` host semantics
  once #1552 lands.

This issue (#1553) stays `needs-spec` → flip to `status: decomposed`
on merge; close when 1553a-e are all `done` and the test262 delta
on `language/statements/{let,const,variable}/dstr/` is ≥ 60.
