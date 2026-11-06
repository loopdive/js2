---
id: 6877
title: "react compiles to a codegen invariant failure on both lanes: `cloneAndReplaceKey` references out-of-range locals after local dedup"
status: done
created: 2026-10-06
updated: 2026-10-07
completed: 2026-10-07
assignee: ttraenkler/opus-6877
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions
goal: architecture
parent: 6749
related: [5385, 6705, 6749, 6876, 6890]
loc-budget-allow:
  # 2026-10-07 (#6877): +1..+3 lines each — the import of the new bare-name
  # visibility helpers plus a one-line call-site change; the helpers themselves
  # live in nested-function-name-scope.ts / module-init-chunks.ts /
  # program-abi-source-callable-planning.ts.
  - src/codegen/closures.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
  - src/codegen/string-ops.ts
func-budget-allow:
  # 2026-10-07 (#6877): +1..+2 lines — the visibility guard at the existing
  # bare-name read inside each function; logic is in the helper modules.
  - src/codegen/closures.ts::promoteAccessorCapturesToGlobals
  - src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall
  - src/codegen/statements/variables.ts::compileVariableStatement
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

## Implementation notes (2026-10-07, opus-6877)

The reduction exposes THREE bare-name readers, not one. Each fix makes the
reader resolve through the binding it is actually compiling, and each is a
no-op when names do not collide (sha256 of single-module programs unchanged on
default gc / standalone / wasi, below).

1. **Top-level body slot** (`declarations.ts`, `ownTopLevelFunctionPosition` →
   `program-abi-source-callable-planning.ts`). The production module's
   top-level `cloneAndReplaceKey` body was compiled INTO the development IIFE's
   nested function: `funcByName` defers to `ctx.funcMap`, and the multi-source
   driver re-binds a name per source only when two TOP-LEVEL declarations share
   it (#4133's `collectMultiIrFunctionNameCollisions`). A nested declaration
   registered during the graph-wide `__module_init` pass is invisible to that
   snapshot. The real top-level slot was left a `ref.null` stub and the nested
   slot got a body with the wrong signature — the `unexpected undefined AST
   node in compileExpression` and the invalid-module failures. Now the body
   slot is resolved from the declaration's exact source handle
   (`sourceFunctionHandleByDeclaration`); the name lookup stays the fallback.
2. **Direct-call capture prepend** (`call-identifier.ts`, `string-ops.ts`
   tagged templates; helper `nestedCapturesForCallee` in
   `nested-function-name-scope.ts`). `withDeclarationBoundCallee` (#1058)
   already re-points `funcMap[name]` at the checker's own top-level declaration
   for the call, but `nestedFuncCaptures[name]` still held the development
   IIFE's plan, so its outer local indices (43/62 — `x40`/`x59`) were
   prepended. The plan is now used only when the call's target handle belongs
   to `funcMapOwnerDecl[name]`.
3. **Closure / callback / accessor capture collection** (`arrow-phases.ts`
   `planClosureCaptures`, `closures.ts` `compileArrowAsCallback` and the
   `promoteAccessorCapturesToGlobals` worklist; helper
   `nestedCapturesVisibleFrom` / `nestedFuncOwnerIsForeignTo`). A closure that
   references `cloneAndReplaceKey` followed the other module's nested plan
   transitively. A plan is now followed only when its owner is not in a
   DIFFERENT source file than the reference. Deliberately cross-file only:
   same-file shadowing is the #4456 shadow stack's job, and eval code parses
   into its own synthetic `SourceFile` whose declarations live in the host
   frame, so an eval file on either side never counts as foreign. The Deno
   `forceValueNames` escape (#5148) is untouched and its test stays green.

Why not restore the registration with the #4456 shadow stack instead: the
development module's IIFE is flattened into `__module_init`, its nested
closures compile later in the same pass, so its registrations must stay live
for the rest of the compile — a scope close cannot be placed. The readers
therefore have to ask which binding they serve.

**Second react failure, same family** (`statements/variables.ts`). Once react
compiled, the host lane died at module init with `undefined is not a function`:
in a CHUNKED module initializer `hasLocalShadow` is forced false (a chunk owns
only temporaries, #4376), so the development IIFE's `var assign =
Object.assign` initialized the production module's top-level `assign` global
(bare-name `moduleGlobals`) while every read used the IIFE's local. A
declaration nested inside a function can never bind a module global, so the
local wins there (`chunkDeclarationIsFunctionLocal` in `module-init-chunks.ts`).
This is also a single-module bug: `var assign = 1; … (function () { var assign
= 7; … })()` with ≥ 17 init entries returned 36 instead of 37 on default gc.

Not fixed here: same-named top-level bindings in two modules still share one
`moduleGlobals` cell (#6705 — includes the CJS prelude's `exports`, which is
why the test's `prod.js` uses a single `module.exports =`).

## Results (2026-10-07, box load 100–200)

- Reduction, both import orders: base — CE on every lane (`references
  out-of-range local(s) 43, 62` / `unexpected undefined AST node`); fix —
  `va = 150, vb = 1` on default gc, native-first and `--target standalone`.
  `tests/issue-6877-cross-module-bare-name-captures.test.ts`: base 0/13, fix
  13/13.
- react, npm-compat `--perf-only`:
  - `js-host`: base `compile-error` (the invariant) → **measured**, checksum
    8 = Node 8 (115,209 B at -O4).
  - `js-host-native`: base `compile-error` → `runtime-error @ module-init:
    Cannot access property on null or undefined at 681:5` — react's
    `console.createTask` feature test; `console` read as a value is null under
    the regime in a JS environment. Separate root cause, filed as **#6890**
    (with `console.createTask` blanked the lane measures checksum 8).
- sha256 (single-module probes with nested functions, tagged template,
  closures): default gc / standalone / wasi identical on base and fix, except
  the chunked IIFE-`var` probe on default gc, whose base output was the wrong
  answer above.

## Acceptance

- [x] Reduced repro in `tests/issue-6877-*.test.ts` compiles and runs on
      default gc, the native regime and `--target standalone`.
- [ ] react measures on both npm-compat lanes with Node's checksum — `js-host`
      measured; `js-host-native` moved to #6890 (different root cause).
