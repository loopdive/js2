---
id: 1573
title: "ESLint next-layer validation-error survey (post #1557 / #1558)"
status: survey
created: 2026-05-20
priority: high
owner: tech-lead
area: codegen
goal: npm-library-support
related: [1400, 1289, 1287, 1282, 1557, 1558, 1559, 1560]
---

# ESLint next-layer validation-error survey

Anticipatory survey of ESLint internal modules to enumerate the validation
blockers that surface in the same binaries (or sibling binaries) once #1557
(`config.js __obj_meth_tramp` arity) and #1558 (`linter.js`
`Linter_verifyAndFix` `f64.eq`) land.

`WebAssembly.validate` only reports the **first** error per module — so each
result below pins one issue per binary. Devs fixing these will likely uncover
more errors in the same binary as each fix unblocks the validator; that is
already the pattern from the #1400 chain.

## Method

```ts
// .tmp/scan-eslint-binaries.ts (committed in worktree)
import { compileProject } from "../src/index.js";
const r = compileProject(absPath, { allowJs: true });
const ok = WebAssembly.validate(r.binary);
if (!ok) new WebAssembly.Module(r.binary); // throws with the first error
```

Run with `npx tsx .tmp/scan-eslint-binaries.ts`. Full machine-readable output:
`.tmp/scan-eslint-binaries.json`.

## Results matrix

| Binary | Compile? | Validate? | First error |
|--------|----------|-----------|-------------|
| `eslint/lib/config/config.js` | OK (36 KB) | FAIL | `__obj_meth_tramp___anon_0_validate_16` arity (need 2, got 1) — **#1557** |
| `eslint/lib/linter/linter.js` | OK (276 KB) | FAIL | `Linter_verifyAndFix` `f64.eq[0]` expected f64, found i32 — **#1558** |
| `eslint/lib/api.js` | OK (953 KB) | FAIL | same `Linter_verifyAndFix` `f64.eq[0]` — duplicate of #1558 |
| `eslint/lib/languages/js/source-code/source-code.js` | OK (40 KB) | FAIL | `__anon_4_enter` `global.set[0]` expected f64, found externref — **NEW** |
| `eslint/lib/rule-tester/rule-tester.js` | OK (327 KB) | FAIL | `cloneDeeplyExcludesParent` `local.tee[0]` expected `(ref null 1)`, found i32 — **NEW** |
| `eslint/lib/linter/code-path-analysis/code-path.js` | OK (59 KB) | OK | clean |
| `eslint/lib/linter/code-path-analysis/code-path-analyzer.js` | OK (31 KB) | OK | clean |
| `eslint/lib/linter/code-path-analysis/code-path-state.js` | OK (50 KB) | OK | clean |
| `eslint/lib/config/flat-config-array.js` | OK (77 KB) | FAIL | same `__obj_meth_tramp___anon_0_validate_16` (need 2, got 1) — duplicate of #1557 |
| `eslint/lib/config/default-config.js` | OK (29 KB) | OK | clean |
| `eslint/lib/linter/apply-disable-directives.js` | OK (58 KB) | FAIL | `applyDirectives` `array.set[2]` expected `(ref null 89)`, found `call_ref` returning `(ref null 102)` — **NEW** |

Three NEW distinct validation errors. The other failures duplicate #1557/#1558
(unsurprising — `api.js` is the public re-export bundle, `flat-config-array.js`
shares the same inline object-literal `validate(value, options)` schema
pattern). `code-path*.js` binaries validate cleanly, so no follow-up needed
there.

---

## NEW issue 1 — source-code.js: `global.set` expected f64, found externref in anonymous `enter` callback

### Binary
- `compileProject("/workspace/node_modules/eslint/lib/languages/js/source-code/source-code.js", { allowJs: true })`
- Real path under the repo: `node_modules/eslint/lib/languages/js/source-code/source-code.js`
  (the request named `eslint/lib/source-code/source-code.js` — that path does
  not exist; ESLint moved the file to `languages/js/source-code/` in recent
  versions).

### Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = compileProject(
  "/workspace/node_modules/eslint/lib/languages/js/source-code/source-code.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                       // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true);  // currently fails
```

### Error
```
function #81 "__anon_4_enter":
  global.set[0] expected type f64, found local.get of type externref @+31309
```

### Likely source-code site
`source-code.js` has two `enter(node)` shorthand methods inside object
literals passed to `Traverser.traverse(...)`. The named `__anon_4_enter`
points at the 5th anonymous function in declaration order; the most plausible
candidate is the `enter` at `getNodeByRangeIndex` (line 477):

```js
Traverser.traverse(this.ast, {
  visitorKeys: this.visitorKeys,
  enter(node) {
    if (node.range[0] <= index && index < node.range[1]) {
      result = node;        // captured from outer scope (let result = null)
    } else {
      this.skip();
    }
  },
  // ...
});
```

`result` starts as `null` (so its outer-scope ref-cell is typed `externref`),
then the inner closure writes `result = node` (also `externref`). But the
outer scope appears to have been promoted to `f64` (probably because some
other helper assigns a `f64` to the same lexical slot, or because the closure
capture's ref-cell field was inferred as `f64` from an earlier path).

The crash is in the **closure capture's `global.set`** — the codegen is
writing an externref into a global typed `f64`. That points at a
ref-cell field-type miscalculation in the captured-var widening logic
(`src/codegen/index.ts` `addUnionImports` / closure capture path).

### Proposed issue title
`ESLint source-code.js: anon enter closure captures externref into f64 global`

### Feasibility
**medium** — same family as #1303 / #1558. The fix likely lives in the
closure-capture type-inference path: when a binding is reassigned across an
externref-vs-f64 union, the captured ref-cell field must be widened to
`externref` (with f64 stores wrapped in `__box_number`), not f64.

### Bug class
**CODEGEN bug** (closure-capture type widening) — not a missing language
feature.

---

## NEW issue 2 — rule-tester.js: `cloneDeeplyExcludesParent` `local.tee` expected `(ref null 1)`, found i32

### Binary
- `compileProject("/workspace/node_modules/eslint/lib/rule-tester/rule-tester.js", { allowJs: true })`

### Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = compileProject(
  "/workspace/node_modules/eslint/lib/rule-tester/rule-tester.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                       // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true);  // currently fails
```

### Error
```
function #216 "cloneDeeplyExcludesParent":
  local.tee[0] expected type (ref null 1), found local.get of type i32 @+126042
```

### Source (real)
```js
function cloneDeeplyExcludesParent(x) {
  if (typeof x === "object" && x !== null) {
    if (Array.isArray(x)) {
      return x.map(cloneDeeplyExcludesParent);
    }
    const retv = {};
    for (const key in x) {
      if (key !== "parent" && hasOwnProperty(x, key)) {
        retv[key] = cloneDeeplyExcludesParent(x[key]);
      }
    }
    return retv;
  }
  return x;
}
```

### Hypothesis
`local.tee` storing the result of `local.get` typed `i32` into a local typed
`(ref null 1)` (likely an anyref/externref-ish struct ref). The classic place
this happens is a polymorphic recursive return: this function returns either
`x` (any) or `x.map(...)` (array) or `retv` (object) or the primitive
fall-through. The unified return-type slot was inferred as a struct ref
(probably from the `retv = {}` branch dominating type inference) but the
`return x` fallthrough where `x` is a primitive number routes an `i32`-typed
value through the same return slot.

Closest known issue: a polymorphic-return widening miss similar to #1303 /
#1378 but on the **return path** rather than parameter coercion.

### Proposed issue title
`ESLint rule-tester.js: cloneDeeplyExcludesParent polymorphic return widens i32 into anyref slot`

### Feasibility
**medium-hard** — return-type widening across `Array.isArray` / `typeof`
narrowing is a known gap. The fix is in the return-coercion path in
`src/codegen/statements.ts` (ReturnStatement) plus the unified-return-type
inference in `src/codegen/index.ts`. Recursive call-graph also factors in
(self-recursion + polymorphic return).

### Bug class
**CODEGEN bug** (return-type widening / type-coercion). Not a missing
language feature — the function is plain ES5.

---

## NEW issue 3 — apply-disable-directives.js: `applyDirectives` `array.set` struct-shape mismatch (89 vs 102)

### Binary
- `compileProject("/workspace/node_modules/eslint/lib/linter/apply-disable-directives.js", { allowJs: true })`

### Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = compileProject(
  "/workspace/node_modules/eslint/lib/linter/apply-disable-directives.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                       // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true);  // currently fails
```

### Error
```
function #114 "applyDirectives":
  array.set[2] expected type (ref null 89), found call_ref of type (ref null 102) @+33797
```

### Source (likely site)
`applyDirectives` builds three result arrays — `problems`, `usedDisableDirectives`
(a Set), and `unusedDirectives` — and most interestingly:

```js
const processed = processUnusedDirectives(unusedDisableDirectivesToReport, sourceCode)
  .concat(processUnusedDirectives(unusedEnableDirectivesToReport, sourceCode));
// ...
const unusedDirectives = processed.map(({ description, fix, unprocessedDirective }) => {
  // returns a fresh literal: { ruleId, message, line, column, severity, ...maybeFix }
  return {
    ruleId: null,
    message,
    line: ...,
    column: ...,
    severity: ...,
    ...(options.disableFixes ? {} : { fix }),
  };
});
```

The literal has a conditional-spread (`...(options.disableFixes ? {} : { fix })`),
which produces **two distinct struct shapes** — one with `fix`, one without.
The `array.set` is the codegen writing each `.map(...)` callback return into
a result-array element slot. The element-type was inferred as the
fix-less shape (struct 89), but the callback returns the fix-bearing shape
(struct 102). Conditional-spread struct-shape unification is missing.

### Proposed issue title
`ESLint apply-disable-directives.js: conditional spread produces two struct shapes for array.set element type`

### Feasibility
**hard** — conditional-spread struct unification is a known type-inference
gap. The fix is in shape inference (`src/shape-inference.ts`) and the array
element-type computation in `src/codegen/expressions.ts` for `Array#map`.
Either:
1. Treat the conditional-spread literal as a single struct shape that has
   `fix` as an optional (nullable) field, OR
2. Widen the array's element type to a common-supertype struct that
   covers both branches.

Option (1) is the cleaner long-term fix but requires nullable struct
fields with sane defaults; option (2) is the quick fix.

### Bug class
**CODEGEN bug** (struct-shape unification at object-literal level). Pure
JS object-literal feature, not async/generators/Proxy.

---

## Recommended dispatch order

1. Land **#1557** + **#1558** first (already in-flight) — these unblock
   `config.js`, `linter.js`, and `api.js` (api.js duplicates #1558).
2. Dispatch **NEW issue 1** (source-code.js closure-capture widening) —
   smallest binary, isolated to one anonymous callback, likely 1-day fix.
   Unblocks the source-code AST module.
3. Dispatch **NEW issue 3** (apply-disable-directives.js
   conditional-spread shape) — medium-size binary, well-isolated to one
   function, but the shape-inference change is broader (will likely
   unlock other binaries).
4. Dispatch **NEW issue 2** (rule-tester.js polymorphic return widening)
   last — `rule-tester.js` is least critical for end-user lint runs and
   the polymorphic-return widening is a riskier codegen change.

Note: NEW issue 3's fix (conditional-spread shape unification) may also
fix latent failures in `linter.js` / `flat-config-array.js` once their
own first-blockers are resolved — worth re-running the survey after
each fix to see what shifts.

## Confidence notes

- All three NEW errors are **CODEGEN bugs**, not missing language
  features. None of these binaries hit `async generators`, `Proxy`,
  `with`, `eval`, or other deferred features at validation time.
- The `code-path*.js` modules all validate cleanly, so the
  graph-traversal core of ESLint is already healthy. That's an
  encouraging sign — the remaining issues are concentrated in
  object-literal-heavy schema and config plumbing, not in algorithmic
  hot paths.
- Each binary's "first error" may mask N more errors in the same
  binary. Empirically (the #1400 → #1557/#1558 chain) each fix tends
  to unmask 1-3 more in the same binary. Plan capacity accordingly.

## Scan artifact

- Script: `/home/user/js2wasm/.tmp/scan-eslint-binaries.ts`
- JSON output: `/home/user/js2wasm/.tmp/scan-eslint-binaries.json`
- Re-run: `npx tsx .tmp/scan-eslint-binaries.ts`
