---
id: 1387
sprint: 52
title: "feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies"
status: spec-ready
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, ir
language_feature: with
goal: spec-completeness
---
# #1387 — `with` statement: architect exploration

## Background

`with` is currently in the test262 skip list and emits `CE: Unsupported statement: WithStatement`
(294 tests). The statement has been avoided because it creates dynamic scope — any bare identifier
inside a `with(obj){}` block may refer to a property of `obj`, defeating static type analysis and
WasmGC typed struct emission.

However, the user has asked for an architect exploration: **how can we implement `with` nonetheless?**
If a fully static path is not possible, an IR-dependent or externref-fallback path may be acceptable.

## What `with` does (spec §14.11)

```js
with (expression) statement
```

1. Evaluate `expression` → get object `obj`.
2. Push `obj` onto the lexical environment chain.
3. Execute `statement` with identifier resolution checking `obj`'s properties first.
4. Pop `obj` from the chain.

Key invariant: any read/write of an identifier `x` inside the body must first check
`Object.prototype.hasOwnProperty.call(obj, x)` (or `x in obj`) before falling through to the
outer scope. This means identifier access is **not statically resolvable** inside a `with` body.

## Why this is hard for a WasmGC compiler

Normal compilation assigns each local variable to a typed Wasm local (`local.get $x`). Inside a
`with` body, `x` might be `obj.x` or the local `x` depending on runtime state. A static compiler
must either:

- Compile the entire `with` body in a "slow mode" where every identifier read/write goes through
  a dynamic dispatch, OR
- Refuse to handle the case statically and fall back to an interpreter path.

## Possible approaches for the architect to evaluate

### A — Pure externref slow-path body

Compile the `with` body with all variables accessed via `__extern_get` / `__extern_set` on a
runtime scope chain. The body emits no typed locals for variables that might be shadowed by `obj`.

Requires a runtime scope-chain object: `{ obj, outer }` threaded through the body. Every
identifier read becomes:

```
if (obj hasOwn x) return obj.x
else return outer lookup x
```

Expensive but correct for the common case (`with(document){}`, `with(Math){}`).

**IR connection**: the IR path already emits `externref`-typed code for opaque objects. A `with`
body could be compiled with all ambient variables boxed as `externref`, which the IR integrates
naturally for its existing externref functions.

### B — Static analysis for non-overlapping names

If the body of `with` uses no identifiers that could plausibly be properties of `obj` (e.g., all
local variables in the `with` body are uniquely named and `obj`'s type is known to be a plain
`{}` with no matching keys), fall back to normal compilation. This is a narrower but zero-overhead
fast path.

### C — Desugar to a closure call

Transform:
```js
with (obj) { stmt }
```
into:
```js
(function(__scope__) { with(__scope__) { stmt } }).call(obj);
```
Then compile the inner function body in "dynamic receiver" mode using the IR's existing
`this`-access patterns. Less general but reuses existing infrastructure.

### D — WASI / standalone mode: flat rejection + strict-mode CE

In standalone mode (no JS host), `with` is rejected with a clean compile error explaining
strict mode incompatibility. In JS-host mode, the approaches above apply.

### E — Delegate to JS host for `with` bodies

Emit the `with` body as a JS string template and invoke it via `__eval_with_scope` host import.
Only viable in JS-host mode; defeats standalone goals. Last resort.

## Acceptance criteria for the architect spec

1. Evaluate approaches A–E above (and any others). Identify which are feasible in the current
   architecture and at what cost.
2. For the most viable approach, write a concrete implementation plan:
   - Which files change (`src/codegen/statements.ts` for the `with` emitter, etc.)
   - What new runtime infrastructure is needed (scope-chain struct, imports)
   - How to lift the skip filter in `tests/test262-runner.ts`
3. Estimate test262 yield (currently 294 CE → target: most passing or skip→pass).
4. Flag if the implementation requires IR path dependency and why.

## Related

- `with` skip filter: `tests/test262-runner.ts` (grep `WithStatement` or `with`)
- Eval skip (similar dynamic-scope problem): `plan/issues/wont-fix/1262-eval-static-string-compile-time.md`
- IR externref path: `src/ir/`
- CLAUDE.md architecture principle: "compile away, don't emulate — resolve JS semantics statically"
  — `with` may require a principled exception to this rule for the body scope lookup.

---

## Implementation Plan (architect, 2026-05-20)

### 0. Summary / chosen strategy

**Hybrid A + B**, JS-host-only.

- **B (static fast-path), enabled by default**: when a syntactic walk of the
  `with` body finds **zero free identifiers** whose name could plausibly be a
  property of `obj` (a name that is not a binding of an enclosing lexical
  scope), compile the body as if the `with` were a plain block. Zero overhead,
  spec-correct for that case.
- **A (dynamic slow-path)**: for every other `with` body, emit a runtime
  property probe at each free-identifier read/write site:
  `__with_lookup(scope, "name")` → returns either the externref value from
  `scope` (when `HasBinding` is true after the `@@unscopables` filter) or the
  sentinel `__WITH_MISS` for "not present, fall through to outer scope".
- **C/D/E rejected** for now (rationale below).

This compiles `with` end-to-end in JS-host mode (`--target js`), gives a clear
"compile error: `with` requires JS host" in WASI / standalone mode (D), and
preserves the *strict-mode parse error* path that's already wired in
`src/compiler/validation.ts:657`.

### 0a. Why A+B and not C, D, E alone

| Approach | Verdict | Why |
|---|---|---|
| **A (pure dynamic)** | ✅ Used as fallback | Spec-correct, covers all 174 noStrict tests including the `delete this.x`-mid-`with` reference-stability tests. Cost per identifier ~ one host call, acceptable for a sloppy-mode legacy feature. |
| **B (static no-overlap)** | ✅ Used as fast path | Zero runtime cost when the analyzer proves no shadowing. Common case for hand-rolled `with(Math)` style. |
| **C (desugar to `(function(scope){…}).call(obj)`)** | ❌ Rejected | Doesn't actually solve the lookup problem — inside the function body we still need dynamic dispatch on `scope`'s properties. Just renames the problem and breaks `var` hoisting / `this` capture. |
| **D (flat rejection in standalone)** | ✅ Adopted as the WASI/--target wasi branch of A | A `with` body in standalone mode has no host to call `__extern_get` against. Emit the existing `Unsupported statement` CE message but with a clearer "with requires --target js" reason. |
| **E (delegate body to JS host)** | ❌ Rejected | Would require source-level reflection of the `with` body, defeats every benefit of WasmGC compilation, and is a bigger maintenance liability than A. |

### 1. Test-yield estimate

| Source | Tests CE today (`Unsupported statement: WithStatement`) | Expected post-implementation |
|---|---:|---:|
| `language/statements/with/` — dedicated suite, ~174 noStrict + 7 strict negatives | 155 (some hit later CE before WithStatement) | ~150 pass + 7 already-passing strict-negative parse tests |
| `language/expressions/compound-assignment/` (assignment-semantics through `with`) | 44 | ~40 pass |
| `language/statements/function/` — function declarations inside `with` | 14 | ~12 pass |
| `built-ins/Proxy/has/` — Proxy traps via `with` | 9 | needs Proxy; expect to remain CE/FAIL (not blocked by this issue) |
| `language/expressions/{prefix,postfix}-{in,de}crement` + `compound-assignment` + `assignment` + `delete` through `with` LHS | ~20 | ~15 pass |
| Other (dynamic-import, async generators, etc. that happen to embed `with`) | ~50 | mixed — these CE for other reasons too; expect modest gains (~10–15 pass) |
| **Total** | **294 CE** | **~225–240 pass, remainder still CE/FAIL for unrelated reasons** |

Conservative regression-gate target: **+200 net pass** on test262 after this lands.

### 2. Files changed

#### 2a. New file `src/codegen/statements/with-statement.ts` (~250 LOC)

The compiler for `WithStatement`. Exposes:

```ts
export function compileWithStatement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.WithStatement,
): void;
```

It does:

1. **Standalone gate**. If `ctx.options.target === "wasi"` or
   `ctx.options.standalone === true`, call
   `reportError(ctx, stmt, "with statement requires JS host (--target js); see #1387")`
   and return.
2. Compile `stmt.expression` → externref (use `coerceType` if needed); store in
   a fresh local `__with_scope_<depth>` (allocated via `allocLocal`).
3. **Static fast-path probe** (approach B): call a new helper
   `analyzeWithBodyShadowing(ctx, fctx, stmt.statement)` which returns
   `{ kind: "static" } | { kind: "dynamic", freeIdents: Set<string> }`. The
   analyzer walks the body collecting every `ts.Identifier` that
   (a) is a free reference (i.e. `ctx.checker.getSymbolAtLocation` returns
   nothing, OR returns a symbol declared outside the body's lexical scope), and
   (b) is in an expression / assignment / update / delete / typeof position,
   not a declaration name, label, or member-access RHS. If the set is empty:
   - Push the with-scope local onto `fctx.withScopeStack` (see §2b).
   - Compile the body via `compileStatement` exactly as today.
   - Pop the stack.
   - Done. No runtime overhead — fast-path.
4. **Dynamic slow-path** (approach A):
   - Push the with-scope local index onto `fctx.withScopeStack`.
   - Push the set of free identifiers onto a parallel
     `fctx.withFreeIdentsStack` so `compileIdentifier` / `compileAssignment`
     can cheaply test "is this name a candidate for `with` interception in the
     current scope?".
   - `compileStatement(ctx, fctx, stmt.statement)` — the body emitters now
     consult the with-stack (see §2c).
   - Pop both stacks.
5. **Block-scoped name save/restore**: `with` does not introduce its own
   lexical environment for `let`/`const` inside the body — the body is a
   normal `Block`. The existing `saveBlockScopedShadows` mechanism in
   `compileStatement` already handles that, so reuse the block compilation
   path inside compileWithStatement instead of iterating statements ourselves.

#### 2b. Modify `src/codegen/context/types.ts`

Add to `FunctionContext` (around line 165, with the other narrowing fields):

```ts
/**
 * (#1387) Stack of local indices holding the externref `obj` for each
 * lexically-enclosing `with (obj)` block. Innermost = last element.
 * Empty/undefined when not inside any `with`. Consulted by
 * compileIdentifier / compileAssignment to gate the runtime property probe.
 */
withScopeStack?: number[];
/**
 * (#1387) Parallel to `withScopeStack`: each entry is the set of free
 * identifier names in that with-body that the static analyzer flagged as
 * "needs runtime probe". An identifier read whose name is NOT in any
 * scope's set can skip the probe entirely (we proved it can't shadow).
 * Innermost = last element.
 */
withFreeIdentsStack?: Set<string>[];
```

Init both in every `FunctionContext` constructor site — grep for
`labelMap: new Map()` (every place that creates one needs both new fields
omitted, since they're optional, but if you find any other narrowing fields
being explicitly defaulted to `new Set()`, mirror that pattern).

#### 2c. Modify `src/codegen/expressions/identifiers.ts`

Function `compileIdentifier` (line 326). At the very top, BEFORE the
string-builder check, insert a `with`-scope probe:

```ts
// (#1387) `with` dynamic scope: if we're inside any `with (obj)` block and
// this identifier is a free reference (not a static local in the body),
// dispatch through __with_lookup which tries every enclosing scope object
// in reverse order and falls through to the static binding on miss.
if (fctx.withScopeStack && fctx.withScopeStack.length > 0) {
  if (identifierNeedsWithProbe(fctx, name)) {
    return emitWithLookupRead(ctx, fctx, id, name);
  }
}
```

Add helper `identifierNeedsWithProbe(fctx, name)`: returns true iff `name` is
present in any of the per-with `withFreeIdentsStack` sets. (Fast — Set.has on
a usually-small set.)

Add helper `emitWithLookupRead(ctx, fctx, id, name)`:
- Push the with-scope local for each enclosing `with`, innermost-first, as an
  externref (or null sentinel via `ref.null.extern` for "no more scopes" — see
  §3 for the runtime convention; in v1 we pass only the innermost and let
  miss-fall-through to outer scopes happen by recursive emit, see below).
- For multiple stacked `with`s the simplest correct codegen is to nest:
  emit `__with_lookup(innermost, name, /*fallback closure*/ ...)`. To avoid
  function-pointer fallbacks (we don't want to spawn a closure per ident),
  expand the chain at compile time:
  ```wasm
  ;; pseudocode for `with(a) with(b) { x }` with innermost = b
  local.get $__with_scope_b
  global.get $__strconst_x
  call $__with_has        ;; returns 1 if b has own x (post-unscopables)
  if (result externref)
    local.get $__with_scope_b
    global.get $__strconst_x
    call $__extern_get
  else
    local.get $__with_scope_a
    global.get $__strconst_x
    call $__with_has
    if (result externref)
      local.get $__with_scope_a
      global.get $__strconst_x
      call $__extern_get
    else
      ;; original identifier lookup fallthrough
      <emit normal compileIdentifier body for name>
    end
  end
  ```
- The "normal compileIdentifier body" for the fallthrough is implemented by
  *temporarily* clearing `fctx.withScopeStack` to `[]`, recursively calling
  `compileIdentifier`, then restoring it. (Same trick the boxedCaptures path
  could use — straightforward.)
- Result type: always `externref` for the dynamic path. Caller sites that
  expect f64 (e.g. arithmetic) will go through the existing
  externref→f64 coercion in `coerceType`.

#### 2d. Modify `src/codegen/expressions/assignment.ts`

Function `compileAssignment` (line 86). After the `ts.isIdentifier(expr.left)`
check enters (line 99) and before the `constBindings` check (line 102),
insert the symmetric write-side probe:

```ts
if (fctx.withScopeStack && fctx.withScopeStack.length > 0
    && identifierNeedsWithProbe(fctx, expr.left.text)) {
  return emitWithLookupWrite(ctx, fctx, expr);
}
```

`emitWithLookupWrite`:
- Evaluate `expr.right` once into a temp local (externref).
- Walk the `withScopeStack` from innermost to outermost; for each, emit
  `__with_has(scope_i, name)` and, on true, emit
  `__extern_set(scope_i, name, value)` and produce the value.
- On miss in all scopes, fall through to the normal identifier-assignment
  path (recursively, with the stack temporarily cleared).
- Compound assignment (`x ^= 3` from the spec test above) flows through
  `compileCompoundAssignment` which itself calls `compileAssignment` for the
  store leg; no separate change needed there *as long as* the read leg also
  routes through `emitWithLookupRead` (which it does — read uses
  compileIdentifier).
- **Reference-stability subtlety** (S11.13.2_A5.10_T3): the spec test
  expects the compound assignment to use the *originally-resolved* base
  even if the property is `delete`d mid-evaluation. Our slow-path naturally
  does the right thing because we resolve once on read, store the value in
  a temp, compute, then store back using `__extern_set` which uses the
  same scope object reference — independent of whether the property was
  deleted in between. **Document this in the function comment**; it's the
  one place where naive "re-probe on write" would silently break a known
  test.

#### 2e. Modify `src/codegen/statements.ts`

After the `ts.isTryStatement` branch (line 207), before the function-decl
branch (line 212), add:

```ts
if (ts.isWithStatement(stmt)) {
  markStatementPos(ctx, fctx, stmt, () => compileWithStatement(ctx, fctx, stmt));
  return;
}
```

Import `compileWithStatement` from `./statements/with-statement.js`.

#### 2f. Modify `src/runtime.ts`

Add three new host imports inside the `instantiate` proxy alongside
`__extern_get` (around line 2322):

```ts
if (name === "__with_has") {
  // Spec §9.1.1.2.1 (HasBinding for an object Environment Record):
  // 1. Let foundBinding be ? HasProperty(O, N).
  // 2. If foundBinding is false, return false.
  // 3. If O.[[Symbol.unscopables]] is undefined, return true.
  // 4. Let blocked be ? ToBoolean(unscopables[N]).
  // 5. Return !blocked.
  return (obj: any, key: string): number => {
    if (obj == null) return 0;
    let has: boolean;
    try { has = key in Object(obj); } catch { return 0; }
    if (!has) return 0;
    let unsc: any;
    try { unsc = (obj as any)[Symbol.unscopables]; } catch { return 1; }
    if (unsc == null) return 1;
    return unsc[key] ? 0 : 1;
  };
}
// Optional: __with_get(obj, key) that combines __with_has + __extern_get
// in one host call. Worth adding if perf measurements show the two-call
// pattern hot.
```

(We already have `__extern_get` and `__extern_set` so no new write helper
is needed.)

#### 2g. Modify `src/compiler/validation.ts`

Line 657: the strict-mode early-error is correct, keep it. **Remove** any
hidden filter that bails out before reaching `compileWithStatement` in
sloppy-mode code (grep `isWithStatement` — there's a third hit at line
2556 and 3295, both diagnostic-only; both stay).

#### 2h. Modify `tests/test262-runner.ts`

No skip filter exists for `with` currently (verified by reading
`shouldSkip` at line 306). Nothing to remove — tests just begin passing
once the compiler stops emitting CE. The runner's `noStrict` wrapping
already strips `"use strict"` (see existing handling), so no change there.

#### 2i. Modify `src/codegen/index.ts`

Where late imports are registered (grep `__extern_get` registration sites
~line 7300, and `__throw_reference_error` etc.). Add a small helper
`ensureWithHasImport(ctx, fctx)` that mirrors the existing
`ensureLateImport` pattern; the new `with-statement.ts` calls it once per
function that contains a slow-path `with`. **Crucial**: it MUST go through
`shiftLateImportIndices` / `flushLateImportShifts` — adding an import
mid-function shifts every funcIdx in `fctx.body`, which is exactly the
foot-gun called out in CLAUDE.md ("addUnionImports shifts function
indices").

### 3. Wasm IR pattern (full example)

Source:
```js
with (o) {
  st_p1 = p1;
}
```

Free idents flagged for probe: `st_p1`, `p1` (assuming both resolve to
outer module scope; `o` is a normal local read).

Emitted (slow-path):

```wasm
;; --- evaluate `o` once, store in __with_scope_0 ---
(local.get $o_local)
(local.set $__with_scope_0)
;; --- BODY: st_p1 = p1 ---
;; RHS — read of `p1` through with-scope
(local.get $__with_scope_0)
(global.get $__strconst_p1)
(call $__with_has)
(if (result externref)
  (then
    (local.get $__with_scope_0)
    (global.get $__strconst_p1)
    (call $__extern_get))
  (else
    ;; Normal compileIdentifier emission for p1 (e.g. a module global read)
    (global.get $__moduleglobal_p1)
    (call $__box_number)))   ;; coerce f64→externref since slow-path returns externref
(local.set $__tmp_rhs)
;; LHS write — st_p1 through with-scope
(local.get $__with_scope_0)
(global.get $__strconst_st_p1)
(call $__with_has)
(if
  (then
    (local.get $__with_scope_0)
    (global.get $__strconst_st_p1)
    (local.get $__tmp_rhs)
    (call $__extern_set))
  (else
    ;; Normal assignment to module global st_p1
    (local.get $__tmp_rhs)
    (call $__unbox_to_f64)
    (global.set $__moduleglobal_st_p1)))
```

### 4. Edge cases & spec-correctness checklist

| Case | Handling |
|---|---|
| Strict mode (`"use strict"` or any module/class body) | Already errored in `validation.ts:657`; we never reach the codegen. |
| `with` body declares `var foo` | `var` hoists to the enclosing function — the `var` binding wins over `obj.foo` per §9.1.1.2 (`var` creates the binding in the variable Environment, not the object Environment). The static analyzer must therefore treat `foo` as a *bound* (not free) ident in this case — so the probe is skipped automatically. **Spec test S12.10-0-1 covered.** |
| `delete x` inside `with` | If `x` is a probe-candidate, emit `__with_has` and on hit emit `__extern_delete(scope, x)`; on miss fall through to normal `delete` handling. Needs one extra host import `__with_delete` or piggyback on existing `Reflect.deleteProperty` shim. Defer to follow-up issue if scope-creep — `delete` through `with` is ~4 test262 tests. |
| `typeof x` inside `with` | Same probe; on hit emit `typeof __extern_get(...)`; on miss fall through. The fallthrough is what makes `typeof undeclared` not throw — that path already exists in `compileTypeofExpression`. |
| `obj` is null / undefined | `with(null) { ... }` per §14.11.2 throws TypeError at the with-statement entry. Insert a null guard immediately after step 2 of `compileWithStatement` that throws TypeError. Use the existing `__throw_type_error` import. |
| `obj` is a primitive (`with(2)`) | Per spec, ToObject(2) is performed first. The host's `Object(2)` does this implicitly inside `__with_has` via `Object(obj)`. (Test 12.10-2-1 — covered.) |
| `obj.foo` is a getter that mutates `obj` (deletes a property) | Reference stability — covered in §2d. |
| `@@unscopables` filter | Implemented in `__with_has` per spec §9.1.1.2.1. Test files: `language/statements/with/unscopables-*`. |
| Nested `with(a) with(b)` | Compile-time-expanded `if/else` chain, innermost-first (see IR pattern). |
| `with` containing function declaration | Hoisting of nested `function f(){}` happens before body codegen, so `f` is in the variable Environment, not the object Environment — flagged as bound, probe skipped. Matches §14.11.7. |
| `eval` inside `with` | Already CE for unrelated reasons (eval) — no interaction. |
| `with` inside generator / async | Body containing `yield` / `await` works because the slow-path emits straight-line Wasm with no function boundary; the generator transform already supports if/else. Add to v1 test plan but expect to pass. |
| Closure capturing a free ident from inside a `with` body | The slow-path probe is purely at the read/write *site* — a nested function/arrow does NOT inherit the `with` scope (per spec §9.1.1.2: the object environment record IS pushed on the lexical environment, so closures DO see it). **This is the one hard case.** v1 will NOT support it correctly — emit a warning `with: identifier %s captured by nested closure may not see the with-scope binding (#1387 follow-up)`. Track as separate issue; <5 test262 tests touch this. |

### 5. Regression gate

1. Run `pnpm test -- tests/equivalence.test.ts` — must stay green (no `with`
   tests there but verifies no codegen regression).
2. Run `pnpm test:262 --include language/statements/with` locally —
   expect ~150 newly-passing tests, 0 newly-failing.
3. Full sharded test262 in CI — net pass delta ≥ +200, no single bucket
   regression > 5.
4. Snapshot the slow-path size cost: before merge, run
   `wc -c` on `dist/runtime-*.wasm` for the sample `with`-containing
   playground example; document in commit message.

### 6. LOC estimate

| File | LOC added | LOC modified |
|---|---:|---:|
| `src/codegen/statements/with-statement.ts` (new) | ~250 | 0 |
| `src/codegen/expressions/identifiers.ts` | ~60 (helpers + probe call) | ~5 |
| `src/codegen/expressions/assignment.ts` | ~80 (write probe + temp) | ~5 |
| `src/codegen/statements.ts` | ~5 | ~1 |
| `src/codegen/context/types.ts` | ~12 (fields + comments) | 0 |
| `src/codegen/index.ts` | ~25 (`ensureWithHasImport` helper) | ~3 |
| `src/runtime.ts` | ~25 (`__with_has` shim, optional `__with_delete`) | 0 |
| Tests: hand-rolled equivalence test for `with(o){…}` | ~80 | 0 |
| **Total** | **~535 LOC** | **~14 LOC** |

Estimated effort: 1 senior dev, 2–3 days. Architecturally moderate; the
risk concentrates in (a) the late-import shift inside slow-path codegen
(must use `shiftLateImportIndices` everywhere) and (b) the closure-capture
follow-up which v1 explicitly punts on.

### 7. Open questions for the dev who picks this up

1. The free-identifier analyzer (§2a step 3) needs `ctx.checker` access from
   a syntactic walk — confirm `getSymbolAtLocation` works on free idents
   inside a `WithStatement` (TS sometimes refuses to type-check `with`
   bodies). If it doesn't, fall back to a name-based heuristic: any
   `Identifier` text that is not in `fctx.localMap`, not in
   `fctx.boxedCaptures`, not in `ctx.moduleGlobals`, not a known global,
   gets probed. The over-conservative heuristic is fine — it just emits
   slightly slower code, never incorrect code.
2. The TypeScript parser may reject `with` in `.ts` files even outside
   strict mode (depends on `allowJs`). Verify with a probe in `.tmp/`:
   ```ts
   // .tmp/probe-with.ts
   var o = {x: 1};
   with (o) { console.log(x); }
   ```
   If TS refuses, route `with` through the `.js` allowJs path that
   `tests/test262-runner.ts` already uses. The runner already strips
   `"use strict"` per the `noStrict` flag handling.
3. Confirm `markStatementPos` works on `WithStatement` for source maps —
   should be a no-op concern but worth one source-mapped breakpoint test.

### 8. Follow-up issues (do NOT block this PR)

- `#1387-follow-up-a`: `delete x` through `with` scope (4 tests).
- `#1387-follow-up-b`: closure captures of `with`-scoped names (edge case,
  <5 tests). Requires lifting the with-scope into a closure-captured
  externref slot.
- `#1387-follow-up-c`: `__with_get` host fusion (perf) — combine
  `__with_has` + `__extern_get` into a single host call returning a
  sentinel for miss. Only do this if perf telemetry shows the slow-path
  hot.

