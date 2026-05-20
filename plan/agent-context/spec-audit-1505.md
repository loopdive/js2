# Spec Audit — Sprint 52 — Untracked ECMAScript Gaps

**Generated:** 2026-05-20
**Author:** architect agent (issue #1505)
**Data source:** `benchmarks/results/test262-current.jsonl` (43,160 tests; 13,736 fail + 1,191 CE)

## Method

1. Grouped all `fail`/`compile_error` test262 entries by 3–4-segment path
   (e.g. `built-ins/Object/defineProperty/`,
   `language/expressions/class/dstr/`).
2. Removed clusters already tracked by issues #1326c, #1364, #1382, #1387,
   #1431–1437, #1438–1445, #1450–1456, #1460–1474, #1480–1504.
3. Ranked remaining clusters by (failing tests × tractability — i.e.
   exclude `$262 is not defined`, `No dependency provided for extern
   class "SharedArrayBuffer"`, and `[skip filter]` harness noise).

The clusters below are not covered by any existing sprint-52 issue and
each has ≥ 50 failing test262 tests with a clear single-issue surface.

## Top 10 untracked gaps (ranked)

| # | Cluster | Fails | Difficulty | Spec § |
|---|---------|------:|------------|--------|
| 1510 | `for-await-of` destructuring – array/obj patterns with awaited iteration | **~400** | hard | §14.7.5 + §13.3.3 |
| 1511 | `language/arguments-object` – mapped semantics, descriptors, trailing-comma length | **~180** | medium | §10.2.11–12 |
| 1512 | `dynamic-import` / `assignmenttargettype` – nested early SyntaxErrors not raised | **~190** | medium | §13.3.10 + §15.* |
| 1513 | `built-ins/Reflect` – TypeError on non-object/Symbol, abrupt propagation, define-property invariants | **~80** | easy | §28.1 |
| 1514 | `Set.prototype.{union,intersection,difference,symmetricDifference,is*}` – generic set-like protocol | **~79** | medium | §24.2.5 (ES2025) |
| 1515 | `built-ins/DataView` – `ToIndex(byteOffset)`, detached-buffer TypeError, BigInt setters, return-undefined | **~100** | medium | §25.3.3 |
| 1516 | `built-ins/GeneratorPrototype` – this-value coercion, `length`/`name`/property descriptors | **~52** | easy | §27.5 |
| 1517 | `built-ins/Array.fromAsync` – ES2024 (Stage 4) | **~58** | medium | §23.1.2.2 |
| 1518 | `annexB/language/eval-code` – sloppy-mode function-in-block hoisting / `var`-block reinit | **~183** | hard | Annex B.3.3 |
| 1519 | `language/expressions/new` – non-literal spread + `new <non-constructor>` TypeError + `new.target.value-via-fp{apply,call}` | **~30** | medium | §13.3.5 + §10.2.1.2 |

> #1519 is below the 50-test threshold but is included because it covers
> a known compile-error message (`new FunctionExpression with non-literal
> spread not supported`) which is a hard upper-bound — fixing it unblocks
> any future PR that uses `new ctor(...args)`.

## Detailed analysis per cluster

### 1510 — for-await-of destructuring (~400 fails)

**Where:** `language/statements/for-await-of/async-*-dstr-*` (403 entries,
nearly all individual files).

Distinct from #1451 (which targets *class/object method param*
destructuring). For-await-of has a unique twist: each `IteratorStep` call
returns a Promise that must be awaited *before* the binding-pattern
runtime semantics fire. The pattern code in
`src/codegen/statements.ts` (`compileForOfStatement` with `isAwait=true`)
re-uses the synchronous for-of destructuring path, dropping the await on
the `next()` result.

Symptoms in the dataset:
- `illegal cast` on rest patterns — the awaited value is unwrapped as a
  struct instead of the resolved externref.
- `assert.sameValue(initCount, 0)` — defaults fire on the wrong branch
  because the awaited `done` flag is observed before resolution.
- `',' expected.` on `async-func-decl-dstr-array-elem-init-in.js` — a
  parse-side issue (the `in` body of an array-elem initializer inside
  for-await-of head).

**Source files to touch:** `src/codegen/statements.ts` (for-await of
emitter), `src/codegen/destructuring.ts` (array-pattern step await).

**Acceptance:** ≥ 250 of the 400 turn green; remaining ~150 cluster on
named-evaluation (#1450) or stage-3 proposals.

### 1511 — arguments object semantics (~180 fails)

**Where:** `language/arguments-object/` (181 entries — 80% trailing-comma
test variants asserting `arguments.length === N`).

Sub-buckets:
- **Trailing-comma length** (~120): `func-expr-args-trailing-comma-*`,
  `cls-decl-async-gen-meth-static-args-trailing-comma-*`,
  `cls-expr-private-meth-args-trailing-comma-*`. Each asserts
  `arguments.length` equals the number of *non-elided* arguments at the
  call site. Our class-method trampolines (`__obj_meth_tramp_*` in
  `src/codegen/class-bodies.ts:1080`) appear to pre-fill omitted formals
  with `undefined`, so `arguments.length` reflects the formal-parameter
  count, not the call-site count.
- **Mapped arguments** (~30): `mapped/nonconfigurable-*`,
  `mapped/mapped-arguments-nonconfigurable-strict-delete-*`. In sloppy
  mode `arguments[i]` and the parameter binding share a slot; after
  `Object.defineProperty(arguments, "0", {writable:false})` mutating
  the slot must throw. Currently the slot map is unidirectional.
- **`S10.6_A*` legacy** (~20): a few "arguments object doesn't exist"
  inside arrow functions (correct per spec) and Annex-B reflection.

**Source files:** `src/codegen/arguments-object.ts`,
`src/codegen/class-bodies.ts` (method trampoline), plus the existing
mapped-arguments harness.

**Acceptance:** ≥ 100 of 180 turn green.

### 1512 — dynamic-import nested early SyntaxErrors (~190 fails)

**Where:** `language/expressions/dynamic-import/syntax/` (191 entries).

Almost every fail has the *same* error message:

```
expected parse/early SyntaxError but compiled and instantiated successfully
```

These tests are *negative* — they wrap `import(...)` calls in syntax
contexts that are required to be early errors (e.g.
`nested-async-gen-await-typeof-import-source.js`,
`nested-with-expression-import-call-unknown.js`). Our parser does *not*
emit a SyntaxError for `await typeof import.source(...)` or for
`with (import(...)) {}`.

Some are also covered by the `import-defer` / `import-source` Stage-3
proposal skip list, but the test runner currently classifies them as
silent passes (which then read as a regression in the report).

**Source files:** `src/compiler/early-errors.ts`,
`src/compiler/parser.ts`. Likely 6–10 missing early-error checks; each
unblocks 20–30 tests.

**Acceptance:** ≥ 120 of 190 turn green (the rest depend on the
import-source proposal staying skipped).

This issue is a **sibling** of #1435 (general lexical/early-error
gaps) but scoped to the dynamic-import grammar so it can land in
parallel.

### 1513 — Reflect TypeError + abrupt-completion fidelity (~80 fails)

**Where:** `built-ins/Reflect/` (81 entries).

Almost every fail asserts one of three things:

1. `Reflect.X(non-object)` throws `TypeError` (currently silently
   returns `undefined`/`false`).
2. `Reflect.X(o)` propagates an abrupt completion from a descriptor
   getter or `[[Get]]` (`return-abrupt-from-result.js`, 9 entries).
3. `Reflect.defineProperty(...) → boolean` returns `false` when the
   underlying define would fail (currently throws or returns
   `undefined`).

Current implementation: `src/codegen/expressions/calls.ts:3129–3260`
inlines each `Reflect.*` to its Object counterpart but skips the
`Type(target) is Object` check. Fix is a single early-return guard
emitted before each lowering.

**Source files:** `src/codegen/expressions/calls.ts` (Reflect dispatch
block).

**Acceptance:** ≥ 60 of 80 turn green.

### 1514 — Set.prototype set methods accept set-like (~79 fails)

**Where:** `built-ins/Set/prototype/{union,intersection,difference,symmetricDifference,isDisjointFrom,isSupersetOf,isSubsetOf}/` (79 entries).

Common failure modes:

- `set.union(map)` → "The .size property is NaN"
- `set.intersection(class-with-keys-method)` → "string 'has' is not a function"
- `set.difference(arraylike)` → wrong result

Spec §24.2.5 (ES2025) requires these methods to accept *any* object with
a `size` (number), `has(v)` (callable), and `keys()` (callable) — not
just `Set` instances. Existing comments in `src/runtime.ts:1911`
acknowledge this is the gap. Implementation lives in `__set_*_method`
helpers (lines 1911–2090) which currently fast-path on `instanceof Set`.

**Source files:** `src/runtime.ts` (set-method helpers),
`src/codegen/index.ts:6140–6160` (extern method registration).

**Acceptance:** ≥ 60 of 79 turn green.

### 1515 — DataView ToIndex / detached / BigInt fidelity (~100 fails)

**Where:** `built-ins/DataView/prototype/{getInt32,getBigUint64,setUint8,setBigInt64,…}/` (~150 entries; ~100 actionable, ~50 SharedArrayBuffer-skip).

Three sub-clusters:

1. **`toindex-byteoffset.js`** (~25): every getter/setter has a test
   that calls `dv.getXxx({ valueOf() { throw new Error() } })`. We emit
   "Cannot convert object to primitive value" — close, but the spec
   requires the original valueOf abrupt completion. The
   `ToIndex(byteOffset)` step in §25.3.1.* needs to run user-side
   `valueOf` before the receiver-class check.
2. **`detached-buffer.js`** (~20): after `$DETACHBUFFER(buffer)`, every
   getter/setter must throw `TypeError`. Currently we silently return
   stale data or `undefined`. Spec §25.3.1.4 step 3.
3. **`setBigInt64` value coercion** (~10): `dv.setBigInt64(0, -1)`
   should ToBigInt(-1) → -1n, but currently throws "Cannot convert
   -1870724872 to a BigInt" — the f64 → BigInt path is missing a
   safe-integer branch.

**Source files:** `src/codegen/dataview-ops.ts` (if present; else
`src/codegen/typed-arrays.ts`).

**Acceptance:** ≥ 70 of 100 turn green.

### 1516 — GeneratorPrototype this-value coercion + property descriptors (~52 fails)

**Where:** `built-ins/GeneratorPrototype/{next,return,throw}/` (~30 entries) and `built-ins/GeneratorPrototype/{name,length,property-descriptor}.js` (~10 entries).

Symptoms:
- `this-val-not-generator.js`, `this-val-not-object.js`: assert
  `TypeError`; we return `Cannot access property on null or undefined`
  (close, but wrong error class & message).
- `property-descriptor.js`, `name.js`, `length.js`: `verifyProperty(
  GeneratorPrototype.next, "length", { value: 1, writable: false, ... })`
  — same descriptor-fidelity pattern as #1364, but on the implicit
  `%GeneratorPrototype%` rather than user classes.

**Source files:** `src/codegen/generators.ts` (or wherever
`__generator_next` is emitted), `src/codegen/intrinsics.ts`.

**Acceptance:** ≥ 40 of 52 turn green.

### 1517 — Array.fromAsync (~58 fails)

**Where:** `built-ins/Array/fromAsync/` (58 entries).

Not implemented at all (no `fromAsync` symbol in `src/codegen/`).
Array.fromAsync (ES2024, §23.1.2.2) is the async analogue of
`Array.from`. Conceptually:

```js
Array.fromAsync = async function(items, mapFn, thisArg) {
  const A = new this(0);
  let k = 0;
  for await (const v of items)
    A[k++] = mapFn ? await mapFn.call(thisArg, v, k - 1) : v;
  A.length = k;
  return A;
};
```

This issue depends on for-await-of (already supported by #1373b) and a
new async builtin entry. Most internal pieces exist; the work is mostly
wiring + ToObject / IsCallable / iterator vs array-like branching.

**Source files:** `src/codegen/array-methods.ts` (add `from_async`
dispatch), `src/runtime.ts` (async helper).

**Acceptance:** all 58 turn green (small, self-contained spec).

### 1518 — Annex B legacy function-in-block hoisting (~183 fails)

**Where:** `annexB/language/eval-code/{direct,indirect}/` (183 entries),
plus a handful in `annexB/language/{function-code,global-code,statements}/`.

Spec Annex B.3.2 says **in sloppy mode**, a `function f(){}` declared
inside a block (`if`, `switch`, `try`, `for`) is hoisted to two places:
the block's lex env *and* the surrounding function's var env. Our
parser currently hoists only to the block lex env, so

```js
if (true) function f() {}
typeof f; // expected "function" sloppy, "undefined" strict — we always give "undefined"
```

asserts about `typeof after === 'function'` fail across the cluster.

This is genuinely hard (parser + scope analysis + var-env mutation in
the right order at runtime) — flagged `hard` and may be deferred. The
acceptance bar is intentionally low: turning on enough to pass *typical*
patterns (50%) is acceptable progress.

**Source files:** `src/compiler/parser.ts`, `src/compiler/scopes.ts`,
`src/codegen/declarations.ts`.

### 1519 — `new` expression edge cases (~30 fails)

**Where:** `language/expressions/new/` and `language/expressions/new.target/` (~25 entries).

Three issues hidden in one cluster:

1. **Non-literal spread** (~10): `new ctor(...args)` where `args` is an
   identifier or call expression triggers
   `new FunctionExpression with non-literal spread not supported` at
   `src/codegen/expressions/new-super.ts:867`. The fix is to fall back to
   `Reflect.construct(ctor, args)` (already inlined for the spread
   case in `src/codegen/expressions/calls.ts:3188`).
2. **`new <non-constructor>` TypeError** (~10): `new Math`, `new this`,
   `new null`, `new new Boolean(true)` should all throw `TypeError`.
   We instead crash with `dereferencing a null pointer` or skip the
   `[[Construct]]` test entirely.
3. **`new.target.value-via-fp{apply,call,reflect-apply}`** (~5): the
   `[[NewTarget]]` slot is dropped on `Function.prototype.apply` and
   `Reflect.apply` — `new.target` returns `undefined` from inside a
   bound/applied constructor invocation.

**Source files:** `src/codegen/expressions/new-super.ts:850–900`
(spread fallback), plus `src/codegen/expressions/calls.ts` for the
`new.target` plumbing on `apply`/`call`.

**Acceptance:** all 30 turn green.

## Out-of-scope (deliberately excluded)

| Cluster | Why skipped |
|---------|-------------|
| `built-ins/Atomics` (266) | `$262 is not defined` + SharedArrayBuffer — almost all skip-filtered |
| `built-ins/SharedArrayBuffer` (70) | Skip filter — no behaviour we can fix without SAB |
| `built-ins/ShadowRealm` (61) | `$262 is not defined` — host harness only |
| `language/statements/with` (164) | Tracked by #1387 |
| `language/expressions/dynamic-import/{catch,usage,namespace,…}` (~340) | Stage-3 proposal noise (`import.defer`, `import.source`) + already in #1326c/#1494 |
| `language/expressions/class/dstr` (558) | Tracked by #1451 |
| `language/statements/class/dstr` (560) | Tracked by #1451 |
| `language/statements/for-of/dstr` (318) | 80% covered by #1450 (NamedEvaluation) + #1454 (IteratorClose) |
| `language/expressions/assignment/dstr` (167) | Same as above |
| `built-ins/Array/prototype/*` (1,485) | Tracked by #1461 |
| `built-ins/Object/define{Property,Properties}/` (961) | Tracked by #1460 |
| `built-ins/Object/{create,getOwnPropertyDescriptor}/` (193) | Tracked by #1462 |
| `built-ins/Function/prototype/{bind,call,apply,toString}` (309) | Tracked by #1463 |
| `built-ins/Iterator/prototype/*` (288) | Tracked by #1464 |
| `built-ins/Promise/*` (~150) | Tracked by #1326c + #1465 |
| `language/expressions/super` spread + class invariants | Tracked by #1455 + #1456 |

## Issue stubs created

See `plan/issues/sprints/52/1510-1519-*.md`.
