---
id: 1576
title: "React Tier 1 compile/validate survey (probe of `react@19.2.6`)"
status: ready
created: 2026-05-20
updated: 2026-07-30
priority: high
area: codegen, resolver, runtime
goal: npm-library-support
sprint: Backlog
owner: tech-lead
related: [1033, 1043, 1045, 1559, 1287, 1289]
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/closure-exports.ts
  - src/codegen/context/types.ts
  - src/codegen/statements/variables.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/property-access.ts
  - src/codegen/binary-ops-typed-dispatch.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# React Tier 1 — compile/validate survey

## Runtime API compatibility follow-up (2026-07-30)

The package-entry harness now executes upstream-derived `createElement`,
`cloneElement`, `isValidElement`, `Children`, and context vectors. Supporting
React's real call and local-representation shapes requires narrow additions to
the existing closure-dispatch, dynamic equality/property access, and variable
allocation machinery listed in the budget allowances above. Those edits are
co-located with the representation decisions they extend; extracting them
would split single dispatch decisions across modules without reducing their
complexity.

Anticipatory survey to land alongside `tests/stress/react-tier1.test.ts` and
populate the actionable issue tail for goal #1033 (Compile React to Wasm —
UI library stress test). Mirrors the methodology of `eslint-next-layer-survey.md`
and `tests/stress/eslint-tier1.test.ts`: drive `compileProject` against each
plausible entry point and document — at the granularity of "compiles OK /
validates OK / instantiates OK" — what works on `main` today.

Package surveyed: **`react@19.2.6`** (newly added as a dev dep).

## Method

```ts
import { compileProject } from "./src/index.ts";
import { buildImports } from "./src/runtime.ts";

const r = compileProject(entry, { allowJs: true });
// r.success — type-checks + emits a binary
const validates = WebAssembly.validate(r.binary);
// new WebAssembly.Module(r.binary) — same as validate, but exposes the first error message
const imps = buildImports(r.imports, undefined, r.stringPool);
await WebAssembly.instantiate(r.binary, imps);
```

Probe script: `.tmp/probe-react.ts` (gitignored; reproducer for each finding below).

## Results matrix

| Entry                                                           | Compile?     | Validate? | Instantiate?    | First blocker                                                                                                                  |
| --------------------------------------------------------------- | ------------ | --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **A.** TS `import React from "react"` shim                      | OK (1066 B)  | OK        | FAIL            | `ReferenceError: process is not defined` from CJS dispatch in `react/index.js` (runtime, not codegen)                          |
| **B.** `node_modules/react/index.js` (CJS shim)                 | OK (640 B)   | OK        | FAIL            | same — `process.env.NODE_ENV` lookup at module init throws                                                                     |
| **C.** `node_modules/react/cjs/react.development.js` (1284 LOC) | OK (9285 B)  | OK        | OK (no exports) | guard `"production" !== process.env.NODE_ENV && (IIFE)()` dead-code-eliminates the entire body — binary contains no React code |
| **D.** `node_modules/react/cjs/react.production.js` (542 LOC)   | OK (30957 B) | **FAIL**  | n/a             | function `#53 "mapIntoArray"` — `fallthru[0] expected i32, got f64 @+15636`                                                    |

Two distinct **NEW** blockers (D); the others either reduce to known issues
(`process.env.NODE_ENV` DCE — #1043) or expose a previously-unobserved
side-effect of `&&`-guarded IIFE handling (C).

---

## NEW issue 1 — `react.production.js`: `mapIntoArray` fallthru type mismatch (i32 vs f64)

### Binary

- `compileProject("node_modules/react/cjs/react.production.js", { allowJs: true })`
- 542 LOC of React core: `createElement`, `Children.map`, `cloneElement`,
  `createContext`, `forwardRef`, `memo`, `lazy`, the `mapIntoArray` reconcilable-
  child traversal helper.

### Reproducer

```ts
import { compileProject } from "./src/index.ts";
const r = compileProject("node_modules/react/cjs/react.production.js", { allowJs: true });
expect(r.success).toBe(true); // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true); // currently fails
```

### Error

```
function #53 "mapIntoArray":
  fallthru[0] expected i32, got f64 @+15636
```

`WebAssembly.validate` returns `false`; `new WebAssembly.Module(...)` throws
with the message above.

### Likely source-code site

`react.production.js:146-254` — `function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback)`.
The function has at least four return paths:

```js
function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
  // ...
  if (invokeCallback)
    return (
      // ...complicated comma-expression...
      1     // ← literal 1, codegen infers return as i32
    );
  invokeCallback = 0;                          // initialized to 0
  // ...iteration...
  for (var i = 0; i < children.length; i++)
    // ...
    invokeCallback += mapIntoArray(...);       // recursive add — codegen may
                                                //   widen `invokeCallback` to f64
  // ...
  return invokeCallback;                       // ← inferred f64
}
```

The `return 1` literal at line 205 is inferred i32; the
`return invokeCallback` at line 253 is inferred f64 (because `invokeCallback`
has been `+=`-accumulated from recursive calls, and number arithmetic widens
to f64). Wasm function fallthru / branch result types must be uniform — the
mismatch surfaces as `fallthru[0] expected i32, got f64`.

### Proposed issue title

`react.production.js: mapIntoArray fallthru type mismatch (i32 vs f64 from mixed-literal/arithmetic returns)`

### Feasibility

**medium** — same family as #1558 (ESLint `Linter_verifyAndFix` f64-eq i32
coercion). The fix is to unify return types across all branches: when any
branch returns f64-inferred arithmetic, the i32-literal `return 1` must be
coerced to `f64.const 1`. This is a codegen-side return-type unification
pass, not a language-feature gap.

### Bug class

**CODEGEN bug** — number-type unification across return branches.

### Shared with other libs?

- **Likely shared with ESLint #1558** (`f64.eq[0]` expected f64 found i32) —
  same root cause: mixed-literal + arithmetic numeric return paths.
- **Likely shared with axios** (compute-heavy I/O paths with retry counters)
  but not yet confirmed; the parallel axios probe (#1032) should look for
  the same fallthru signature.

---

## NEW issue 2 — `react/index.js` CJS dispatch: `process.env.NODE_ENV` lookup throws at module init

### Binary

- Entry A — TS shim `import React from "react"` (resolves to `react/index.js`).
- Entry B — direct `compileProject("node_modules/react/index.js", { allowJs: true })`.

Both produce **valid** Wasm modules (tiny, 640-1066 B). Both fail at
`WebAssembly.instantiate` with the same runtime exception:

```
ReferenceError: process is not defined
    at hint (src/runtime.ts:2533:17)
    at fn (src/runtime.ts:5138:27)
    at __module_init (wasm-function[N])
```

### Source

`node_modules/react/index.js` (5 lines):

```js
"use strict";
if (process.env.NODE_ENV === "production") {
  module.exports = require("./cjs/react.production.js");
} else {
  module.exports = require("./cjs/react.development.js");
}
```

### What happens today

- The compiler emits `env.__extern_get("process")` at module init.
- `buildImports` provides `__extern_get` but the underlying host lookup
  raises `ReferenceError` because **`process` is not a globalThis property
  in the runtime stub**. The host shim in `src/runtime.ts:2533` faithfully
  re-throws.
- The `require()` calls on lines 3 and 5 are **never traced** by
  `resolveAllImports` — the resolver does not look inside conditional
  branches of `if` statements. So the actual React implementation (whether
  dev or prod) is not part of the compiled binary regardless.

### Proposed issue title

`Resolver: trace both branches of NODE_ENV `if` dispatch in CJS package entries (`react/index.js`-style shims)`

### Feasibility

**medium-hard** — two pieces:

1. **Resolver: trace `require()` calls inside `if (process.env.NODE_ENV === ...)` branches.**
   Currently `resolveAllImports` walks ES6 imports and top-level
   `require()` calls. It does **not** descend into `if` branches. Either
   (a) walk into branches unconditionally and union both targets, or
   (b) statically fold `process.env.NODE_ENV` (covered by #1043) so the dead
   branch is dropped before resolution. Option (b) composes better with
   the existing dead-code path.
2. **Runtime: provide a `process` stub** (at minimum a `{ env: { NODE_ENV:
"production" } }` placeholder) so that legacy modules that hit this
   pattern after #1043 cover the prod-only path don't trip `ReferenceError`
   at init.

### Bug class

**RESOLVER + RUNTIME gap** — not a codegen correctness issue.

### Shared with other libs?

- **Shared with axios** — `axios@1.x` has the same `cjs/axios.cjs` vs
  `esm/axios.js` dispatch in its `index.js`. The parallel axios probe will
  almost certainly hit this.
- **Not shared with lodash** — `lodash/identity.js` is a direct CJS module
  with no NODE_ENV gating.
- **Not shared with ESLint** — `eslint/lib/api.js` is a single-version
  entry with no NODE_ENV branch.
- **Pre-existing umbrella:** #1043 (`process.env.NODE_ENV` DCE) — landing
  #1043 _might_ solve this for free if the constant-folded condition causes
  the resolver to walk only the live branch. Worth verifying after #1043
  lands; this issue stays open as a runtime-stub fallback.

---

## NEW issue 3 — `react.development.js`: `&&`-guarded IIFE dead-code eliminates entire module body

### Binary

- `compileProject("node_modules/react/cjs/react.development.js", { allowJs: true })`
- 1284 LOC of React dev build — full body wrapped in:
  ```js
  "production" !== process.env.NODE_ENV &&
    (function () {
      /* 1280 lines of React core */
    })();
  ```
- Resulting binary: **9285 B, validates OK, instantiates OK, zero exports**.
  Stripping the `"production" !== process.env.NODE_ENV &&` guard manually
  produces an **84,756 B** binary with **75 exports** (`__cb_0`..`__cb_N`
  hoisted closures) — confirming the rest of the source compiles when the
  guard is removed.

### What happens today

- The codegen sees `"production" !== process.env.NODE_ENV` as `"production" !== <extern_get>` — neither side is a static literal, but the result still folds to `false` somewhere in the IR pipeline (or the entire RHS of `&&` is treated as a side-effect-free expression that doesn't need to be evaluated at compile time).
- The IIFE on the right-hand side of `&&` is never reached by tree-shaking
  or function-collection — so all its inner functions are dropped and the
  binary contains only the (empty) top-level scaffolding.
- Result: the development build silently becomes a no-op binary.

### Proposed issue title

`Codegen: \`&&\`-guarded IIFE in CJS dev-build silently drops module body (react.development.js → 0 exports)`

### Feasibility

**easy-medium** — likely a side-effect of an existing optimizer pass that
treats the RHS of `&&` as eliminable when the LHS's truthiness isn't known
to be `true`. Fix candidates:

1. **Conservative:** never DCE the RHS of `&&` / `||` when the LHS is not a
   compile-time literal.
2. **Cleaner:** combine with #1043 (`process.env.NODE_ENV` DCE) — when
   `NODE_ENV` is statically known, both `react.production.js` and the
   `react.development.js` guard fold deterministically (prod → drop dev
   body; dev → drop the guard and keep the body).

### Bug class

**CODEGEN bug** (dead-code elimination over-eager on `&&` short-circuit
RHS) — likely the smallest and highest-leverage fix in this survey.

### Shared with other libs?

- **Unique to React** today (the `"production" !== process.env.NODE_ENV && (IIFE)()` pattern is a Facebook/Meta convention).
- **Maybe shared with axios** if it uses the same dev-only IIFE guard
  (unlikely; axios bundles dev-only checks inline).
- **Not seen in ESLint or lodash** to date.

---

## Tier-1 recommendation

After landing the three NEW issues above, the React tier-1 ladder
(`tests/stress/react-tier1.test.ts`) should progress as follows:

| Rung                                                               | Today                 | After NEW issue 1 (mapIntoArray) | After NEW issue 2 (process stub) | After NEW issue 3 (`&&` DCE)       |
| ------------------------------------------------------------------ | --------------------- | -------------------------------- | -------------------------------- | ---------------------------------- |
| 1a. bare-package TS entry compiles                                 | pass                  | pass                             | pass                             | pass                               |
| 1b. binary validates                                               | pass                  | pass                             | pass                             | pass                               |
| 1c. `react.development.js` direct compile succeeds                 | pass                  | pass                             | pass                             | pass                               |
| 1d. binary validates (real body)                                   | empty pass (no body!) | empty pass                       | empty pass                       | **real pass — 84 KB body emitted** |
| 1e. `React.createElement('div', null, 'hello')` returns an element | fail                  | fail (no body)                   | fail (no body)                   | **needs DOM host imports — #1045** |

So the dependency chain is roughly:

```
React-Tier-1 (rung 1e — Counter smoke test)
  └─ #1045 DOM host imports
  └─ #1043 process.env.NODE_ENV DCE
       └─ NEW issue 3 (`&&` DCE over-eager)
       └─ NEW issue 2 (process stub / branch tracing)
  └─ NEW issue 1 (mapIntoArray return-type unification)
  └─ #1559 resolver: prefer impl over .d.ts (for bare-package import)
```

## Acceptance criteria (this survey)

- [x] Three plausible entry points probed (TS shim, CJS shim, real CJS body).
- [x] One representative blocker captured per entry with reproducer + likely
      source line + proposed issue title + feasibility + bug class.
- [x] Cross-library applicability noted for each blocker (shared with axios /
      ESLint / lodash where relevant).
- [x] Tier ladder mapping shows which rung unblocks after each fix.
- [x] `tests/stress/react-tier1.test.ts` filed alongside this survey,
      pre-skipped at rungs that depend on unlanded issues.

## Non-goals

- Filing the actual sprint issues — that is the PO's job once the next
  sprint planning starts. This survey just provides the actionable inputs.
- Running Tier 2 (hooks) or Tier 3 (reconciler) probes. Tier 1 must compile
  first.
- Solving any of the blockers. This is a survey, not an implementation PR.
