---
id: 5302
title: "Rolled-back speculative compile leaks the nested-function closure memo slot — invalid wasm on a chained call after arr.map(nestedFn)"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
related: [1847, 2029, 3032, 1919]
origin: "2026-09-03 prettier upstream suite triage — six unit files at 0/N, all failing WebAssembly.compile inside printDoc"
---

# #5302 — the nested-function closure memo slot does not roll back with its local

## Symptom

Six of prettier's upstream unit files compiled and then failed engine
validation wholesale, so every test in them scored 0:

```
tests/unit/doc-builders.js              0/46
tests/unit/is-empty-doc.js              0/16
tests/unit/print-doc-to-string.js       0/3
tests/unit/strip-trailing-hardline.js   0/2
tests/unit/traverse-doc.js              0/2
tests/unit/doc-printer.js               0/1
```

all with the same message, differing only in the type index:

```
CompileError: WebAssembly.compile(): Compiling function #443:"printDoc" failed:
  local.set[0] expected type (ref null 222), found ref.as_non_null of type (ref extern)
```

Reduced to a two-file untyped-`.js` project this is 5 lines:

```js
export function run() {
  const memo = [];
  function inner(x) { memo.push(x); return String(x); }
  const doc = ["a", "b"];
  return doc.map(inner).filter(Boolean).length;   // invalid wasm
}
```

`const m = doc.map(inner); m.filter(Boolean)` — the same program split across
two statements — was already valid. That is what hid it.

## Root cause

`emitMemoizedNestedFnClosure` (`src/codegen/closures/funcref-as-closure.ts`)
gives each **capture-carrying nested function declaration** one per-activation
memo local, typed `ref_null <closureStruct>`, so every reference to the
declaration yields the SAME closure instance (JS `f === f`, sidecar writes
visible). The slot is cached in `fctx.nestedFnClosureMemos`.

`snapshotLocals` / `restoreLocals` (`src/codegen/context/locals.ts`) — the
transactional unwind every speculative compile goes through
(`rollbackSpeculative`, #1919) — restored `localMap`, `boxedCaptures`,
`boxedTdzFlags`, `tdzFlagLocals` and the direct-eval cells, but **not**
`nestedFnClosureMemos`.

So a probe that allocated the memo local and then rolled back had the slot
truncated out of `fctx.locals` while the map kept pointing at it. The slot was
re-allocated at an unrelated type — in the reducer, the `externref` temp
holding the cached `Boolean` global read for `.filter(Boolean)` — and the
committed re-compile took the cache-HIT branch, baking the memoized-closure
guard onto a foreign slot:

```wasm
;; local $5 is externref (the cached `Boolean`), local $9 is (ref null $8)
local.set $5                       ;; ← the Boolean read, unrelated
local.get $5                       ;; ← emitMemoizedNestedFnClosure's null guard
ref.is_null
if
  ... struct.new $8 (inner's closure) ... extern.convert_any
  local.set $5
end
local.get $5
ref.as_non_null                    ;; (ref extern)
local.set $9                       ;; expects (ref null $8) → engine rejects
```

Confirmed directly: instrumenting the cache-hit branch prints
`memoLocal=5 type={"kind":"externref"} want=ref_null:24 STALE`.

This is the same defect family as #1847 (the locals vector), #2029 (`localMap`
RE-POINTS an existing name, not just adds one) and #3032 (`boxedTdzFlags` /
`tdzFlagLocals`) — one map later. The invariant those three encode: **any
per-frame map whose VALUE is a local slot must roll back with the slot.**

Why a chain triggers it and a split does not: the chained receiver
`arr.map(nestedFn).<method>(…)` is probe-compiled to learn the receiver's
ValType before the committed lowering is chosen, and that probe is what
allocates and then discards the memo local. The two-statement form assigns the
map result to a binding, so the second call's receiver is a plain identifier
and never gets probed.

## Fix

Add `nestedFnClosureMemoEntries` to `LocalsSnapshot` and restore the map to its
EXACT snapshot state in `restoreLocals`, mirroring the `tdzFlagLocals`
treatment. Guarded on either side being non-empty, so a frame that never
memoized a nested closure is byte-identical to before.

`src/codegen/context/locals.ts`, +34 lines, no other file changed.

## Evidence

Regression test `tests/issue-5302-nested-fn-memo-rollback.test.ts` — 12 cases:
eight end-to-end compiles from untyped `.js` fixtures behind a two-file project
(`mod.js` + `entry.ts`, because annotating the receiver `: any` routes to a
different arm and passes either way), plus four that pin the
`snapshotSpeculative` / `rollbackSpeculative` contract directly in the style of
`tests/issue-1919-speculative-compile.test.ts`.

- On the parent commit `0df2efa958`: **10 failed / 2 passed of 12.** Every
  end-to-end failure is the exact `CompileError: … local.set[0] expected type
  (ref null N), found ref.as_non_null of type (ref extern)`.
- With the fix: **12 passed of 12.**

The two that pass on base are the ones that cannot see the defect: the
array-LITERAL-receiver identity case (a literal receiver takes a different
lowering and never gets probed) and the contract case asserting the map stays
absent when the frame never memoized a closure.

Behaviour is unchanged where it was already defined: the chained form now
produces exactly what the already-valid two-statement form produces, closure
identity (`inner === inner`) holds, and captures are still copied at the first
DYNAMIC reference (`n = 5` before the map ⇒ `seen === [6,7,8]`).

## Package A/B (one head, 17 upstream suites)

Both arms at `0df2efa958` (the branch base at measurement time), sequential,
same box; base arm = `locals.ts` reverted to its pre-edit copy, fix arm = this
change. Compared per test FILE (`native; N/M Wasm`) and on each suite's
headline. **Every suite exited 0 in both arms and every suite that prints one
printed its `admitted …` headline** — no package is reported as "unchanged"
because it failed to produce a number.

| package | files | base | fix | moved |
| --- | --- | --- | --- | --- |
| webpack | 3 | 16/16 | 16/16 | no |
| three | 1 | 17/18 | 17/18 | no |
| clsx | 3 | 32/32 | 32/32 | no |
| cookie | 4 | 63740/63740 | 63740/63740 | no |
| lodash | headline only | 53/62 | 53/62 | no |
| redux | 9 | 60/82 | 60/82 | no |
| axios | 33 | 108/231 | 108/231 | no |
| stylelint | 30 | 108/108 | 108/108 | no |
| tailwindcss | 2 | 13/13 | 13/13 | no |
| jsdom | 1 | 6/6 | 6/6 | no |
| styled-components | 4 | 9/9 | 9/9 | no |
| uuid | 10 | 75/75 | 75/75 | no |
| marked | 1 | 0/30 | 0/30 | no |
| moment | 6 | 0/10 | 0/10 | no |
| prettier | 16 | 51/151 | 51/151 | no |
| jest | 34 | 299/356 | 299/356 | no |
| hono | 4 | 37/52 | 37/52 | no |

**0 of 17 packages moved in either direction, and no individual test file moved.**
The fix removes an invalid-wasm class without changing any package's observable
score — prettier included, for the reason below.

Re-checked after merging 218 commits of `upstream/main` (`7c4a350a64`): the
defect is still present on that base (`restoreLocals` there still does not
mention `nestedFnClosureMemos`), the regression test still splits 10-fail /
12-pass across the two arms, and prettier is **51/151 on both arms at the new
head as well**, per file identical. One caveat from that re-run: under the
box's load `doc-builders.js` hit the harness's 240 s compile timeout instead of
reaching the init error — a contention artifact, not a score change (the file
is 0/46 either way).

## Prettier after this fix — the SECOND blocker, not fixed here

Prettier is **51/151 before and 51/151 after**. What changed is the failure
class, not the score: the six files above go from `validates: false` (the engine
rejects the module outright) to compiling AND validating, and then hit a
**distinct** blocker at module init:

```
module init: TypeError: equal is not a function
```

Chain: prettier's `src/language-js/utilities/create-type-check-function.js`
calls `assert.equal(...)` at module scope, with
`import * as assert from "#universal/assert"`, and `src/universal/assert.js` is
exactly `export { equal, ok, strictEqual } from "node:assert";`.

Localised with four controls (all two-file projects):

| shape | result |
| --- | --- |
| `import { equal } from "node:assert"` then `equal(1,1)` | **works** (both node and web lanes, with or without host deps) |
| `import * as ns from "./m.js"` where `m.js` re-exports a LOCAL function | **works** |
| `import * as ns from "./m.js"` where `m.js` re-exports from `node:assert` | namespace object is **null** |
| `import * as ns from "./m.js"` where `m.js` does `import {equal} from "node:assert"; export {equal}` | namespace object is **null** |
| `import * as assert from "node:assert"` directly | namespace exists, `equal` **missing** |

So it is not a host-provisioning gap and not a desugaring gap. It is
`tryEmitCompiledModuleNamespaceObject` / `namespaceFunctionExports` in
`src/codegen/module-namespace-value.ts`: that builder admits only exports that
are (a) functions compiled into this module or (b) top-level `export const`
module globals, and declines the whole namespace object otherwise ("Mixed/mutable
namespaces decline until live-binding getter cells are available"). A binding
whose value is a **host import** is neither, so the namespace object is never
materialized. Fixing it needs a first-class function VALUE for a node-builtin
import to put in the object — a real feature, deliberately not attempted here.

That single gap is worth **71 prettier tests** (the six files above).

Two smaller prettier blockers, also untouched:

- `get-parser-plugin-by-parser-name.js` (11), `get-printer-plugin-by-ast-format.js`
  (11), `massage-ast.js` (1), `resolve-parser.js` (1) fail to COMPILE, first on
  the deliberate `async shape not supported … inside a try` refusal (#3587) in
  `src/config/prettier-config/loaders.js:24`; two of them additionally hit
  `stack-balance (#2090) … operand stack underflow by 1` in three closures.
  The async refusal alone blocks them, so the stack-balance defect is not on
  the critical path for these files.
- A pre-existing `Array.prototype.filter(Boolean)` defect returns an EMPTY
  array where node returns both elements. Present on the parent commit in the
  already-valid two-statement form, so it is not caused by (or fixed by) this
  change; worth its own issue.
