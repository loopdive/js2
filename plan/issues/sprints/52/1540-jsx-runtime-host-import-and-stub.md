---
id: 1540
sprint: 52
title: "JSX runtime: bind _jsx/_jsxs/_Fragment as host import (default) and standalone stub"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
es_edition: n/a
language_feature: jsx
goal: npm-library-support
depends_on: [1531]
---

# #1540 — JSX runtime: bind _jsx/_jsxs/_Fragment as host import (default) and standalone stub

## Problem

PR #415 (closes #1531) makes the parser accept `.tsx`/`.jsx` and asks
TypeScript to desugar JSX into the React-17+ "automatic runtime" form:

```ts
// source
const el = <div className="x">hello</div>;

// TypeScript with jsx: ReactJSX emits:
import { jsx as _jsx } from "react/jsx-runtime";
const el = _jsx("div", { className: "x", children: "hello" });
```

For multi-child elements `_jsxs` is used; for fragments `_jsx(_Fragment, ...)`
is used where `_Fragment` comes from the same import. The auto-import
target is configurable via `jsxImportSource` (defaults to `"react"` so
the specifier is `"react/jsx-runtime"`; Preact uses `"preact/jsx-runtime"`,
SolidJS uses `"solid-js/h/jsx-runtime"`, Vue uses `"vue/jsx-runtime"`).

After #1531 lands, our pipeline sees these as ordinary named imports
from an unknown module. `preprocessImports` (`src/import-resolver.ts:89`)
turns them into `declare function _jsx(a0,a1,a2): any` stubs, the
codegen treats the calls as extern function calls, and the import
classifier (`src/compiler/import-manifest.ts:8`) falls through to the
final `{ type: "builtin", name }` branch. At runtime, `resolveImport`
returns a no-op `() => {}` for any unknown `builtin`, so `_jsx(...)`
returns `undefined` and the whole VDOM collapses silently — no error
surfaces, but nothing renders.

We need a real binding strategy. This issue defines it.

## Failing examples

After #1531 lands these compile cleanly but `el` is always `undefined`:

```tsx
// example A — minimal element
const el = <div>hello</div>;
// expected (host mode): { type: "div", props: { children: "hello" }, key: null }
// actual: undefined

// example B — function component
function Greeting(props: {name: string}) {
  return <div>Hello {props.name}</div>;
}
const el = <Greeting name="x" />;
// expected: { type: Greeting, props: { name: "x" }, key: null }
// actual: undefined

// example C — fragment
const el = <><div>a</div><div>b</div></>;
// expected: { type: Symbol(react.fragment), props: { children: [...] }, key: null }
// actual: undefined
```

## Chosen approach: C (dual path, recommended in dispatch brief)

Three approaches were considered (see the dispatch brief). The trade-off
matrix:

| Approach | JS host | Standalone (--target wasi) | React-compat | Effort |
|----------|---------|----------------------------|--------------|--------|
| A — host import only      | works | fails (missing import) | full | small |
| B — Wasm-native VDOM only | works | works | none | medium |
| C — dual path             | works | works (stub)    | full (host) | medium |

**Choose C.** Concretely:

1. **Default (JS host target — `gc`/`linear`)**: emit `_jsx`/`_jsxs`/`_Fragment`
   as host imports with a new `jsx_runtime` ImportIntent. At
   instantiation time, `resolveImport` returns either:
   - the user-supplied `deps.jsxRuntime` (React/Preact/Solid/etc.) if present, OR
   - a built-in minimal implementation that constructs plain
     `{type, props, key}` objects — sufficient for `el.type`/`el.props`
     introspection and unit tests, and matches React's element shape
     so a host renderer can consume it.
2. **`--target wasi` (standalone)**: emit a Wasm-native stub that
   constructs a `$JsxNode` WasmGC struct. No JS host needed. Rendering
   is out of scope (see #1033) — this issue only guarantees that
   `_jsx(...)` returns a non-null value with a recoverable shape.

Both paths share the **same compile-time intent recognition** (steps 1-4
below); they diverge only in what `resolveImport` / the codegen emit
for the actual call.

## Implementation Plan

### Root cause

After #1531, JSX desugars to named imports from `react/jsx-runtime` (or
the configured `jsxImportSource`). Our import pipeline treats them as
opaque externs that resolve to no-op host imports, so every JSX
expression evaluates to `undefined`.

### Changes

**File: `src/import-resolver.ts`**

- Add a constant `JSX_RUNTIME_SPECIFIERS` (top of file, near
  `NODE_BUILTIN_MODULES` around line 16):
  ```ts
  /** Recognized JSX runtime module specifiers (auto-imports emitted by
   *  TypeScript when jsx: ReactJSX / jsxImportSource is set). */
  export const JSX_RUNTIME_SPECIFIERS = new Set([
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "preact/jsx-runtime",
    "preact/jsx-dev-runtime",
    "solid-js/h/jsx-runtime",
    "vue/jsx-runtime",
    "@emotion/react/jsx-runtime",
  ]);
  export function isJsxRuntime(spec: string): boolean {
    return JSX_RUNTIME_SPECIFIERS.has(spec);
  }
  ```
- Extend `PreprocessResult` (line ~72) with `jsxRuntime?: { localJsx?: string;
  localJsxs?: string; localFragment?: string; localJsxDev?: string; specifier: string }`.
- In `preprocessImports` (line ~89), when a named import's `moduleSpec`
  matches `isJsxRuntime`, record the local binding names (e.g.
  `import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime"`
  → `{localJsx: "_jsx", localJsxs: "_jsxs", localFragment: "_Fragment",
  specifier: "react/jsx-runtime"}`) and **emit typed declare stubs**
  instead of the generic `(a0,a1,a2): any` form:
  ```ts
  declare function _jsx(type: any, props: any, key?: any): any;
  declare function _jsxs(type: any, props: any, key?: any): any;
  declare const _Fragment: any;
  ```
  Typed stubs are important because they make the import classifier
  treat all three argument positions as `externref` (the existing
  `any` → externref lowering already does this; we just want to be
  explicit).

**File: `src/index.ts`**

- Extend the `ImportIntent` union (line 2-34):
  ```ts
  | { type: "jsx_runtime"; method: "jsx" | "jsxs" | "Fragment" | "jsxDEV";
      specifier: string }
  ```

**File: `src/compiler/import-manifest.ts`**

- Inside `classifyImport` (function starts at line 8), add a recognition
  branch *before* the fallback `{ type: "builtin", name }` at line 152.
  The compiler will emit JSX runtime imports under stable internal
  names — choose `__jsx_runtime_jsx`, `__jsx_runtime_jsxs`,
  `__jsx_runtime_Fragment`, `__jsx_runtime_jsxDEV` (matches the
  `__node_fs_*` convention at line 133):
  ```ts
  if (name === "__jsx_runtime_jsx")
    return { type: "jsx_runtime", method: "jsx", specifier: mod.jsxImportSource ?? "react/jsx-runtime" };
  if (name === "__jsx_runtime_jsxs")
    return { type: "jsx_runtime", method: "jsxs", specifier: mod.jsxImportSource ?? "react/jsx-runtime" };
  if (name === "__jsx_runtime_Fragment")
    return { type: "jsx_runtime", method: "Fragment", specifier: mod.jsxImportSource ?? "react/jsx-runtime" };
  if (name === "__jsx_runtime_jsxDEV")
    return { type: "jsx_runtime", method: "jsxDEV", specifier: mod.jsxImportSource ?? "react/jsx-runtime" };
  ```
  `mod.jsxImportSource` is a new optional field on `WasmModule`
  populated by the codegen path that registers the binding (see next bullet).

**File: `src/ir/types.ts`** (WasmModule type)

- Add `jsxImportSource?: string;` to `WasmModule` so the manifest builder
  can read it back. Default `"react/jsx-runtime"`.

**File: `src/codegen/expressions/calls.ts`**

- Before the generic extern-call path resolves the callee identifier
  (around the top of `compileCallExpression` — find where named
  identifiers like `_jsx`/`_jsxs`/`_Fragment` are resolved), add a
  lookup against `ctx.jsxRuntime?.localJsx` etc. (`ctx.jsxRuntime` is
  populated from `preprocessImports` output).
- For a `_jsx(type, props, key?)` call:
  - **All targets**: ensure the import `__jsx_runtime_jsx` is registered
    via `ensureLateImport(ctx, "__jsx_runtime_jsx", [externref, externref, externref], [externref])`.
  - Compile `type`, `props` to externref; if `key` is omitted, push
    `ref.null.extern`.
  - Emit `call $__jsx_runtime_jsx`; leave externref on stack.
- Same pattern for `_jsxs(type, props, key?)` → `__jsx_runtime_jsxs`.
- For an identifier reference to `_Fragment` (no call), emit
  `global.get $__jsx_runtime_Fragment` (a new env-imported `externref`
  global) instead of a function call. Register it via
  `ensureLateImport` with `kind: "global"` (extend the helper if needed,
  or add a sibling `ensureLateGlobalImport`).
- Set `ctx.module.jsxImportSource = ctx.jsxRuntime.specifier` so the
  manifest carries the user-configured runtime through.

**File: `src/runtime.ts`**

- In `resolveImport` (line 1782), add a new case before the `default`
  branch (around line 4808):
  ```ts
  case "jsx_runtime": {
    // (#1540) JSX runtime binding. Priority order:
    //   1. deps.jsxRuntime?.[method]  — user-supplied React/Preact/etc.
    //   2. deps[intent.specifier]?.[method] — module-shaped dep
    //   3. built-in minimal implementation (creates React-shaped elements)
    const method = intent.method;
    const userRuntime = (deps as any)?.jsxRuntime;
    if (userRuntime && method in userRuntime) {
      const v = userRuntime[method];
      return typeof v === "function" ? v : () => v;
    }
    const modDep = deps?.[intent.specifier];
    if (modDep) {
      const map: Record<string, string> = {
        jsx: "jsx", jsxs: "jsxs", Fragment: "Fragment", jsxDEV: "jsxDEV",
      };
      const v = (modDep as any)[map[method]];
      if (v !== undefined) return typeof v === "function" ? v : () => v;
    }
    // Built-in fallback — React-element shape (no reconciler).
    if (method === "Fragment") {
      // Use a stable Symbol so identity comparisons work across calls.
      const sym = _builtinFragmentSym;
      return () => sym;
    }
    return (type: any, props: any, key: any) => ({
      $$typeof: _builtinJsxTypeof, // matches react's REACT_ELEMENT_TYPE convention
      type,
      props: props ?? {},
      key: key ?? null,
      ref: null,
    });
  }
  ```
  Add module-scope sentinels next to the existing helpers:
  ```ts
  const _builtinJsxTypeof = typeof Symbol === "function"
    ? Symbol.for("react.element")
    : 0xeac7; // numeric fallback matches React 17 legacy
  const _builtinFragmentSym = typeof Symbol === "function"
    ? Symbol.for("react.fragment")
    : { __jsx_fragment: true };
  ```
- `Fragment` is bound as a *global* import (not a function call), so the
  return value above is what the global's initializer evaluates to. The
  helper that builds env globals (search for `WebAssembly.Global` near
  `buildStringConstants` at line 4817) needs to call `resolveImport`
  for `jsx_runtime`/`Fragment` and wrap the value in
  `new WebAssembly.Global({value: "externref", mutable: false}, value)`.

**File: `src/runtime.ts` — standalone path (`--target wasi`)**

The standalone path doesn't run `resolveImport` (no JS host). Codegen
must emit a Wasm-native implementation instead of the import:

- Define a WasmGC struct in the runtime emitted by codegen
  (`src/codegen/index.ts`, near other internal type definitions):
  ```wasm
  (type $JsxNode (struct
    (field $type     (mut externref))   ;; string tag, function ref, or Fragment sentinel
    (field $props    (mut externref))   ;; props object (or null)
    (field $key      (mut externref))   ;; key (or null)
    (field $children (mut externref))   ;; children array (or null) — denormalized from props for fast walks
  ))
  ```
- When `target === "wasi"` (or any `target` where `ctx.hasJsHost === false`),
  emit `_jsx`/`_jsxs` as inline `struct.new $JsxNode` instead of a host
  call. `_Fragment` becomes a module-scope `(global $__jsx_fragment externref
  (ref.null extern))` initialized with a unique sentinel struct on
  module start.
- This branch can be gated behind a fresh helper
  `emitJsxRuntimeStandalone(ctx)` invoked from the call-site lowering
  in `calls.ts` when `ctx.target === "wasi"`.

### Wasm IR pattern

**JS-host call site** (`_jsx("div", { children: "hello" })` after #1531):

```wasm
;; arg0: type ("div" — string literal externref via string_constants)
global.get $__string_div
;; arg1: props ({ children: "hello" })
call $__new_plain_object
local.tee $tmp_props
global.get $__string_children
global.get $__string_hello
call $__obj_set_externref
;; arg2: key (omitted → null)
ref.null extern
;; jsx call → externref
call $__jsx_runtime_jsx
```

**Standalone (--target wasi)**:

```wasm
;; same arg0/arg1/arg2 setup
ref.null extern                 ;; children denormalized (filled in below)
struct.new $JsxNode
```

### Edge cases

- **`_Fragment` referenced but never called** — must still resolve to a
  stable externref/sentinel; identity comparison `el.type === _Fragment`
  must hold across calls. Use a single module-scope global, not a
  per-call allocation.
- **`jsxDEV`** — TypeScript emits `jsx-dev-runtime` (with extra
  `source`/`self` args) when `compilerOptions.development` is true.
  We bind it identically to `jsx` (ignoring the extras) for now.
- **Missing `children`** — `_jsx("br", null)` is legal; `props` may be
  `null`/`undefined`. Built-in fallback coerces to `{}` so `el.props.x`
  doesn't NPE in downstream code.
- **`key` aliasing** — `_jsx` puts `key` outside `props` in React 17+
  to avoid mutation; preserve that distinction in the built-in
  fallback.
- **User-supplied `jsxRuntime` dep** — if `deps.jsxRuntime = require("react/jsx-runtime")`
  is passed, host calls go through the real React. This is the
  expected production path; the built-in fallback is for unit tests
  and "I just want to read `el.type`" usage.
- **Multiple JSX runtimes in one module** — we only support one
  `jsxImportSource` per compile unit (matches the TypeScript
  compiler-options model). If a source imports from both
  `react/jsx-runtime` and `preact/jsx-runtime`, the second one wins
  and we emit a warning. Out of scope to support both.
- **`children` array shape** — `_jsxs` always wraps children in an
  array; `_jsx` may pass a single child as `children: child` (not
  `children: [child]`). The built-in fallback preserves the input
  shape exactly; don't normalize.

### Wiring through `preprocessImports`

The preprocessor sees `import { jsx as _jsx, ... } from "react/jsx-runtime"`.
After detection it:
1. Records `result.jsxRuntime = {localJsx: "_jsx", ...}`.
2. Replaces the import statement with typed declare stubs (see above).
3. The codegen, when compiling a call to `_jsx`/`_jsxs`, looks up the
   local name in `ctx.jsxRuntime` and routes the call to the
   `__jsx_runtime_*` import instead of treating it as a generic extern.

The local-name indirection matters because TypeScript's `jsx as _jsx`
alias is configurable — users can choose `jsx as h` or even rebind via
`/** @jsxImportSource */` pragmas. We must consult the binding map, not
hardcode `_jsx`.

### Acceptance criteria

- [ ] In host mode, `compile("const el = <div>hi</div>;", {fileName: "x.tsx"})`
      produces a module where `el.type === "div"` and
      `el.props.children === "hi"` (using the built-in fallback runtime).
- [ ] With `deps.jsxRuntime = require("react/jsx-runtime")` passed at
      instantiation time, `el` is the genuine React element returned by
      `React.jsx("div", {children: "hi"})` (verify by
      `React.isValidElement(el)`).
- [ ] `_Fragment` is a stable sentinel: across two `_jsx(_Fragment, ...)`
      calls in the same module, the resulting `el.type` values are
      identity-equal.
- [ ] `<>a<br/>b</>` compiles; the emitted call is
      `_jsx(_Fragment, { children: ["a", _jsx("br", {}), "b"] })`
      (or `_jsxs` depending on TS version); `el.type === _Fragment`
      and `el.props.children` is an array of length 3.
- [ ] Component reference works:
      `function G(){return <span/>} const el = <G/>;` → `el.type === G`
      (the user-defined function reference, passed through as externref).
- [ ] `--target wasi` compile of the same `.tsx` source succeeds and
      produces a module whose `_jsx` returns a non-null `$JsxNode`
      struct (verified via an exported `get_type(el)` helper added in
      the test file).
- [ ] A `tests/issue-1540.test.ts` covers the four shapes above
      (intrinsic tag, fragment, component reference, standalone-target).
- [ ] No regressions in `tests/equivalence.test.ts` or the existing
      `tests/issue-1531.test.ts` (the parser-only tests).
- [ ] Test262 baseline unchanged (JSX is not in test262, so the only
      risk is the new import classifier branch — verify by running
      `pnpm run test:262` shard locally on at least one shard).

### Out of scope

- DOM rendering / `ReactDOM.render` (covered by #1033 / #1045).
- A Wasm-native reconciler (separate issue, depends on this one).
- JSX type-checking against `JSX.IntrinsicElements` (TypeScript can do
  this on the user's side; our pipeline doesn't enforce it).
- Class components / lifecycle methods (#1033).
- `jsxs` vs `jsx` array-vs-single-child normalization — pass through
  whatever TypeScript emits.
- Pragma comments (`/** @jsx h */`, `/** @jsxFrag Fragment */`) — only
  the modern `jsxImportSource` form is supported in v1. Old-style
  pragmas tracked as follow-up.
- Source-map metadata threading from `jsxDEV` (`__source`, `__self`)
  into our debug info — `jsxDEV` is currently bound identically to
  `jsx`; extra args are ignored.

## Notes

- The built-in fallback uses `Symbol.for("react.element")` so genuine
  React tooling that walks externally-produced elements (e.g.
  `react-test-renderer`) sees the right `$$typeof` tag without needing
  the React module loaded.
- The dual path mirrors #679 (dual string backend) and #682 (dual
  RegExp backend) — host fast path with a Wasm-native fallback for
  standalone targets. Keep that pattern visible in code comments so
  future contributors recognize it.
- `jsxImportSource` from TS's compiler options is *not* currently
  surfaced to our compiler. PR #415 hardcodes `react/jsx-runtime` via
  `JsxEmit.ReactJSX`. If/when we want to support Preact/Solid as
  first-class targets, plumb `jsxImportSource` through `CompileOptions`
  and into `compilerOptions.jsxImportSource` in `analyzeSource`. That
  plumbing is a small follow-up; this issue assumes the default
  (`react/jsx-runtime`) for codegen-emitted import names but the
  resolver already handles arbitrary specifiers via `intent.specifier`.
