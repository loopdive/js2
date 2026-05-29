---
id: 1719
title: "Array destructuring ignores overridden Array.prototype[Symbol.iterator] ('items[Symbol.iterator] must be a function', 71 fails)"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: destructuring-iterator-protocol
goal: test262-conformance
sprint: Backlog
es_edition: 2015
test262_fail: 71
test262_category: language/expressions, language/statements
related: [1016, 1320, 1021]
---

# #1719 — Array destructuring must use the (possibly overridden) Array iterator (71 fails)

## Problem

71 tests fail with:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

All are `*-iter-val-array-prototype.js` array-destructuring tests across
`language/expressions/{class,object,function,async-generator}/dstr/` and
`language/statements/{class,for,for-of,function,generators}/dstr/`. Each test
overrides `Array.prototype[Symbol.iterator]` (or `Array.prototype.values`) with
a custom generator and asserts that **array destructuring uses the overridden
iterator**.

## Root-cause hypothesis

ArrayAssignmentPattern / ArrayBindingPattern destructuring (§8.5.2
IteratorBindingInitialization / §13.15.5.3 DestructuringAssignmentEvaluation)
must call `GetIterator(rhs)` which reads `rhs[Symbol.iterator]` **dynamically at
runtime**. Our codegen takes a fast static path for array RHS values that
iterates the backing store directly (or calls a fixed `%Array%.from`-style
bridge) and therefore **ignores a user-monkeypatched `Array.prototype[Symbol.
iterator]`**. When the test replaces the prototype iterator with a value the
fast path doesn't recognise, the bridge reports "items[Symbol.iterator] … be a
function" instead of invoking the override.

The fix is to route array destructuring through a real `GetIterator` that reads
the live `@@iterator` method off the value's prototype chain (honouring
overrides), rather than a compile-time-specialised array walk — at least when
the static type cannot prove the prototype iterator is intact.

Spec: [§7.4.2 GetIterator](https://tc39.es/ecma262/#sec-getiterator),
[§8.5.2 IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization).

## Example failing tests

- `test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/statements/class/dstr/meth-static-dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/class/dstr/private-meth-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-val-array-prototype.js`

## Acceptance criteria

- The four example tests pass.
- The `iter-val-array-prototype` cluster drops from 71 to ≤ 10.
- No regression in the broad destructuring fixes (#1016, #1021, #1024, #1025)
  nor in #1320 (Array.from(externref) iterator bridge).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).

## Root cause — confirmed (dev-a, 2026-05-29)

Reproduced. Hypothesis confirmed; exact site pinned to
`compileArrayDestructuring` in `src/codegen/statements/destructuring.ts`.

When the destructuring RHS resolves to a **known vec or tuple struct** (the
common typed-`T[]` case — `resultType` is a `ref`/`ref_null` to a WasmGC vec
struct), control reaches the fast path at **destructuring.ts:862-876** which
stashes the struct ref and delegates to `destructureParamArray(...mode:"decl")`.
That helper walks the WasmGC **backing store directly** (`array.get` / per-field
`struct.get` on the `{length,data}` vec) — it **never calls GetIterator and
never reads `@@iterator`** off the value's prototype chain. So a
module-monkeypatched `Array.prototype[Symbol.iterator]` (or
`Array.prototype.values`) is silently ignored.

Only the **externref branch** (`compileExternrefArrayDestructuringDecl`, used
for `resultType.kind === "externref"` / unknown structs at destructuring.ts:794,
824-827, 849-852) performs a real GetIterator (RequireObjectCoercible +
`@@iterator` + `.next()`, throw-propagating, #1454). The typed-vec/tuple fast
path and the f64/i32-box path go straight to the backing-store walk.

The failing `*-iter-val-array-prototype.js` cases compile their RHS as a typed
array → hit the fast path → override ignored → wrong values or the
`%Array%.from … items[Symbol.iterator] … be a function` bridge error.

### Why this is NOT a localized fix (scope flag → architect)

The fast path is the **hot, common-case** array-destructuring lane shared by
declaration dstr, parameter dstr (`destructureParamArray`), for-of bindings,
and the loop paths. Honouring an overridden prototype iterator needs one of:

1. **Compile-time intactness gate** (preferred): a module pre-scan sets a
   `ctx`-level flag when `Array.prototype[Symbol.iterator]` /
   `Array.prototype.values` is ever assigned (or `Object.defineProperty`'d);
   when set, the vec/tuple fast-path sites coerce to externref and delegate to
   the existing `compileExternrefArrayDestructuringDecl` GetIterator lane.
   Touches `compileArrayDestructuring`, `destructureParamArray`, the param lanes,
   and for-of. Zero perf/behavior change when the flag is clear (the common
   case); full §8.5.2 fidelity when set.
2. **Always GetIterator**: drop the fast path — large perf + behavioral
   regression risk across the dstr suites #1016/#1021/#1024/#1025/#1320
   explicitly guard. Not advisable.

Either is broad codegen-core surgery on the dstr hot path, not a ~1-file change.
Per the dev guardrail this warrants an **architect spec** (precision of the
pre-scan, the for-of interaction, and the perf gate need sign-off before a dev
lands it). Spec refs: §7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization,
§13.15.5.3 DestructuringAssignmentEvaluation.

Repro (worktree `issue-1719-array-dstr-iterator`): override
`Array.prototype[Symbol.iterator]` with a generator yielding a *different* 3rd
value (`42`), then `const [x,y,z] = [1,2,3]` — `z` resolves to the backing
store, not the override. Direct compile confirms the typed-vec fast path is
taken (the externref GetIterator lane is never reached for a typed array RHS).

## Implementation Plan (architect, 2026-05-29)

Approach: **option (a), the compile-time intactness gate**. Option (b)
(always-GetIterator) is rejected — it deletes the WasmGC backing-store fast
path that #1016/#1021/#1024/#1025/#1320 lock in and would re-box every typed
numeric element through externref (the PR #255 NaN-regression pattern).

### Root cause (one line)

`compileArrayDestructuring` (`src/codegen/statements/destructuring.ts:862-876`)
delegates a known vec/tuple struct RHS to `destructureParamArray(...mode:"decl")`,
which walks the WasmGC `{length,data}` backing store with `array.get` and never
calls GetIterator — so a monkeypatched `Array.prototype[Symbol.iterator]` /
`Array.prototype.values` is invisible. Only the externref lane
(`compileExternrefArrayDestructuringDecl`, destructuring.ts:737) runs the real
§7.4.2 GetIterator (RequireObjectCoercible + `@@iterator` + `.next()`, #1454).

### Design: a single conservative module-wide intactness flag

The override is a **per-realm, whole-program** mutation of a shared prototype.
A program either touches `Array.prototype` @@iterator/values or it doesn't;
there is no useful flow-sensitivity (the override can be installed *after* the
dstr site lexically but *before* it executes — see Edge cases). So a single
**module-scoped boolean** on the compile ctx is both correct and sufficient.
When clear (the overwhelmingly common case) every fast path is byte-identical
to today. When set, the vec/tuple/string/numeric fast-path sites coerce to
externref and route to the existing GetIterator lane.

#### 1. New ctx flag

**File: `src/codegen/context/types.ts`** — add to `interface CodegenContext`
(near the other module-wide booleans `hasStringImports` / `hasUnionImports`,
~line 393):

```ts
  /**
   * #1719 — set by the module pre-scan when the program ever writes to
   * Array.prototype's @@iterator (`Array.prototype[Symbol.iterator]`) or its
   * alias `Array.prototype.values`, by assignment or Object.defineProperty.
   * When true, array-destructuring fast paths (vec / tuple / numeric-box /
   * string) must NOT walk the WasmGC backing store directly; they coerce the
   * RHS to externref and delegate to the spec GetIterator lane
   * (compileExternrefArrayDestructuringDecl), which reads the live @@iterator
   * off the prototype chain (§7.4.2 / §8.5.2). Conservative: any write to
   * Array.prototype @@iterator/values sets it; we never try to prove the write
   * is dead or reverted. Clear = today's behavior, zero perf change.
   */
  arrayIteratorMaybeOverridden: boolean;
```

**File: `src/codegen/context/create-context.ts`** — initialize
`arrayIteratorMaybeOverridden: false` in the ctx object literal (alongside the
other boolean defaults).

#### 2. Module pre-scan

**File: `src/codegen/index.ts`** — add a detector modeled exactly on
`sourceContainsClass` (index.ts:173-184), then call it in the compile pipeline
*before any function body is compiled* — i.e. right after
`collectDeclarations(ctx, ast.sourceFile)` at index.ts:907 (single-file path)
and inside the multi-file loop after `collectDeclarations(ctx, sf, isEntry)` at
index.ts:3983 (set the flag if *any* source file matches; it's whole-realm).

```ts
function sourceOverridesArrayIterator(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function isArrayProtoLHS(e: ts.Expression): boolean {
    // Match `Array.prototype[...]` (element access) or `Array.prototype.values`
    // (property access). `e` is the object being assigned INTO.
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const obj = e.expression;
      return (
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === "prototype" &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === "Array"
      );
    }
    return false;
  }
  function walk(node: ts.Node): void {
    if (found) return;
    // (i) assignment:  Array.prototype[Symbol.iterator] = ...  /  Array.prototype.values = ...
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isArrayProtoLHS(node.left)
    ) {
      found = true;
      return;
    }
    // (ii) Object.defineProperty(Array.prototype, ...) / defineProperties
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        (callee.name.text === "defineProperty" || callee.name.text === "defineProperties") &&
        node.arguments.length >= 1 &&
        ts.isPropertyAccessExpression(node.arguments[0]) &&
        node.arguments[0].name.text === "prototype" &&
        ts.isIdentifier(node.arguments[0].expression) &&
        node.arguments[0].expression.text === "Array"
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}
```

Wire-up at index.ts:907 (single-file) — OR with any prior value so multi-pass
callers don't clear it:

```ts
collectDeclarations(ctx, ast.sourceFile);
ctx.arrayIteratorMaybeOverridden ||= sourceOverridesArrayIterator(ast.sourceFile);
```

and analogously inside the multi-file loop (index.ts:3983).

**Conservatism is deliberate.** We do NOT check WHICH computed key is written
(`Symbol.iterator` vs `Symbol.toPrimitive`): matching *any* write to
`Array.prototype[...]` is the cheap, safe over-approximation. The cost of a
false positive is only that one program's array dstr takes the (correct but
slower) GetIterator lane; no behavior is wrong. This also transparently covers
`Array.prototype.values` (the §23.1.3.34 alias that §22.1.3.x makes the default
`@@iterator`), aliased symbol vars (`const it = Symbol.iterator; Array.prototype[it] = …`),
and `Object.defineProperty(Array.prototype, Symbol.iterator, …)`. The matcher
keys on the **LHS object being `Array.prototype`**, not on the key expression,
so all of these collapse to the same signal.

#### 3. Route the fast paths to GetIterator when the flag is set

**File: `src/codegen/statements/destructuring.ts`**, function
`compileArrayDestructuring` (entry at line 766). Insert the gate **immediately
after** the RHS type is known and the trivial non-ref cases are handled — i.e.
right after the `if (resultType.kind !== "ref" && resultType.kind !== "ref_null")`
block closes (after line 816), BEFORE the `typeIdx`/`typeDef` vec/tuple
dispatch at line 818:

```ts
  // #1719 — if the program may have overridden Array.prototype's @@iterator,
  // the WasmGC backing-store fast path below would ignore the override
  // (§7.4.2 GetIterator / §8.5.2 IteratorBindingInitialization). Coerce the
  // value to externref and delegate to the spec GetIterator lane. Strings keep
  // their own path (String.prototype[@@iterator] override is a separate issue;
  // and a string is not an Array, so Array.prototype changes don't affect it).
  if (ctx.arrayIteratorMaybeOverridden && !isStringResultType(ctx, resultType)) {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, { kind: "externref" });
    syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
    return;
  }
```

- `extern.convert_any` is the same coercion already used at destructuring.ts:824
  and :850 for the non-struct / unknown-struct fallbacks — reuse that exact
  instr (it is `as Instr`). `resultType` here is guaranteed `ref`/`ref_null`
  (the non-ref branch returned at 793-815), so `extern.convert_any` is valid.
- `isStringResultType(ctx, resultType)` is the predicate already computed inline
  at destructuring.ts:843-846 as `isStringStruct`. Extract it to a tiny local
  helper (or inline the same three-way `typeIdx === ctx.anyStrTypeIdx || …`
  check) so the gate can skip strings without duplicating logic. Strings must
  keep `compileStringDestructuring` — `Array.prototype` overrides never affect a
  string RHS, and routing a string through the externref array lane would
  regress the string-dstr tests. NOTE: the inline check needs `typeIdx`/`typeDef`
  which are computed at line 818, *below* the proposed gate. Either compute the
  three string typeIdx comparisons directly from `resultType.typeIdx` (cheap, no
  `typeDef` needed) inside the helper, or move the `typeIdx` extraction above the
  gate. Prefer the helper reading `resultType.typeIdx` so the dispatch order at
  818+ is untouched.
- The numeric (`f64`/`i32`) RHS case at destructuring.ts:799-810 already routes
  through `compileExternrefArrayDestructuringDecl` after `__box_number`, so it
  is *already* GetIterator-correct and needs no change. (A boxed number isn't an
  Array anyway, so the override is irrelevant there — but it's harmless.)

**File: `src/codegen/destructuring-params.ts`**, function `destructureParamArray`
(entry at line 799). This is the **parameter / shared** lane (`function f([x,y,z])`,
nested patterns, for-of element patterns). The 71 failures include
`func-expr` / `meth` / `gen-meth` templates that bind through *parameter*
destructuring, so the gate MUST also fire here, not only in the decl entry.

Add the gate at the **top of the `ref`/`ref_null` arm** — i.e. right after the
`isDecl`/`shouldEnsureLetConstFlags` handling (destructuring-params.ts:807-810)
and BEFORE the existing `if (paramType.kind !== "ref" && paramType.kind !==
"ref_null")` externref block. When `ctx.arrayIteratorMaybeOverridden` is set and
`paramType` is a vec/tuple struct ref (not a string struct), stash the struct
ref to a local, convert it to externref, and re-enter `destructureParamArray`
with `paramType = {kind:"externref"}` — which lands in the externref arm
(destructuring-params.ts:816+) that already runs `__array_from_iter_n` →
GetIterator (destructuring-params.ts:976-983):

```ts
  // #1719 — see compileArrayDestructuring. When @@iterator may be overridden,
  // re-enter the externref arm (which materializes via __array_from_iter_n →
  // GetIterator) instead of walking the WasmGC backing store.
  if (
    ctx.arrayIteratorMaybeOverridden &&
    (paramType.kind === "ref" || paramType.kind === "ref_null") &&
    !isStringStructType(ctx, paramType)   // same string-struct predicate as destructuring.ts
  ) {
    const extTmp = allocLocal(fctx, `__dpa_ext_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    fctx.body.push({ op: "local.set", index: extTmp });
    destructureParamArray(ctx, fctx, extTmp, pattern, { kind: "externref" }, opts);
    return;
  }
```

`paramIdx` already holds the struct ref (the caller `local.set`s it before the
call), so `local.get index: paramIdx` + `extern.convert_any` produces the
externref. The recursive call's externref arm does RequireObjectCoercible, the
empty-pattern short-circuit (#1016), tuple-struct detection, `__array_from_iter_n`
materialization (#1150/#1219/#1592), and rest collection — full §8.5.2 fidelity,
reusing battle-tested code. `isStringStructType(ctx, paramType)` is the same
`anyStrTypeIdx`/`nativeStrTypeIdx`/`consStrTypeIdx` predicate as in step 3a;
share one helper across both files (export it from a shared module, or duplicate
the 3-line check — it's tiny).

#### 4. for-of SOURCE iteration — explicitly OUT OF SCOPE for the 71 fails

`for (const x of arr)` source iteration takes a *separate* index-walk fast path
(`compileForOfArrayTentative` → `compileForOfArray`, loops.ts:2510/2538) that
*also* ignores an overridden `Array.prototype[@@iterator]`. **None of the 71
failing tests exercise this** — they are all `dstr/` binding-pattern tests. Do
NOT change `compileForOfArray` in this issue (it risks the #1320 for-of array
walks). File a follow-up (`for-of array source ignores overridden @@iterator`)
gated on the SAME `ctx.arrayIteratorMaybeOverridden` flag: when set, make
`compileForOfArrayTentative` return `false` so the source falls through to the
spec iterator path (`compileForOfIterator`, loops.ts:3367). One-line change,
but keep it separate so this issue's regression surface stays the dstr lane.

The for-of *element* pattern (`for (const [a,b] of pairs)`) destructures each
yielded element via `compileForOfDestructuring`/`destructureParamArray`; those
elements are the per-iteration values, and step 3's `destructureParamArray`
gate already covers them.

### Wasm IR pattern (gate site)

```wasm
;; RHS struct ref is on the stack (or in $paramIdx)
extern.convert_any        ;; anyref/ref -> externref
;; -> compileExternrefArrayDestructuringDecl / externref arm of destructureParamArray:
;;    RequireObjectCoercible, ref @@iterator, __array_from_iter_n (calls .next()),
;;    then per-element bind with defaults / nested / rest
```

### Edge cases

1. **Override installed AFTER the dstr site lexically** (`f([1,2,3]);
   Array.prototype[Symbol.iterator] = …; f([1,2,3]);`) — the module flag is set
   regardless of textual order, so BOTH calls take the GetIterator lane. Correct:
   GetIterator reads the *live* method each call; the first call (before install)
   still sees the intact default `%ArrayIteratorPrototype%` via the runtime
   prototype chain. No flow-sensitivity needed or wanted.
2. **Override inside a function body / conditionally** — the pre-scan walks the
   full tree (`forEachChild` recursion), so a write nested in any function/if/
   loop still trips the flag. Conservative by design.
3. **Per-realm** — js2wasm compiles one realm per module; the flag is realm-wide,
   matching the spec's single shared `Array.prototype`. No cross-realm concern.
4. **`Array.prototype.values` override only** — covered: the LHS-object matcher
   fires on `Array.prototype.values` (property-access form). Per §22.1.3.x the
   default `@@iterator` IS `values`; the GetIterator lane reads the runtime
   `@@iterator` slot, which the host's `Array.prototype` exposes — so routing
   there is correct. The flag's job is only to *leave* the backing-store fast
   path; the runtime then does the spec-correct lookup.
5. **Aliased symbol** (`const S = Symbol.iterator; Array.prototype[S] = …`) —
   covered: matcher keys on the LHS object, not the key.
6. **String RHS** (`const [a,b] = "ab"`) — explicitly skipped by the
   `isStringResultType` / `isStringStructType` guard; `Array.prototype` overrides
   don't affect strings.
7. **Empty pattern** (`const [] = arr` / `function f([]) {}`) — handled by the
   externref arm's `isPatternEmptyOnly` short-circuit (destructuring-params.ts:834),
   preserving #1016 (empty pattern must NOT advance a generator).
8. **for-of decl vs param vs assignment sharing the lane** — decl entry (step 3a)
   and param/for-of-element entry (step 3b) are both gated; for-of *source* is
   out of scope (step 4). Destructuring *assignment* (`[x,y]=arr`) flows through
   the same `destructureParamArray`/externref helpers and inherits the gate.

### Perf / no-regression guard

When `arrayIteratorMaybeOverridden` is `false` (every real-world program and
every test that does NOT monkeypatch the array iterator), both gate `if`s are
skipped and codegen is **byte-identical** to today — verified by the regression
guards below. The pre-scan is one extra `forEachChild` walk per source file at
compile time (same cost class as `sourceContainsClass`), no runtime cost.

### Test set

**Must pass (the 71-fail cluster, all `*-iter-val-array-prototype.js`):**
- `test262/test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test262/test/language/expressions/function/dstr/dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test262/test/language/expressions/arrow-function/dstr/{,dflt-}ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test262/test/language/expressions/async-generator/dstr/{,named-,dflt-,named-dflt-}ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test262/test/language/expressions/class/dstr/{meth,gen-meth,async-gen-meth,private-meth,private-gen-meth}{,-static,-dflt,-static-dflt}-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test262/test/language/statements/{class,for,for-of,function,generators}/dstr/*-iter-val-array-prototype.js`
  (full set: `find test262/test -name '*iter-val-array-prototype*'` → 80 files,
  71 currently failing.)

Acceptance: cluster drops 71 → ≤ 10.

**Regression guards (must NOT flip pass→fail) — the un-monkeypatched fast path:**
- #1016 — empty-pattern / generator-non-advance dstr tests
- #1021, #1024, #1025 — broad array/tuple destructuring suites
- #1320 — `Array.from(externref)` iterator bridge + for-of array walks
- The full `tests/equivalence.test.ts` dstr cases and any `tests/issue-101[0-9]*.test.ts`
- A targeted local probe (in `.tmp/`): `function f([x,y,z]){return z} f([1,2,3])`
  with NO override → must still emit the vec fast path (flag clear) and return `3`.

### Spec citations
- §7.4.2 GetIterator — reads `obj[@@iterator]` dynamically.
- §8.5.2 IteratorBindingInitialization (ArrayBindingPattern) — uses GetIterator.
- §13.15.5.3 DestructuringAssignmentEvaluation — assignment form, same GetIterator.
- §22.1.3.x / §23.1.3.34 — `Array.prototype.values` is the default `@@iterator`.

### Files touched
- `src/codegen/context/types.ts` (+flag)
- `src/codegen/context/create-context.ts` (+init)
- `src/codegen/index.ts` (+pre-scan fn, 2 wire-up sites)
- `src/codegen/statements/destructuring.ts` (gate in `compileArrayDestructuring`)
- `src/codegen/destructuring-params.ts` (gate in `destructureParamArray`)
