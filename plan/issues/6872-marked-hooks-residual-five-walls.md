---
id: 6872
title: "marked Hooks residual (18/30 → 30/30): foreign `this`, shadowed method params, shared class struct field names, closure-owned `let`, sibling-write boxing"
status: done
sprint: current
created: 2026-10-06
updated: 2026-10-07
completed: 2026-10-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
related: [5345, 5358, 5372, 3716, 4435]
files:
  - src/codegen/property-access-dispatch.ts
  - src/codegen/closures.ts
  - src/codegen/literals.ts
  - src/codegen/struct-field-exports.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/closures/closure-binding-identity.ts
  - src/codegen/struct-field-name-tags.ts
  - tests/issue-6872-marked-hooks-residual.test.ts
# 2026-10-07: the five fixes are small and local; the bulk moved into leaf
# modules (struct-field-name-tags.ts, closures/closure-binding-identity.ts) and
# helpers (dropOwnScopeBindings, capturedBindingWriteTest). What remains is the
# helper body that needs closures.ts-private analyzeDescriptorCaptureReferences,
# the one new parameter / call line, a 3-line receiver hint, and +9 lines of
# import/call/collision-check wiring in arrow-phases.ts (crossed 1500 on main).
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/closures/arrow-phases.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/codegen/closures.ts::promoteAccessorCapturesToGlobals
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
---

## Problem

marked's admitted upstream file `test/unit/Hooks.test.js` scored **18/30** on
`upstream/main` `42d289a96f` (the dashboard's `16/30` is an older artifact).
The 12 failures, grouped by the error the suite log records:

| Tests | Error | Root cause |
| ----- | ----- | ---------- |
| 4 × `this.block backwards compatibility` | `actual=undefined` | (1) + (3) |
| 2 × `should preprocess options[ async]` | no `<br>` (option write lost) | (1) |
| 2 × `should postprocess async`, `all hooks in reverse` | `null.trim` | (2) |
| 2 × `process tokens [async] before walkTokens` | `illegal cast` | (4) |
| 2 × `correct block … concurrent async parse` | `true is not a function` | (5) |

#5345 (claimed by another lane since 2026-09-05, stale) covers an earlier
state of the same file; its Cluster B (runtime-key prototype-method reads)
landed via #5358. None of the five mechanisms below are in it.

## Root causes

1. **Foreign receiver.** An object-literal method's `this` is its literal's
   struct. Called with another receiver (`u.apply(hooksInstance, c)` in
   `Marked.use`), the method-as-closure trampoline passes `ref.null` (the
   #2025 passthrough). `this-keyword.ts` already answers the caller's thisArg
   from `__current_this` for that case (#6651 A11) — but only when the
   consumer asks for `externref`, and the field-absent `this.x` MOP read in
   `finalizeStructAndDynamicMemberGet` compiled the receiver with no expected
   type, so it read `__extern_get(null, "x")`.
2. **Method parameter promoted as a capture.**
   `promoteAccessorCapturesToGlobals` collects every identifier in an
   object-literal method body by spelling. `{ postprocess(html) {…} }` beside
   the test's `const html = await marked.parse(…)` promoted the enclosing
   `html` to a module global; the async frame's resume wrote its local while
   `String(html)` read the global → `null`.
3. **Shared class struct field names.** `class y { options; parser }` and
   `class P { options; block }` both lower to `(struct i32 externref
   externref)` — distinct indices, one canonical type at runtime. The
   `__struct_field_names` ladder `ref.test`s each class in turn, so a `P`
   instance answered `y`'s names; the host then judged `block` not an own
   field and read `undefined`.
4. **Closure-owned `let` captured from a closed sibling block.**
   `s.walkTokens = function (o) { let u = []; … }` sits beside earlier
   `{ let o = i, u = n.renderer[o]; … }` blocks in the same `forEach` arrow.
   The block-scoped `let u` is excluded from the own-locals shadow set
   (deliberately, #995), and `removeClosureOwnedBlockBindingCollisions` only
   ran its identity check for names still in `localMap` — the sibling's `u`
   was not, so the #1177 rescan resurrected its slot and the closure read the
   sibling's cell → `illegal cast`.
5. **Sibling write boxing a per-iteration capture.** `planClosureCaptures`
   decides `writtenInOuter` by spelling: `u = u.concat(…)` inside that same
   `walkTokens` function counted as a write of the hooks loop's `let u`, so the
   capture was boxed into ONE cell (`$__boxed_u`, reused by the later ternary
   arm) and every hook wrapper called the first hook.

## Implementation Plan

1. `property-access-dispatch.ts` — in the field-absent `__anon`/`__fnctor`
   MOP arm, compile a `this` receiver with expected `externref` so the A11 rung
   answers the thisArg when the struct receiver is null.
2. `closures.ts` — `promoteAccessorCapturesToGlobals` gains an `ownScope`
   parameter; names whose every value reference resolves (checker identity) to
   a declaration inside the method are dropped. `literals.ts` passes the
   object-literal method.
3. `struct-field-exports.ts` — group legacy `__struct_field_names` entries by
   STRUCTURAL key; when a group's classes disagree on names, discriminate each
   by its `__tag` (field 0, `classTagMap`), tagged arms ahead of untagged ones.
4. `closures/arrow-phases.ts` — run the identity check also for names the
   closure itself declares, even when the outer `localMap` no longer has them.
5. `closures/arrow-phases.ts` — `collectOuterWrites` counts a write only when
   the written identifier resolves to the captured binding's declaration
   (unknown identity stays a write).
6. Regression test: `tests/issue-6872-marked-hooks-residual.test.ts`, one
   export per mechanism plus controls.

## Resolution

All five landed in one PR. marked `Hooks.test.js` **18/30 → 30/30**.

Recovered from an uncommitted worktree on 2026-10-07 and re-measured after
merging `upstream/main` `75252327a4`: base = that commit's five source files,
fix = the merged branch, file-copy A/B, suites one at a time. To keep the
budget gates honest, two pieces moved into new leaf modules
(`struct-field-name-tags.ts`, `closures/closure-binding-identity.ts`) and two
into named helpers (`dropOwnScopeBindings`, `capturedBindingWriteTest`).

| Suite | base | fix |
| ----- | ---- | --- |
| marked | 18/30 | **30/30** |
| prettier | 111/151 | 111/151 |
| hono | 294/324 | 294/324 |
| redux | 76/82 | 76/82 |
| lodash | 60/62 | 60/62 |
| axios | 219/231 | 219/231 |
| jest | 344/356 | 344/356 |
| uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| moment | 10/10 | 10/10 |

The regression test fails on base (5/5 cases) and passes with the fix.

Scoped standalone test262 (1388 rows: `expressions/object/method-definition`,
`expressions/arrow-function`, `statements/for`, `statements/let`,
`expressions/this`, `statements/class/subclass`,
`Function.prototype.call`/`apply`): base 1282 pass / 86 fail / 20 CE, fix
identical, and the non-pass row set is identical row for row. (42 of the
fails are local-only: the quickjs eval provider is not built in this
worktree, so they fail the same way on both sides.)

### Residuals seen, not fixed here

- `(await a) + (await b)` in an async function returns the Promises
  unawaited (`[object Promise][object Promise]`): an `await` inside a binary
  operand is not suspended on — the binary-expression twin of #5372.
- `(flag ? await f() : g)(x)` with no outer `await` answers `undefined`.
- An `async` object-literal method invoked dynamically from a SYNC caller
  returns its raw value, not a Promise (`typeof p === "string"`).
- Two same-shape object literals whose methods share a signature: a direct
  call `obj.m()` dispatches to the shared (first-compiled) body, not the
  receiver literal's forked `__lit` body.
- `this instanceof Hooks` inside a foreign-receiver literal method fails
  validation (`struct.get` on the literal's type) when two literals fork.
- `o.f.call(foreign)` on a statically-known literal method throws (the direct
  `.call` lowering `ref.test`s the receiver against the literal's struct).
