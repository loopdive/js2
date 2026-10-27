---
id: 7155
title: "Native-first and standalone: object spread of an array copies the vec's internal fields (length,data) instead of its indices"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7148, 7154, 6708]
# 2026-10-27: `__object_assign` (inside `buildObjectEnumerationHelpers`) gains
# one line spreading the new array-source arm, which itself lives in
# object-model/object-assign-array-source.ts; `materializableSpreadStructTypeIdx`
# gains one vec-carrier exclusion. Both are the minimal call-site change.
func-budget-allow:
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
loc-budget-allow:
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/literals.ts
---

# #7155 — `{ ...[5, 6] }` yields keys `length,data` on the no-host lanes

Found by the fresh-context review of PR #6911 (#7148, finding 4). Pre-existing
on `origin/main` before and after #7148, on gc native-first and standalone
(host-assisted is correct):

```js
const c = { ...[5, 6] };
console.log(Object.keys(c).join());   // "length,data"   (node: "0,1")
console.log(JSON.stringify(c));       // {"length":2}    (node: {"0":5,"1":6})
```

## Cause (as diagnosed; verify before fixing)

`__object_assign` (`src/codegen/object-runtime-enumeration.ts`, the
`__object_assign(externref target, externref sources)` helper) dispatches each
source on the `$Object` struct test. The native array struct passes that test,
so its internal fields (`length`, `data`) are walked as own properties and copied
into the target. The array-like arm that `__object_keys` / for-in already use for
native vecs (`ToLength(Get(O, "length"))` sequence, same file) is never reached
from the assign path. `Object.assign({}, [5, 6])` takes the same route.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the program above plus `Object.assign({}, [5, 6])`,
   `{ ...["a", "b"], 1: "x" }` (overwrite order) and a sparse/`any[]` vec on gc
   native-first and standalone; confirm host-assisted prints the node output.
2. In `__object_assign`, test the source for the native vec representation
   BEFORE the open-`$Object` arm (reuse the exact predicate the array-like
   `__object_keys` arm uses — do not re-derive it), and copy indices
   `0..length-1` as string keys `"0"`, `"1"`, … via the same
   `__extern_set_strict` call the ordered-key loop uses, so the #7148 ordering
   contract holds (integer keys first, ascending). Holes (sparse vecs) are
   skipped, matching `[[OwnPropertyKeys]]` for arrays. Do not add host imports.
3. Keep host-assisted gc output byte-identical (the helper is selected only for
   native-first / no-host lowering); state the native-first and standalone byte
   delta on a 20-program equivalence sample in the PR body.
4. Tests: `tests/issue-7155-object-spread-of-array.test.ts` with the programs
   from step 1, run on gc native-first and standalone against node output; add
   `{ ...[5, 6] }` to the probe list in
   `tests/issue-7148-object-spread-insertion-order.test.ts` only if that file
   already loops over programs (otherwise leave it).

Acceptance: `Object.keys({ ...[5, 6] })` prints `0,1` and `JSON.stringify`
prints `{"0":5,"1":6}` on gc native-first and standalone; host-assisted gc
bytes unchanged; the equivalence gate reports no new regressions.
