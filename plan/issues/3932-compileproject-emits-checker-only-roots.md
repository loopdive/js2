---
id: 3932
title: "compileProject emits Wasm bodies for checker-only roots (JSDoc-type-only modules)"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: performance
area: compiler, module-resolution
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
horizon: s
es_edition: n/a
related: [1400, 3654, 3672, 3687]
---

# #3932 — checker-only roots get compiled into the binary

## What you will see (the observable)

Your `compileProject` binary contains functions from modules your program never
imports at runtime — modules that appear in the graph only because a **JSDoc
type annotation** mentions them. Compile time and binary size both pay for code
that can never be reached.

On a package graph the size of ESLint's this is not cosmetic: it is part of why
#3672's 149-file graph was expensive enough to exhaust a 2 GB heap.

## Measured on `origin/main` @ `e4187572` (2026-07-31)

Fixture — `only-typed.js` is a **real `.js` file** referenced *only* from a
JSDoc type position, with no executable import anywhere:

```js
// only-typed.js
export function markerOnlyReachableViaJsdoc(a, b) {
  return a * b + 12345;
}
export class TypedThing {
  constructor() {
    this.kind = "typed";
  }
}

// entry.js
/** @param {import("./only-typed.js").TypedThing} t */
export function test(t) {
  return t ? 1 : 2;
}
```

| observation                                                    | result                               |
| -------------------------------------------------------------- | ------------------------------------ |
| `resolveAllImports(entry, resolver)` keys                      | `only-typed.js`, `entry.js`          |
| `compileProject(entry, { allowJs: true, target: "gc" })`        | `success: true`                      |
| emitted WAT contains `markerOnlyReachableViaJsdoc`             | **true**                             |
| emitted WAT contains `f64.const 12345` (the body, not the name) | **true**                             |
| binary                                                          | 1155 bytes                           |

The second WAT check is the positive control: the *body* is emitted, not merely
a name in a debug section.

Pulling the module into the **Program** is correct — TypeScript needs it to
answer the type query. Emitting its **bodies** is not.

## Mechanism

`analyzeMultiSource` (`src/checker/index.ts`, ~line 1111) does an entry-anchored
DFS over executable imports, then unconditionally appends **every remaining
`rootName`** to `userSourceFiles`:

```ts
// Append any additional user files that weren't reached via the entry's import graph
// (the previous behaviour was to emit every rootName, so we keep that for safety).
for (const name of rootNames) {
  if (visited.has(name) || name === normalizedEntry) continue;
  …
  userSourceFiles.splice(userSourceFiles.length - 1, 0, sf);
}
```

That "for safety" fallback is right for `compileMulti`, whose caller hands in a
loose file set with no resolution graph. It is wrong for `compileProject`, which
supplies an **exact** filesystem graph in `projectResolutions` — there, a root
outside the executable DFS is a checker-visible edge by construction.

## Fix (from the closed PR #3687)

Branch `codex/1400-eslint-e2e` @ `561c933af16651e49f50556b8128967892ce529e`
gates the loop on the absence of a project-resolution graph:

```ts
if (!projectResolutions) {
  for (const name of rootNames) { … }
}
```

Two lines. It is the one piece of that PR's `src/checker/index.ts` change and is
independent of the parked #3798 identity work.

**Verify the premise before adopting, not after**: the claim is that with
`projectResolutions` present the DFS reaches every *executable* root. If some
real executable edge is only reachable via a rootName (a resolver gap rather
than a checker-only edge), this guard would silently drop live code — which is a
strictly worse failure than emitting dead code. A dropped-executable-root case
must be searched for, not assumed absent.

## Acceptance criteria

1. The fixture above: `compileProject` still succeeds and validates, and the
   emitted WAT contains **neither** `markerOnlyReachableViaJsdoc` **nor**
   `f64.const 12345`.
2. **Negative control** — a fixture where the same module is imported normally
   (`import { markerOnlyReachableViaJsdoc } from "./only-typed.js"`) still emits
   it and still returns the right value. Without this the change cannot be
   distinguished from "drops modules".
3. `compileMulti` (no `projectResolutions`) behaviour is unchanged — a test that
   passes a loose file set and asserts an unreferenced root is still emitted.
4. `tests/issue-3654.test.ts` and `tests/issue-3655.test.ts` stay green.
5. Report the ESLint-graph delta (compile time and binary bytes) if it is cheap
   to obtain — but do **not** gate the fix on a number from a graph that does
   not currently compile (#3798).
