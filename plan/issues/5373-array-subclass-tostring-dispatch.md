---
id: 5373
title: "`String(x)` / `${x}` / any-typed `x.toString()` on a `class extends Array` instance run the built-in array join instead of the subclass override — every linked-Temporal `Instant`/`ZonedDateTime` read fails (JSBI is `class JSBI extends Array`)"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
---

# #5373 — Array-subclass `toString` override is bypassed by the coercion paths

## Problem

Reduction, no Temporal, measured through the test262 runner (provider linked,
same compile options as a conformance row — `.tmp/probe-5365/array-subclass.js`
in the dev-5364 worktree, 2026-09-06):

```js
class B extends Array {
  constructor(n, s) { super(n); this.sign = s; }
  toString() { return "B(" + this.length + ")"; }
  dig(i) { return this[i]; }
}
const b = new B(3, false); b[0] = 1; b[1] = 2; b[2] = 3;
function anyStr(x) { return String(x) + "|" + x.toString() + "|" + ("" + x); }
```

| expression        | compiled       | node     |
| ----------------- | -------------- | -------- |
| `b.toString()`    | `B(3)`         | `B(3)`   |
| `"" + b`          | `B(3)`         | `B(3)`   |
| `String(b)`       | **`1,2,3`**    | `B(3)`   |
| `` `${b}` ``      | **`1,2,3`**    | `B(3)`   |
| `anyStr(b)`       | **`1,2,3\|1,2,3\|B(3)`** | `B(3)\|B(3)\|B(3)` |

`b.length`, `b.dig(1)`, `Array.isArray(b)`, `b instanceof B`, `b.sign`,
`new B(4).length`, `push`, `map` are all correct. Only the **string-coercion
paths and the any-typed method call** resolve `toString` to the built-in array
join instead of the subclass's own override.

### Why it matters — every `Instant` / `ZonedDateTime` read

`jsbi@4.3.0` is `class JSBI extends Array { constructor(i,_) { super(i);
this.sign=_; Object.setPrototypeOf(this, JSBI.prototype); … } }` with its own
`toString(radix)`. The polyfill exposes every BigInt through
`ko(e){const t=Lo(e);return void 0!==globalThis.BigInt?globalThis.BigInt(t.toString(10)):t}` —
`t` is any-typed, so the compiled `t.toString(10)` joins the digit array:

```
Temporal.Instant.from("2024-01-01T00:00:00Z").epochNanoseconds
  → SyntaxError: Cannot convert 23396352,513294428,1 to a BigInt
Temporal.ZonedDateTime.from({year:2024,month:1,day:1,hour:12,minute:34,timeZone:"UTC"}).year
  → RangeError: infinity is out of range        (ISO calendar, UTC — nothing exotic)
new Temporal.ZonedDateTime(1704067200000000000n, "UTC")
  → ctor ok, .epochMilliseconds = 1704067200000 (number path fine),
    .year / .daysInMonth → "infinity is out of range", .offsetNanoseconds → NaN,
    .epochNanoseconds → the comma-joined carrier above
```

(`.tmp/probe-5365/{instant-epoch,zdt-ctor,zdt-iso,zdt-gregory-steps}.js`.)
The `infinity is out of range` arm is the same defect one step later: a JSBI
value stringified as `"a,b,c"` then re-parsed is `NaN`/`Infinity` inside
`JSBI.toNumber` / `ToIntegerWithTruncation`. This is the whole "9–22 ×
`infinity is out of range`, ZonedDateTime only" residual that #5251, #5354,
#5208 and #5360 each reported and left, and the `Cannot convert … to a BigInt`
row family of #5245 (Duration `total`/`round`).

On the 123-row #5249 list (batch-fixed.tsv, after #5364): 22 rows
`infinity is out of range`, of which the node control passes 8
(`daysInMonth/basic-{ethioaa,japanese}`, `monthsInYear/basic-islamic-civil`,
`since/{basic-buddhist,leap-year-japanese}`, `subtract/constrain-day-japanese`,
`until/leap-year-japanese`); the other 14 also fail under node on the pinned
polyfill (era-code version gap, #5360) and are unblocked only for their next
layer. Beyond that list, every `built-ins/Temporal/Instant/*` and
`ZonedDateTime/*` row that reads a BigInt-backed field is in this family —
expect the bucket to be hundreds of rows in the merge-group report.

## Implementation Plan (Fable, 2026-09-06)

**Step 1 — find the three dispatch sites.** Which runtime/codegen path serves
each wrong cell:

- `String(x)` and `` `${x}` `` — `emitToString` in
  `src/codegen/coercion-engine.ts` (~L211): the struct/externref arm goes to
  `tryStructToString` / `__extern_toString` / `__extern_to_string_default`. Find
  where the RUNTIME side (`src/runtime.ts`: the ToPrimitive helpers around
  L3620–3700 — `tryMethod("toString")`, the `methodNames` order at L3691/L4169 —
  and the `_wrapForHost` proxy trap at ~L8490 that special-cases
  `toString`/`valueOf`) decides "this is an array → join". The likely shape is
  an `Array.isArray(mirror)` / vec check that runs BEFORE the struct's own
  method lookup. Log which branch fires for `B` and for a plain array.
- Any-typed `x.toString()` — the dynamic method-call path
  (`__call_method`/`invokeMethod` family in `src/runtime.ts`, and
  `src/runtime/class-method-host-bridge.ts` `resolveClassMemberOnInstance`):
  same question, an array fast path that pre-empts the class's own method table.

State all three in the PR with the line numbers.

**Step 2 — fix: subclass override first, built-in second.** For a receiver
whose struct IS a class instance (it has a class object / `__tag` — the
#5354 `__class_object_of` answers this, and the pre-existing
`_prototypeMethodNames` / class method tables do too), look up the method on
the class chain BEFORE the array/vec built-in. Plain arrays (no class) keep the
fast path byte-for-byte. Do not special-case `toString`: the same ordering bug
affects any built-in name a subclass overrides (`join`, `slice`, `valueOf`,
`Symbol.toPrimitive`), so fix the ORDER, then verify `join` and `valueOf`
overrides in the test.

**Step 3 — `toString(radix)` with an argument** through the any-typed path
(the polyfill's exact call). Include it in the reduction; the arg must reach the
override.

**Step 4 — tests.** `tests/issue-5373-array-subclass-tostring.test.ts`: the
table above (all five expressions + `join`/`valueOf` overrides + `toString(10)`
with an argument), base-failing on the three wrong cells, plus a plain-array
control that must not change. Single-module AND linked-provider lanes (the JSBI
class lives in the PROVIDER — use the two-lane template of
`tests/issue-5225-consumer-literal-seam.test.ts`).

**Step 5 — measure.** (a) The direct probes: `Instant.from(...).epochNanoseconds`
must be a `bigint`, `ZonedDateTime.from({…ISO…, timeZone:"UTC"}).year` must be
2024. (b) The 123-row list, batch (post-#5364 driver, fresh
`JS2WASM_TEMPORAL_CACHE`): expect the 22 `infinity is out of range` rows to
move (8 to pass or a next layer; 14 to the #5360 era layer). (c) A bounded
Temporal sample that does not overlap the 123: `built-ins/Temporal/Instant/**`
(~700 rows) and `built-ins/Temporal/ZonedDateTime/prototype/{year,month,day,epochNanoseconds,epochMilliseconds}/**`
— base vs fix, per row, 0 pass→fail. Never the full 838/6,600-row bucket.

**Order-preservation constraints.** The array fast path for plain arrays is a
hot path (`__extern_get` / `join` on `mixed`/`csv-parse` benchmarks, #3903) —
the class-chain lookup must be gated on "receiver is a class instance", not on
"receiver looks like an array", so a plain array never pays for it. Equivalence
gate at baseline.

## Acceptance criteria

1. Step 1 answered with the three sites.
2. Table above all-green in both lanes; plain-array control unchanged.
3. `Instant.epochNanoseconds` is a `bigint`; ISO `ZonedDateTime.year` reads.
4. 123-row and Instant/ZonedDateTime samples measured, 0 pass→fail, counts
   stated with the artifact they came from.

## Notes

- Found while planning the next Temporal slice after #5364; supersedes the
  "infinity is out of range, ZonedDateTime only — not probed" rows of #5251,
  #5354, #5208 and #5360, and the `Cannot convert … to a BigInt` half of #5245.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-06 — highest in-flight issue file
  is #5364.
