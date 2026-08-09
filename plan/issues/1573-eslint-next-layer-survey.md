---
id: 1573
title: "ESLint next-layer validation-error survey (post #1557 / #1558)"
status: done
created: 2026-05-20
updated: 2026-07-26
completed: 2026-06-26
priority: high
feasibility: hard
reasoning_effort: high
task_type: planning
area: codegen
language_feature: npm-package-integration
goal: npm-library-support
sprint: 66
assignee: ttraenkler/sendev-eslint
es_edition: n/a
owner: tech-lead
related: [1400, 1289, 1287, 1282, 1557, 1558, 1559, 1560, 2688, 2689, 2690, 2691, 2693, 2700, 3653, 3654, 3655, 3656, 3657]
---
# ESLint next-layer validation-error survey

> **2026-07-26 bounded refresh.** The June **16/21 validate** result remains a
> historical measurement; the full 21-module matrix was not rerun and must not
> be presented as current. A fresh six-target critical-path sample measured
> **3 compile+validate / 1 compile+invalid / 2 compile-fail**; see #1400 for the
> exact matrix. `config.js`, `apply-disable-directives.js`, and
> `source-code.js` still validate. `rule-tester.js` still fails exactly as
> #2690 describes. The package entry and direct `linter.js` now stop before
> Wasm on #3654/#3655/#3656. Test portability/vacuity is #3653.

> **DE-STALED 2026-06-26 (sprint 66).** The sprint-53 matrix below is STALE —
> see `## 2026-06-26 re-scan (current main)` for the accurate frontier. ESLint
> is now **v10.0.3** (the stale matrix scanned an older version; file layout
> changed). On a fresh scan of 21 ESLint internal modules, **16/21 now
> VALIDATE** — the stale #1557/#1558 blockers are GONE and the entire core
> linting algorithm validates clean. This issue's **bug A**
> (`LazyLoadingRuleMap_new` `f64.convert_i32_s expected i32, found externref`)
> was root-caused and FIXED in the stack-balance pass (`inferLastType`),
> unblocking 3 binaries. Residual blockers carved as #2688/#2689/#2690/#2691;
> node:path (linter.js) tracked by #1791-#1794.

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

---

## 2026-06-26 re-scan (current main)

ESLint is now **v10.0.3** (the stale matrix above scanned an older version; the
file layout changed — e.g. `source-code.js` moved to `languages/js/source-code/`,
`config/config.js` is new). Re-scan of 21 internal modules on upstream/main
(`be4736e43`), AFTER this issue's bug-A fix landed:

**16/21 VALIDATE · 19/21 compile.** Stale #1557 (`__obj_meth_tramp` arity) and
#1558 (`verifyAndFix` `f64.eq`) are GONE — `config.js` validates clean. The
whole core linting algorithm validates: all 3 `code-path-analysis` modules,
`source-code-traverser`, `source-code-visitor`, `esquery`, `interpolate`,
`timing`, `vfile`, `file-context`, `file-report`, `rule-fixer`,
`source-code-fixer`, `flat-config-array`, `default-config`.

| Binary | Validate? | First error | Follow-up |
|--------|-----------|-------------|-----------|
| `config/config.js` | OK | — | |
| `config/flat-config-array.js` | OK (was bug A) | — | fixed by bug A |
| `config/default-config.js` | OK (was bug A) | — | fixed by bug A |
| all `linter/code-path-analysis/*` (3) | OK | — | |
| `linter/source-code-traverser.js`, `…-visitor.js`, `rule-fixer.js`, `source-code-fixer.js`, `interpolate.js`, `esquery.js`, `timing.js`, `vfile.js`, `file-context.js`, `file-report.js` | OK | — | |
| `linter/apply-disable-directives.js` | FAIL | `applyDirectives` `array.set` `(ref null 107)` vs `call_ref (ref null 118)` — conditional-spread two struct shapes | **#2688** |
| `languages/js/source-code/source-code.js` | FAIL | `SourceCode_new` `return_call: tail call type error` | **#2689** |
| `rule-tester/rule-tester.js` | FAIL | `cloneDeeplyExcludesParent` `local.tee (ref null 2)` vs `i32` — polymorphic return (was bug A, now this) | **#2690** |
| `linter/linter.js` | CE | `Cannot find module 'node:path'` | **#1791-#1794** |
| `api.js` | CE | re-export `'ESLint' declared locally but not exported` | **#2691** |

### Bug A — FIXED (this PR)

`LazyLoadingRuleMap_new` `f64.convert_i32_s expected i32, found externref` (hit
`flat-config-array.js`, `default-config.js`, `rule-tester.js`). **Root cause:**
`inferLastType` in `src/codegen/stack-balance.ts` walked a branch arm backwards
to find its result type but had **no case for structured control flow**
(`if`/`block`/`loop`/`try`). For an arm shaped `[ call(→externref),
local.get $cell, ref.is_null, i32.eqz, if(void) ]` (a host array-HOF call
followed by a null-guarded **callback-capture writeback**), it skipped the
trailing void `if` and misread the writeback's internal `i32.eqz` as the arm's
result → `"i32"`. `fixBranchType` then spliced `f64.convert_i32_s +
__box_number` to coerce that phantom i32 → externref, over the real externref
value → invalid Wasm. **Fix:** `inferLastType` now stops at a structured
instruction and reports its block result type (or null when void/multi-value,
so `fixBranchType` SKIPS rather than mis-coerces). General fix (not
eslint-specific): any `expectedExternref(cond ? arr.map(capturingCb) : x)` shape
— and other callback-writeback-in-branch shapes — hit this. Regression test:
`tests/issue-1573-map-capture-branch-validate.test.ts`.

### Minimal-Linter.verify gate-list (the runway to "ESLint RUNS as Wasm in Node")

Parse is **host-delegable**: `ParserService.parseSync` does
`language.parse(file, {languageOptions})` — a host-provided `language` whose
`.parse` is a host import (Node espree/acorn) makes `Linter.verify` run WITHOUT
compiled acorn, i.e. **decoupled from acorn #2674**. The full real-eslint
`Linter.verify` end-to-end still needs:

1. **Bug A** — FIXED (this PR).
2. **#2688** apply-disable-directives.js conditional-spread struct shape.
3. **#2689** source-code.js `SourceCode_new` return_call tail-call type.
4. **#2691** api.js re-export resolution.
5. **#1791-#1794** node:path (and node:fs/url) — linter.js's only `node:` import
   is `node:path`. On the critical path for the real Linter.
6. **npm dep tree**: eslint-scope, @eslint/plugin-kit, @eslint/core, espree,
   debug — each a separate package that must compile (or be host-shimmed).
7. **#2690** rule-tester.js polymorphic return (NOT on the verify critical path
   — rule-tester is test-authoring infra).

Recommended FIRST runnable milestone: a minimal Linter-shaped program (walk AST,
apply one rule e.g. `semi`, return messages) compiled to Wasm + instantiated in
Node with parse as a host import (the acorn-#1712 parallel). Full real-eslint
Linter is the end-state once the gate-list clears.
