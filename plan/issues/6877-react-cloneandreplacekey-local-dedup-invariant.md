---
id: 6877
title: "react compiles to a codegen invariant failure on both lanes: `cloneAndReplaceKey` references out-of-range locals after local dedup"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions
goal: architecture
parent: 6749
related: [5385, 6749, 6876]
---

# #6877 — react's first real compile fails in local dedup

## Problem

With #6876 (in-branch `require` hoist) react is compiled for the first time on
both npm-compat lanes, and both fail at the same place (2026-10-06,
`--only react --perf-only`):

| lane | diagnostic |
| --- | --- |
| `js-host` | `Internal error compiling function 'cloneAndReplaceKey': codegen invariant: 'cloneAndReplaceKey' references out-of-range local(s) 159, 203 after local dedup (params=2, locals=5, before=5)` |
| `js-host-native` | same, locals 155, 199 `(params=2, locals=7, before=7)` |

`cloneAndReplaceKey` is react's `cjs/react.development.js` helper
(`function cloneAndReplaceKey(oldElement, newKey) { … ReactElement(oldElement.type, newKey, undefined, undefined, oldElement._owner, oldElement.props, …) }`
in 19.x). The body references locals 159/203 while the function has 7 — a
local index baked from another function's context (a shared helper emitted
while this function was being compiled, or a late-import index shift of the
#6687 kind), caught by the post-dedup invariant.

## Reduction and root cause (2026-10-06)

Twelve lines reproduce it, `compileProject({ allowJs: true, platform: "node" })`,
any import order:

```js
// dev.js — react.development.js's shape: everything inside one IIFE
(function () {
  var x0 = 0; /* … */ var x59 = 59;
  function helper(v) { return v + x40 + x59; }
  function cloneAndReplaceKey(oldElement, newKey) { newKey = helper(oldElement.v); return newKey + x50; }
  exports.va = function () { return cloneAndReplaceKey({ v: 1 }, 0); };
})();
// prod.js — react.production.js's shape: the same names at module scope
function helper(v) { return v; }
function cloneAndReplaceKey(oldElement, newKey) { newKey = helper(oldElement.v); return newKey; }
exports.vb = function () { return cloneAndReplaceKey({ v: 1 }, 0); };
// main.js
import dev from "./dev.js"; import prod from "./prod.js";
```

`'cloneAndReplaceKey' references out-of-range local(s) 43, 62` — those are
`x40` / `x59`, the IIFE locals dev's nested `helper` captures. Renaming
prod's `helper` moves the failure to the next shared name
(`cloneAndReplaceKey` read from the exported closure: `'__closure_4'
references local 58`), and the dev-first order then dies with
`unexpected undefined AST node in compileExpression`.

Root cause: `ctx.funcMap` and `ctx.nestedFuncCaptures` are keyed by BARE
name and are global across the whole multi-module compile
(`src/codegen/context/types.ts` ≈ L3296, by design, with `funcMapOwnerDecl`
as the shadowing record). The transitive capture collector in
`src/codegen/closures.ts` (the worklist at ≈ L920–945: `if
(ctx.funcMap.has(name) && ctx.nestedFuncCaptures.has(name)) fnWorklist.push(name)`)
follows any referenced name that SOME nested function owns, regardless of
which module or frame declared it, and merges that function's capture plan
(outer local indices of ANOTHER frame) into the current function. The
`forceValueNames` escape hatch on that collector is the same bug patched for
one Deno case. Any two bundles in one project that share a function name
where one copy is nested (every `development`/`production` pair) hit it.

## Fix direction

In the collector, follow a name only when its owner is visible from the
current frame: `ctx.funcMapOwnerDecl.get(name)` is undefined (a true top-level
or helper) or is a declaration lexically enclosing the current `fctx.decl`
(same source file and `nodeIsInside`). A same-named top-level declaration in
another module must resolve through the checker's declaration
(`sourceFunctionHandleByDeclaration`), never through the bare name. Add the
reduction above as `tests/issue-6877-*.test.ts` (both import orders, gc +
regime + standalone) and keep the Deno `forceValueNames` test green.

## Next step

Reduce from `tests/dogfood/.react/package/cjs/react.development.js`: compile
the file alone with `compileProject({ allowJs: true, platform: "node" })`,
then bisect `cloneAndReplaceKey` and its callees (`ReactElement`,
`hasValidKey`, the dev-only `Object.defineProperty(element, "_store", …)`
block) until the smallest body that still trips the invariant. Record which
emitter wrote the stray index (`allocLocal` caller) — the fix is at that
emitter, not in the dedup pass.

## Acceptance

- [ ] Reduced repro in `tests/issue-6877-*.test.ts` compiles and runs on
      default gc, the native regime and `--target standalone`.
- [ ] react measures on both npm-compat lanes with Node's checksum (the
      #6876 acceptance box this blocks).
