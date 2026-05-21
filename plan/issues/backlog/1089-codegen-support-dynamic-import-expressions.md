---
id: 1089
title: "codegen: support dynamic import() expressions — 429 test262 tests skipped"
status: ready
created: 2026-04-12
updated: 2026-04-12
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
goal: async-model
---
# #1089 — Support dynamic `import()` expressions

## Summary

429 test262 tests are currently skipped with reason `"ES2020: dynamic import()"`. All 429 use `import()` to dynamically load `_FIXTURE.js` modules at runtime. The runner skips them because the compiler has no codegen for `import()` call expressions and there is no runtime module loader to resolve/instantiate modules dynamically.

## Affected tests

429 tests (all skipped, not failing). Located primarily under `test/language/expressions/dynamic-import/`.

Example files:
- `test/language/expressions/dynamic-import/assignment-expression/lhs-eq-assign-expr-nostrict.js`
- `test/language/expressions/dynamic-import/catch/nested-arrow-import-catch-eval-rqstd-abrupt-typeerror.js`
- `test/language/expressions/dynamic-import/custom-primitive.js`
- `test/language/expressions/dynamic-import/namespace/await-ns-Symbol-toStringTag.js`
- `test/language/expressions/dynamic-import/for-await-resolution-and-error-agen-yield.js`

## ECMAScript spec reference

- [§13.3.10 Import Calls](https://tc39.es/ecma262/#sec-import-calls) — `import(specifier)` returns a Promise for the module namespace
- [§13.3.10.1 Runtime Semantics: Evaluation](https://tc39.es/ecma262/#sec-import-call-runtime-semantics-evaluation) — evaluates specifier, calls HostLoadImportedModule


## Root cause

Three layers block dynamic `import()`:

### 1. Skip filter (`tests/test262-runner.ts:179-187`)
Tests with `_FIXTURE.js` references inside `import()` are skipped before compilation:
```ts
if (/_FIXTURE\.js/.test(source)) {
  const hasDynamicFixture = /import\s*\([^)]*_FIXTURE/.test(source);
  if (hasDynamicFixture) {
    return { skip: true, reason: "ES2020: dynamic import()" };
  }
}
```

### 2. No codegen for `import()` call expressions
The compiler recognizes `import.meta` (`src/codegen/expressions.ts:1011`, verified 2026-05-21 — drifted from L828) and static `import` declarations (`src/codegen/declarations.ts:203`), but `import()` as a call expression (`ts.SyntaxKind.CallExpression` with `expression.kind === ts.SyntaxKind.ImportKeyword`) has no codegen handler. The `src/compiler/validation.ts` validates several error cases for `import()` (new, assignment target, spread) but never compiles a valid `import()` call.

### 3. No runtime module loader
`import()` returns a `Promise<ModuleNamespace>`. This requires:
- A module registry mapping specifiers to compiled modules
- A loader that can resolve specifier strings to module source/binary
- Async instantiation (compile + link + evaluate the target module)
- Returning the module namespace as an externref

## Proposed solution

### Host mode (JS runtime available)
Add a host import `__dynamic_import(specifier: externref) -> externref` that delegates to the JS host's `import()`. The host can resolve modules using its native module system. The returned Promise flows through the existing async/await codegen.

Codegen for `import(expr)`:
1. Compile `expr` to externref (the specifier string)
2. `call __dynamic_import` → returns externref (Promise<namespace>)
3. The caller uses existing `await` codegen to unwrap the promise

### Standalone mode (WASI / no JS host)
Harder. Options:
- Pre-link all modules at compile time (static analysis of `import()` specifiers when they're string literals) — covers ~80% of test262 cases where the specifier is a plain string
- Runtime module loading via WASI filesystem + on-demand Wasm compilation — requires significant infrastructure

### Test262 runner integration
The runner already supports multi-file compilation via `compileMulti` for static imports. Dynamic imports would need:
- A module registry in the runtime bridge
- Pre-compilation of `_FIXTURE.js` files
- A `__dynamic_import` host handler that looks up pre-compiled fixtures

## Effort estimate

**L** — This is a significant feature touching codegen (new expression handler), runtime (module loader/registry), and the test262 runner (multi-module orchestration). The host-mode fast path is medium effort; standalone mode is very hard. Recommend shipping host-mode first and marking standalone as a follow-up.

Key work items:
1. Codegen: handle `import()` call expression → emit `__dynamic_import` call (~50 LOC)
2. Runtime: `__dynamic_import` host handler with module registry (~100 LOC)
3. Test262 runner: pre-compile fixtures, register in module map, remove skip filter (~150 LOC)
4. Tests: verify the 429 skipped tests start passing (expect ~300+ given most are straightforward module loads)

## Implementation Plan (added 2026-05-21)

### Root cause recap
Codegen for `import(specifier)` is already present at `src/codegen/expressions/calls.ts:1106-1148` — it lazily imports `__dynamic_import: (externref) -> externref` and emits the call. What is missing:
1. The test262 runner skip filter at `tests/test262-runner.ts:179-187` rejects fixtures before compilation.
2. There is no host implementation of `__dynamic_import` in the runtime bridge / harness.
3. There is no module registry: the host has no way to map `"./_FIXTURE.js"` → a previously-compiled module's namespace object.
4. Static imports use `compileMulti`, but its output never exposes individual module namespaces in a form the host can return as a Promise.

### Entry points
- **Codegen** (already complete, validate only): `src/codegen/expressions/calls.ts:1106` — `if (expr.expression.kind === ts.SyntaxKind.ImportKeyword)` branch
- **Test262 runner skip filter**: `tests/test262-runner.ts:179-187` (delete `hasDynamicFixture` skip)
- **Test262 runner fixture pre-compile**: `tests/test262-runner.ts:312` (`_FIXTURE.js` detection — extend to compile-and-register)
- **Host bridge** (new): wherever runtime imports are wired for the runner (search `__import_meta_url` / `Promise.resolve` in test262 harness boot)

### Data structures
- New: `moduleRegistry: Map<string, ExternRef>` — keyed by resolved specifier (absolute path), value is the module namespace object (a JS object whose keys are the module's exported bindings)
- Per-test seed: when the runner discovers `_FIXTURE.js` references, it walks them statically (regex over `import\(['"]([^'"]+)['"]\)`), compiles each fixture with `compileMulti`, evaluates it to populate a namespace object, then registers it under its module-relative path

### Algorithm (host-mode pre-link strategy)
1. **Pre-scan**: for each test source, collect all string-literal `import(...)` specifiers. Skip tests with non-literal specifiers in initial PR (fall back to skip with new reason `"ES2020: dynamic import() with computed specifier"`).
2. **Resolve**: relative paths resolved against the test's directory. Reject specifiers escaping the test262 root (path-traversal guard).
3. **Compile**: each fixture compiled with the same `compileMulti` machinery as static imports; collect its export bindings into a JS namespace object `{ [exportName]: binding, [Symbol.toStringTag]: "Module" }`.
4. **Register**: insert `(resolvedAbsPath, namespaceObject)` into `moduleRegistry` for the duration of the run.
5. **Bridge `__dynamic_import`**: host import receives a specifier externref string, looks up `moduleRegistry.get(resolveSpec(callerUrl, spec))`, and returns `Promise.resolve(namespace)`. On miss, return `Promise.reject(new TypeError(...))`.
6. **Drop skip filter** at `tests/test262-runner.ts:185` once all fixtures pre-compile successfully.

### Wasm output
No new codegen — existing `__dynamic_import` call sequence at `calls.ts:1106-1148` is correct:
```wasm
;; import("./mod.js")
local.get $tmp_specifier  ;; externref string
call $__dynamic_import     ;; (externref) -> externref (Promise)
;; result: externref Promise, consumed by `await` lowering
```

### Edge cases
- **Specifier is non-string** (e.g. number, object) → spec: ToString(specifier) before import. Pre-string the argument via existing `coerceType(..., { kind: "externref" })` — already in place at `calls.ts:1126`.
- **Specifier resolves to a missing fixture** → host returns `Promise.reject(new TypeError("Module not found: " + spec))` to match HostLoadImportedModule spec error path.
- **import.meta.url inside the dynamically-imported module** → namespace object must carry the resolved URL; pass through `__import_meta_url` host import that already exists.
- **Second argument (options/attributes)** — current codegen evaluates and drops (`calls.ts:1137-1144`). That matches the v1 spec where assertions are ignored. Test262 has a few tests asserting the second arg is evaluated; this already works.
- **Re-entrant import** (`import(spec)` inside an already-importing module): use the same registry; the second lookup hits the cached namespace.
- **Symbol.toStringTag** on the namespace must equal `"Module"` — must set explicitly on the JS object.
- **null prototype** — namespace objects have null prototype per spec.

### Test plan
- Remove the skip filter from `tests/test262-runner.ts:179-187`
- Targeted local runs:
  - `test/language/expressions/dynamic-import/usage/import-call-expression-string-target.js` — simplest positive
  - `test/language/expressions/dynamic-import/catch/nested-arrow-import-catch-eval-rqstd-abrupt-typeerror.js` — error propagation
  - `test/language/expressions/dynamic-import/namespace/await-ns-Symbol-toStringTag.js` — namespace shape
  - `test/language/expressions/dynamic-import/for-await-resolution-and-error-agen-yield.js` — interaction with async iterators
- Expected: 429 → at least 350 pass; remaining tail is computed-specifier or live-binding edge cases that need follow-up

### Dependencies
- **Hard**: #1042 async-await CPS lowering (needed for `await import(...)` to unwrap the Promise) — already specced.
- **Soft**: clean handling of `import.meta` in fixtures depends on the existing `__import_meta_url` mechanism (already implemented for static imports per `codegen/index.ts:4025`).

### Out of scope
- Computed specifiers (`import(\`./mod-\${n}.js\`)`) — defer to follow-up issue; first PR skips and reports `"dynamic import() with computed specifier"`.
- Standalone (no JS host) mode — needs filesystem-backed loader; defer to a follow-up tracked as a separate issue.

### Files touched
- `tests/test262-runner.ts` (skip filter removal + fixture pre-compile pass)
- `tests/test262-host.ts` or wherever the runner's host imports live (`__dynamic_import` handler + module registry)
- (validation only) `src/codegen/expressions/calls.ts:1106-1148`
