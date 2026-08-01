---
id: 3910
title: "A module combining a regex literal with string constants mis-resolves a global.get in `run`"
status: done
created: 2026-07-31
updated: 2026-08-01
completed: 2026-08-01
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: regexp
goal: performance
sprint: Backlog
horizon: m
es_edition: multi
related: [3900, 3909]
loc-budget-allow:
  - src/codegen/stack-balance.ts
func-budget-allow:
  - src/codegen/stack-balance.ts::fixCallArgTypesInBody
---

# #3910 — regex literal + string constants mis-resolves `global.get` in `run`

## Status: fixed

## Problem

A module containing both a regex literal and string constants mis-resolves a
`global.get` inside the exported `run` function. The wrong global index is
read, so `run` operates on an unrelated value.

Both regex lowering and the string constant pool allocate module globals. If
one of them appends globals after the other has already captured indices — or
if the two use separate index spaces that are later merged — the reference
goes stale. That is the same *shape* as the `addUnionImports` index-shifting
hazard documented in `CLAUDE.md` for function indices, but on the global index
space.

## Scope

1. Build the minimal repro (a regex literal plus at least one string constant,
   exercised from `run`) and capture the wrong-index symptom precisely — the
   expected vs. actual global, not just "wrong result".
2. Determine the ordering: which pass allocates globals, which captures
   indices, and whether anything appends after capture.
3. Check whether the string-constant pool and the regex globals share an index
   space, and whether a shift is applied to one but not the other.

## Acceptance criteria

1. Minimal repro committed as a regression test.
2. Root cause identified and fixed, with the ordering/index mechanism written
   down.
3. A check for other consumers of global indices that could go stale under the
   same append-after-capture pattern.

## Notes

Found by `issue-3900-case-convert` while probing case conversion. It verified
the failure **reproduces identically on the parent commit**, so it is
pre-existing. Reported rather than fixed — correctly out of scope there.

Filed separately from #3909 (the `__str_trimStart` multi-feature validation
failure) because the two have different symptoms and different index spaces,
but they surfaced together and may share a root cause. Whoever picks up one
should read the other.

## Resolution

### It is NOT an index shift, and NOT a global-index problem at all

The reported symptom — "the wrong global index is read" — is a misreading of
the validator message. Both string globals involved are `(ref null $AnyString)`
and both `global.get`s target the correct global. What is wrong is the
**coercion**: one of the two arguments reaches the host import unconverted.

The premise in the Scope section ("which pass allocates globals, whether
anything appends after capture") therefore has no answer, because no global
index ever goes stale here. Acceptance criterion 3 — "other consumers of global
indices that could go stale" — is likewise vacuous for this bug; the
equivalent sweep that *was* warranted is the **function**-index one, and it
lives in #3909.

Nor is a string constant required. The minimal repro has **no user string
literal at all**:

```ts
export function run(s: string): number {
  const re = /o/;
  return re.test(s) ? 1 : 0;
}
```

compiled with `fast: true` (native strings) fails with

```
call[1] expected type externref, found global.get of type (ref null 7)
```

A regex literal *always* materialises two native-string globals of its own —
the pattern and the (possibly empty) flags — and feeds them to
`RegExp_new(externref, externref)`. That is the whole trigger. "Regex + string
constants" was a coincidence of the reporter's repro; "three features" was a
coincidence of #3909's repro, which is a genuinely different bug.

### Root cause: `insertions` are applied in ascending position order

`fixCallArgTypesInBody` (`src/codegen/stack-balance.ts`) walks **backward**
from a call to find arguments whose produced type does not match the callee's
parameter type, queueing `{ afterPos, instrs }` for each. Because the walk runs
backward, the queue comes out in **descending** `afterPos` order. It was then
drained back-to-front:

```ts
// Apply insertions in reverse order (so positions don't shift)
for (let k = insertions.length - 1; k >= 0; k--) { … body.splice(afterPos + 1, …) }
```

which iterates it in **ascending** order — exactly the order that shifts every
position not yet applied. The comment's premise ("reverse order ⇒ positions
don't shift") only holds if the queue is ascending, and it never is.

Traced on the repro (`JS2_DEBUG` instrumentation, since removed):

```
insertions=[{afterPos:1,[extern.convert_any]},{afterPos:0,[extern.convert_any]}]
after=[global.get $pattern, extern.convert_any, extern.convert_any,
       global.get $flags, call $RegExp_new, …]
```

Both coercions landed on the **pattern**; the **flags** got none. The later
`fixupExternConvertAny` repair pass then removed the second (correctly — it saw
an already-`externref` operand), which is why the emitted WAT showed a single,
innocent-looking `extern.convert_any` and hid the real shape.

So the defect is: **any call with two or more mismatched arguments mis-places
every coercion after the first.** One-mismatch calls — the overwhelming
majority — were unaffected, which is why this survived.

### Fix

`src/codegen/stack-balance.ts` — sort `insertions` descending by `afterPos` and
apply highest-first. The backward walk already produces that order; sorting
makes the invariant explicit so a future change to the walk cannot silently
resurrect the bug. The comment is rewritten to state why ascending is the wrong
order, since the original comment's incorrect premise is what preserved the bug
(the `loc-budget-allow` / `func-budget-allow` keys above cover that growth).

### Relationship to #3909 — separate root causes, confirmed by A/B

Verified on current `main` by reverting each fix independently:

| build | regex repros | `__str_trimStart` |
| --- | --- | --- |
| both fixes | valid | valid |
| only #3910 fix | valid | **still broken** |
| only #3909 fix | **still broken** | valid |
| neither | broken | broken |

Each fix is necessary and neither is sufficient. They are **not** one shared
root cause, despite the shared surface (fast mode, validation failure,
"needs several features"). The generalisable lesson is the one the two share as
a *class*: both were caused by a **comment whose premise had silently become
false**, and in both cases the code was faithfully implementing the stale
comment.

### Blast radius

A sweep over 455 three-feature fast-mode modules, the four benchmark suites and
the playground/examples corpus found ~60 call sites with 2+ queued coercions
(`csv-parse`, `replaceAll` with 3, several DOM examples). Benchmark results are
byte-identical before/after; every Wasm **validation** failure in the 455-combo
corpus disappears.

### Residual, out of scope: fast-mode regex never reaches the host correctly

With the module now valid, fast-mode regex fails one layer down at runtime:
`RegExp_new` receives the two native-string GC structs as opaque externrefs and
V8 reports `Invalid flags supplied to RegExp constructor '[object Object]'`.
`compileRegExpLiteral` does not route its arguments through the
`__str_flatten` + `__str_to_extern` bridge the way `console.log` does
(`src/codegen/expressions/builtins.ts:86-97`), and `RegExp_test` has the same
gap for its subject string. That is a **representation** defect (runtime, not
validation) in the #3912 family, pre-existing and independent — before this fix
the module did not even validate. Worth its own issue.

The regression test therefore asserts the validation property
(`WebAssembly.validate`) plus the emitted argument shape, not a `run()` result.

### Tests

`tests/issue-3909-3910-index-and-argcoerce.test.ts` — the bare regex literal,
the reported regex + string-constant form, and a structural assertion that each
`global.get` feeding `RegExp_new` carries its own `extern.convert_any`. All
three fail on the unfixed compiler.

### Not verified

- The `~60 call sites with 2+ queued coercions` figure and the
  byte-identical-benchmark claim are carried over from the pre-interruption
  investigation and were **not** re-measured against current `main` (which has
  since taken #3899–#3908). The validation results in the table above *were*
  re-verified on current `main`.
