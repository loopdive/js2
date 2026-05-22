---
id: 1531
sprint: 52
title: "JSX syntax is not parsed when compiling .tsx/.jsx input"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bug
area: parser
es_edition: n/a
language_feature: jsx
goal: npm-library-support
depends_on: []
note: "Verified 2026-05-21: checker/index.ts L276-277 has analyzeSource() ScriptKind logic (only handles .jsx but NOT .tsx — confirms bug); L357-361 has scriptKindFor() in project-level path which DOES handle .tsx/.jsx — fix needs to thread tsx detection into analyzeSource"
---

# #1522 — JSX syntax is not parsed when compiling .tsx/.jsx input

## Problem

`compile(src, {fileName: 'foo.tsx'})` rejects every JSX construct as a
syntax error. The first `<` is treated as a less-than operator or the
opening of a regex literal, producing cascades like:

```
'>' expected.
Variable declaration expected.
Cannot find name 'div'.
Unterminated regular expression literal.
```

This blocks compilation of any TS/JS file written in JSX form — most
React components, JSX-based template libraries, and SolidJS components.
The companion goal issue #1033 ("Compile React to Wasm") explicitly
states "JSX is NOT a problem … JSX is transpiled by TypeScript before
js2wasm sees it." That assumption only holds when users pre-transpile
with `tsc`/`esbuild`/`swc`. Feeding raw `.tsx` (the natural source for
React/SolidJS/Preact) to `compile()` fails immediately at parse time.

## Failing examples

```ts
// example A — minimal JSX
const el = <div>hello</div>;
// CE: Unterminated regular expression literal. | Cannot find name 'div'. | Cannot find name 'hello'.

// example B — function component
function Greeting(props: {name: string}) {
  return <div>Hello {props.name}</div>;
}
const el = <Greeting name="x" />;
// CE: ';' expected. | Type expected. | Expression expected.

// example C — fragment
const el = <><div>a</div><div>b</div></>;
// CE: Type expected. | Type expected. | Cannot find name 'div'.

// example D — JSX in list .map
const items = ['a','b','c'];
const el = <ul>{items.map(x => <li key={x}>{x}</li>)}</ul>;
// CE: ',' expected. | '>' expected. | ',' expected.
```

All 12 React JSX snippets I tested on 2026-05-20 against
`benchmarks/results/test262-current.json` baseline fail with the same
class of errors. Even passing `fileName: 'foo.tsx'` does not help.

## Root cause

Two coupled gaps in `src/checker/index.ts`:

1. **`analyzeSource` forces ScriptKind.TS regardless of extension**
   (`src/checker/index.ts:275-291`):
   ```ts
   const isJs = fileName.endsWith(".js") || fileName.endsWith(".jsx");
   const scriptKind = isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
   // ...
   return ts.createSourceFile(name, source, languageVersion, true, scriptKind);
   ```
   `.tsx`/`.jsx` files compute as TS/JS — the parser is never told to
   accept JSX tokens.

2. **`compilerOptions.jsx` is never set** (`src/checker/index.ts:280-286`):
   ```ts
   const compilerOptions: ts.CompilerOptions = {
     target: ts.ScriptTarget.ES2022,
     module: ts.ModuleKind.ESNext,
     strict: !isJs,
     noImplicitAny: false,
     noEmit: true,
   };
   ```
   Even if ScriptKind were correctly TSX, the TS parser still requires
   `compilerOptions.jsx = ts.JsxEmit.Preserve` (or `React`, `ReactJSX`,
   etc.) to recognise JSX elements as syntactically valid.

Interestingly, the multi-source pipeline does have `scriptKindFor()`
(same file, line 357) that already returns `ts.ScriptKind.TSX/JSX`
for the right extensions — so the multi-source path is half-wired
already; the single-file entry just doesn't use it, and neither
pipeline sets the `jsx` compiler option.

## Suggested fix

In `analyzeSource` (and the multi-source equivalent):

```ts
const ext = fileName.match(/\.(tsx|jsx|ts|js|mjs|cjs)$/)?.[1];
const isJsx = ext === 'tsx' || ext === 'jsx';
const isJs  = ext === 'js'  || ext === 'jsx' || ext === 'mjs' || ext === 'cjs';
const scriptKind =
  ext === 'tsx' ? ts.ScriptKind.TSX :
  ext === 'jsx' ? ts.ScriptKind.JSX :
  isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  strict: !isJs,
  noImplicitAny: false,
  noEmit: true,
  // accept JSX in .tsx/.jsx; emit it through to codegen for downstream
  // lowering (Preserve keeps the AST nodes; ReactJSX would desugar to
  // jsx() calls if we want auto-transpile)
  ...(isJsx ? { jsx: ts.JsxEmit.Preserve } : {}),
};
```

With JSX preserved, codegen still has to handle the resulting AST
nodes (`JsxElement`, `JsxSelfClosingElement`, `JsxFragment`,
`JsxExpression`, `JsxAttribute`, `JsxSpreadAttribute`). The cheap
path is to choose `JsxEmit.ReactJSX` so TypeScript desugars JSX to
`jsx(tag, props, key)` runtime calls before our codegen sees them —
then the existing call-expression codegen handles everything as long
as the user provides (or we synthesise) a `jsx` runtime function /
host import.

A two-step delivery is natural:

- **Step 1 (this issue, PR #415):** Accept JSX syntax — set `ScriptKind`
  and `jsx: ReactJSX` so `compile()` no longer rejects `.tsx`/`.jsx` at
  parse time. JSX desugars to `_jsx(...)` calls. **Runtime binding
  for `_jsx`/`_jsxs`/`_Fragment` is deliberately out of scope here**
  — the desugared calls compile cleanly but resolve to no-op host
  imports until step 2 lands.
- **Step 2 (follow-up #1540):** Bind `_jsx`/`_jsxs`/`_Fragment` as
  real imports. Dual path: JS-host target gets a `jsx_runtime` import
  intent (resolves to user-supplied React/Preact or a built-in
  React-element-shaped fallback); `--target wasi` emits a Wasm-native
  `$JsxNode` struct stub. See
  `plan/issues/sprints/52/1540-jsx-runtime-host-import-and-stub.md`
  for the full implementation spec. #1033 still plans a full Wasm-native
  reconciler on top of the standalone stub.

## Acceptance criteria

- [ ] `compile(src, {fileName: 'x.tsx'})` accepts JSX syntax without
      raising "`>` expected" / "Unterminated regular expression" /
      "Cannot find name '<tag>'" parse errors.
- [ ] All 12 React JSX snippets in
      `.tmp/compat-2026-05-20/react.json` compile (whether or not
      they execute correctly is a separate question; this issue is
      parser-only).
- [ ] Existing `.ts` test suite is unaffected (no regressions in
      `tests/equivalence.test.ts`).
- [ ] Default JSX runtime stub is documented (host import or built-in
      fallback) so the simplest snippet (`const el = <div/>`) compiles
      end-to-end.

## Out of scope

- DOM host imports / React-DOM rendering (covered by #1033 / #1045).
- Wasm-native VDOM reconciliation (covered by #1033).
- TypeScript JSX type-checking of element/intrinsic names against
  `JSX.IntrinsicElements` — initial fix can accept any tag name; the
  type-checker can enforce later.
