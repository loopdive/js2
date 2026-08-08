---
id: 4219
title: "standalone `for…in` over a STRUCT-TYPED receiver enumerates nothing, and host `Object.keys` under-reports — the two cells #3920 left"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: objects
goal: correctness
related: [3920, 3927, 4071, 4194]
origin: "#3920 second slice — the surface matrix that attributed that fix also measured two cells it does NOT touch"
---

# #4219 — the two reflective cells #3920 does not close

> **Naming:** this is issue id 4219. GitHub **PR #4219** is a different thing —
> it is the pull request that landed #3920's dynamic-runtime half. Issue ids and
> PR numbers occupy overlapping ranges in this repo, so both spellings appear;
> they are unrelated here.

## Measurement

One fixture per operation, two instances of the same fnctor — one that got a
conditionally-assigned `cond`, one that did not. **The correct answer is `1` in
every cell.** `struct-typed` is the receiver used directly (its static type
resolves to the closed struct); `via-any` is the same receiver laundered through
an untyped parameter.

| op | struct-typed, standalone | via-any, standalone | JS host |
| --- | ---: | ---: | ---: |
| `"cond" in bag` | 1 | 1 | 1 |
| `bag.hasOwnProperty("cond")` | 1 | 1 | 1 |
| `Object.hasOwn(bag, "cond")` | 1 | 1 | 1 |
| `bag.propertyIsEnumerable("cond")` | 1 | 1 | 1 |
| **`for (k in bag)`** | **0** | 1 | 1 |
| **`Object.keys(bag)`** | 1 | 1 | **0** |
| `Object.getOwnPropertyNames(bag)` | 1 | 1 | 1 |

Reproduce with `.tmp/surface-matrix.mts` from the #3920 branch (restated below
so it does not die with the worktree).

Both bold cells are **unchanged** by #3920's second slice: reverting only
`binary-ops-in.ts` and `object-ops.ts` to upstream moves exactly three cells
(`in`, `hasOwnProperty`, `propertyIsEnumerable` in the struct-typed column, each
`2` → `1`) and leaves every other cell byte-identical. So these two are
pre-existing and independently owned.

## Cell 1 — `for…in` over a struct-typed receiver enumerates NOTHING (standalone)

Not "enumerates the wrong set" — **zero iterations**. It scores `0`, not `2`, so
this is not the shape-fold defect #3920 fixed; it is a different path failing
open.

`compileForInStatement` (`src/codegen/statements/loops.ts`) resolves the four
enumeration primitives, and for a receiver whose Wasm type is a closed struct
(not `externref`/`anyref`) in a no-JS-host target it takes the **static-unroll
fallback**:

```ts
const exprType = ctx.checker.getTypeAtLocation(stmt.expression).getNonNullableType();
const props = exprType.getProperties();
if (props.length === 0) return;          // <- zero iterations
for (const prop of props) { /* emit prop.name as the key, unconditionally */ }
```

Two independent problems in those four lines:

1. **It asks the CHECKER, not the shape.** For a function-constructor instance
   the checker type is `any`, so `getProperties()` is empty and the loop emits
   nothing at all. That is the measured `0`.
2. **Even when the checker does answer, the unroll is presence-blind** — it
   emits every name unconditionally, with no `$presence_<w>` consultation. So
   the moment problem 1 is fixed by reading the struct instead, this path
   inherits exactly the false-positive defect #3920 just removed from `in` and
   `hasOwnProperty`.

**Fix both together or neither.** Sourcing the name list from the struct without
also gating each key on its presence bit converts a silent under-report into a
silent over-report, which is the worse of the two (a wrong answer that looks
like a bigger number). `emitClosedStructPresence` in
`src/codegen/closed-struct-presence.ts` already produces the per-key predicate;
`fillClosedStructOwnPropertyNamesArms` in `object-runtime.ts` already shows the
enumeration shape (`buildTombstoneSkip` per key, push into a `$ObjVec`).

### Why this is #3927's problem specifically

#3927's per-type-layout emission splits one logical fnctor shape into several
physical layouts. A `for…in` that derives its key list from a **physical field
list** needs one arm per layout and silently drops the fields that moved. The
list must come from the **presence words at their fixed base indices** — the
same constraint #3920's second slice was built to satisfy, and the reason its
derivation lives in a shared module rather than at the call site.

### Do NOT widen `Object.keys` along with it

`Object.keys` measures **correct in both standalone columns already**. #4071
implemented, measured and reverted exactly that widening: `ctx.structFields`
includes builtin carriers whose fields are not `$`/`__`-prefixed, so sharing the
arms made `Object.keys(new Date(0))` answer `["timestamp"]` — **-5**. PR #4219
added `isUserDeclaredStruct` for precisely this, so a fix here must go through
that whitelist rather than around it.

## Cell 2 — host-lane `Object.keys` under-reports (opposite lane)

`Object.keys(bag)` finds `cond` in standalone but **not** in the JS-host lane —
the only cell in the matrix where host is worse than standalone. Different
subsystem (`src/runtime.ts`'s `__struct_field_names` + `__shas_*` marshalling,
which is host-only) and the opposite lane from every other row here.

Recorded rather than diagnosed. It is listed second and separately because
grouping it with cell 1 would repeat the mistake #3920's original filing made:
`for…in` / `Object.keys` / `in` were filed as one hole and turned out to be
three mechanisms in two lanes.

## Reproduction

```js
function Bag(seed) { this.always = seed; }
export function main() {
  var score = 0;
  for (var seed = 0; seed < 2; seed++) {
    var bag = new Bag(seed);
    if (seed > 0) bag.cond = 7;
    for (var k in bag) { if (k === "cond") score = score + 1; }   // cell 1
  }
  return score;                                 // standalone 0, host 1, correct 1
}
```

Compile twice from the same source — `{ target: "standalone" }` versus the
default — and read `main()`. The `via-any` variant that answers correctly wraps
the probe in `function probe(bag) { … }` and calls it, which is what pushes the
receiver onto the dynamic `__object_keys_forin` path PR #4219 armed.

## Acceptance criteria

- [ ] `for (k in instance)` enumerates the instance's own enumerable keys in
      standalone for a STRUCT-TYPED receiver, matching the `via-any` column.
- [ ] Each enumerated key is gated on its presence bit — a conditionally-assigned
      field that this instance never got must NOT be enumerated. Assert the
      absent case explicitly; an all-present fixture cannot distinguish the fix
      from the over-report.
- [ ] The key list derives from the presence words, not the physical field list,
      so it survives #3927's per-type layouts.
- [ ] `Object.keys` on builtin-backed receivers is **unchanged** — re-measure
      the #4071 -5 bucket (`Object.keys(new Date(0))`, `Object.keys(/ab/)`)
      explicitly rather than assuming the whitelist covers it.
- [ ] Cell 2 (host `Object.keys`) either fixed or split out with its own repro.
- [ ] No standalone test262 regression.
