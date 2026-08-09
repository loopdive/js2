---
id: 3930
title: "compileProject links only top-level `const X = require()` — every other static require is silently dropped from the graph"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: resolver, module-resolution
language_feature: commonjs
goal: npm-library-support
sprint: current
horizon: m
es_edition: n/a
related: [1075, 1279, 1400, 2700, 3654, 3687]
---

# #3930 — nested static `require()` never enters the compileProject graph

## What you will see (the observable, before any mechanism)

You `compileProject` an npm package. **The compile reports `success: true`.**
`result.errors` is empty. You instantiate it, call an export, and it throws —
typically `undefined` on a member access — for a module the package plainly
requires and that plainly exists on disk. Running the exact same files under
Node works.

If you look at the graph, the required file simply **is not in it**. Nothing
told you. This is the "green compile, wrong program" shape, and the compiler is
the thing that is wrong, not your code.

Recognisable if: your package's `require()` is anywhere other than a
**top-level `const X = require("Y")`** — inside a factory function, inside an
IIFE, on the right of `module.exports = setup()`.

Carried out of the closed **PR #3687** (`codex/1400-eslint-e2e`). Independently
re-measured against `origin/main` @ `e4187572` on 2026-07-31 — this reproduces
on current `main`, it is not a branch artifact.

## Mechanism

`src/cjs-rewrite.ts` (#1279) rewrites CommonJS to ESM imports **only** for
top-level `X = require("Y")` variable declarations. `resolveAllImports` walks
the graph by parsing the *rewritten* source for import specifiers, so any
`require()` that is not in that shape contributes **no graph edge**. The module
is never resolved, never compiled, and never linked — and the compile still
reports `success: true`. The failure surfaces only at runtime, as an undefined
value far from the cause.

Two real shapes hit this, both present in the ESLint dependency closure:

- **factory-invoked require** — `debug`'s `common.js` does
  `module.exports = setup()` where `setup()` performs a static
  `require("ms")`. The require executes during module initialization; it is
  simply not a top-level declaration.
- **UMD free-`exports` IIFE** — `esrecurse` mutates a free `exports` object
  from inside an IIFE that requires its dependencies in the same scope.

## Measured evidence (2026-07-31, `origin/main` @ `e4187572`)

Fixture (`.tmp`, three files):

```js
// ms.js
module.exports = function msValue() { return 1000; };

// common.js  — debug-shaped factory
module.exports = setup();
function setup() {
  var ms = require("./ms.js");
  return { humanize: ms };
}

// entry.js
const common = require("./common.js");
export function test() { return common.humanize(); }
```

| observation                                                     | result                             |
| --------------------------------------------------------------- | ---------------------------------- |
| `resolveAllImports(entry, resolver)` keys                       | `entry.js`, `common.js` — **no `ms.js`** |
| `compileProject(entry, { allowJs: true, target: "gc" })`         | `success: true`                    |
| instantiate + call `test()`                                     | **throws** (`undefined`)           |
| Node running the same three files                               | `1000`                             |

So: the graph is silently incomplete, the compiler reports success, and the
program is wrong at runtime. That combination is the reason this is filed
`high` rather than as a resolver nicety — it is a **silent** link hole, and per
the project's silent-empty rule a "successful" compile of an incomplete graph
is indistinguishable from a correct one.

## Not the whole story — eagerness must stay bounded

The obvious fix (link every `require()` anywhere in the file) is wrong in the
other direction, and PR #3687 measured why: ESLint's built-in rule map contains
hundreds of `() => require("./rule")` lazy loaders. Eagerly importing those
expands a minimal `Linter` graph from tens of executable files to the entire
rule catalog — which is a large part of why #3672's 149-file graph exhausted a
2 GB heap.

PR #3687's `src/cjs-rewrite.ts` (branch `codex/1400-eslint-e2e` @
`561c933af16651e49f50556b8128967892ce529e`) carries a worked version of the
selection rule. Its heuristics, in its own terms:

- a `require` inside a **non-immediately-invoked** function expression or arrow
  is **lazy** — do not link it; an IIFE's requires **do** execute at module
  init, so they are linked;
- a `require` inside a `try { … } catch { … }` is conventionally **optional**
  (`try { require("colors") } catch {}`) — leave it in place so the runtime
  catch path selects the fallback;
- with `platform: "node" | "deno"`, an `if` whose condition mentions
  `typeof process` and `process.type|browser|__nwjs` links only the
  **else** arm (the `debug`-style host selector); the browser branch keeps its
  original `require` in an unreachable arm;
- named **function declarations** stay traversed, because CommonJS factories
  such as `debug`'s `setup()` are invoked by their importing module.

That branch also threads `platform` from `CompileOptions` into `ModuleResolver`
(`getPlatform()`) and into `rewriteCjsRequire(content, { platform })` from both
`resolve.ts` and `compiler.ts`, which is what makes the selector rule
reachable. Those threading edits are small and independent of the parked #3798
identity work.

## Scope

**In scope**: `src/cjs-rewrite.ts`, the `platform` threading in `src/resolve.ts`
and `src/compiler.ts`.

**Out of scope / do not pull in**: anything from PR #3687 touching
`src/codegen/function-identity.ts`, `module-global-registration.ts`, or the
`call-identifier.ts` identity rework — that cluster is parked behind #3798 and
is not independently landable.

`module.exports`/free-`exports` **object wrapping** (also in that branch's
`cjs-rewrite.ts`) belongs to **#1075**, which owns CommonJS export surface.
`main` already handles `module.exports = <fn>` via `src/codegen/declarations.ts`
pattern matching (proved by `tests/issue-3654.test.ts`'s `lib/helper.js`), so
do not re-do it here; if the graph-linking fix needs the wrapping to be useful,
say so and coordinate with #1075 rather than duplicating the mechanism.

## Acceptance criteria

1. The fixture above: `resolveAllImports` includes `ms.js`, and `test()`
   returns **1000** under Node instantiation. (Wrong-value criterion, not
   compiles/validates.)
2. **Bounded eagerness, with a number**: a fixture whose module exports a map
   of `() => require("./rule-N.js")` lazy loaders for N = 1..20 yields a graph
   of **2** files (entry + the map module), not 22. Assert the count, not a
   boolean.
3. A `try { require("optional") } catch {}` fixture still compiles and the
   optional module is not added to the graph.
4. `platform: "node"` on a `typeof process`-selector fixture links the else
   arm; `platform: "web"` leaves current behaviour unchanged.
5. No growth in `pnpm run check:ir-fallbacks` unintended buckets, and
   `tests/issue-3654.test.ts` / `tests/issue-3655.test.ts` stay green (they
   exercise the resolver graph directly).
