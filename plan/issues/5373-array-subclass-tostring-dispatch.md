---
id: 5373
title: "`String(x)` / `${x}` / any-typed `x.toString()` on a `class extends Array` instance run the built-in array join instead of the subclass override — every linked-Temporal `Instant`/`ZonedDateTime` read fails (JSBI is `class JSBI extends Array`)"
status: done
completed: 2026-09-06
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
# 2026-09-06 — the ordering rule has to be applied at the member-resolution
# sites themselves, and all three of them live in `src/runtime.ts`
# (`__extern_toString`, `__extern_join_str`, `__extern_method_call`). The +95
# LOC is the three shared helpers (`_isTaggedUserClassInstance`,
# `_classChainMethod`, `_classChainToString`) plus the three call sites and
# their rationale comments; moving them to a subsystem module would put the
# gate one indirection away from the built-in read it has to precede, which is
# exactly the split that let this bug survive #5204's partial fix.
loc-budget-allow:
  - src/runtime.ts
# Same change, same reason. `resolveImport` is the import-factory switch that
# physically contains all three imports, and `<anonymous>#95` is the
# `__extern_method_call` closure inside it — the dynamic method-call path, where
# the class-chain lookup has to sit ahead of `wrappedObj[method]`. Both grow by
# the guard clause and its comment only.
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#95
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

## Outcome (2026-09-06, dev-5373)

### Step 1 — the dispatch sites

Not the ones the plan guessed. `class B extends Array` is compiled
**externref-backed**, so the instance reaching the host is a **real host JS
Array** (`Array.isArray` true, `_isWasmStruct` false, `constructor.name === "B"`,
tagged `"B"` in `_userClassTags`), not a WasmGC vec. `_wrapVecForHost`'s get trap
— the plan's prime suspect — never fires for it; it fires only for PLAIN arrays.
All the sites are in `src/runtime.ts`:

| expression | site | line |
| --- | --- | --- |
| `String(x)`, `` `${x}` `` | `__extern_toString` → `if (typeof v.toString === "function") return v.toString();` | 12748 / fix at 12773 |
| a subclass instance as a join ELEMENT | `__extern_join_str`'s `joinElem`, same read | 12839 / fix at 12884 |
| any-typed `x.toString()` / `x.toString(10)` / `x.join()` / `x.valueOf()` | `__extern_method_call` → `const fn = wrappedObj[method];`; the class chain was consulted only in the `typeof fn !== "function"` arm below it | 14232 / fix at 14331 |

A **fourth** site with the identical defect — the member READ `const f = x.toString`
(`__extern_get`, its `intent`-table twin `case "extern_get"`, and `_safeGet`) — is
NOT fixed here; see below.

### Steps 2–4 — what shipped

The ordering rule (`_isTaggedUserClassInstance` / `_classChainMethod` /
`_classChainToString`, runtime.ts 6926–6963) is gated on the **user-class tag**,
never on "looks like an array": a plain array is a vec, is never tagged, and pays
one `WeakMap.has`. A class that does not declare the member keeps the inherited
built-in. `tests/issue-5373-array-subclass-tostring.test.ts` covers both lanes;
10 cells are base-failing in the single-module lane.

### Step 5 — measurements

- **123-row #5249 list** (`.tmp/base-123.tsv` vs `.tmp/fix2-123.tsv`, 13 pass /
  110 fail both sides): **0 pass→fail, 0 fail→pass, 0 changed failure reasons.**
  The 21 `infinity is out of range` rows did not move — they are blocked on the
  `constructor`-identity defect below, not on this ordering.
- **`built-ins/Temporal/Instant/**` + `ZonedDateTime/prototype/{year,month,day,epochNanoseconds,epochMilliseconds}/**`**,
  481 rows, no overlap with the 123 (`.tmp/base-instzdt.tsv` vs
  `.tmp/fix2-instzdt.tsv`, 225 pass / 256 fail both sides): **0 pass→fail,
  0 fail→pass, 0 changed reasons.**
- **Direct probes**: unchanged from base. `Instant.from(…).epochNanoseconds`
  still throws `SyntaxError: Cannot convert 23396352,513294428,1 to a BigInt`;
  ISO `ZonedDateTime.year` still throws `RangeError: infinity is out of range`.
  **Acceptance criterion 3 is NOT met, and cannot be by this ordering** — see the
  root cause below.
- Equivalence gate: 22 failing / 1720 passing vs baseline 24 / 1718.

### Reported, not fixed

1. **`i.constructor === C` is false for ANY compiled class read through an
   any-typed receiver** (not just Array subclasses — a plain `class P {}` behaves
   the same). `mkP().constructor === P` is 1, but `f(mkP())` with
   `function f(i){ return i.constructor === P; }` is 0. Root cause: the instance's
   `[[Prototype]]` is a **synthetic** `class Sub extends Parent {}` minted by the
   `__set_subclass_proto` host import and cached by class NAME in `_subclassCtors`;
   nothing maps it back to the compiled class object. **This is the actual blocker
   for every Temporal BigInt read**: `JSBI.BigInt(i)` short-circuits on
   `i.constructor === JSBI` in node and falls through to `JSBI.__toPrimitive` here.
2. **The member-READ path.** Fixing it (`_classChainRead` before the native read in
   `__extern_get` / its intent twin / `_safeGet`) is correct per node in isolation
   and was measured: it **regresses 9 rows** of `built-ins/Temporal/Instant/**`
   (`from/argument-string-date-with-utc-offset`, `from/instant-string-multiple-offsets`,
   `from/instant-string-sub-minute-offset`, `prototype/add/blank-duration`,
   `prototype/equals/argument-object-tostring`,
   `prototype/equals/argument-string-date-with-utc-offset`,
   `prototype/equals/instant-string-multiple-offsets`,
   `prototype/equals/instant-string-sub-minute-offset`,
   `prototype/subtract/blank-duration`) because it makes `i.valueOf` resolve to
   jsbi's own `valueOf`, which throws by design and which node never reaches
   thanks to (1). Do it together with (1), not before it.
3. **Cross-linked-seam dispatch is unfixed** (#5223 family): a subclass instance
   minted in a separately-linked provider and dispatched on in the CONSUMER still
   takes the built-in, because the consumer's exports carry no `__class_call_B_*`
   bridge. Pinned in the test's linked lane.
4. **A defaulted numeric parameter reaches a host class bridge as NaN.**
   `toString(radix = 10)` called through `__class_call_J_toString_1(inst, undefined)`
   answers `"J(3:NaN)"`: the bridge pads the missing argument with `undefined`,
   which the externref→f64 coercion turns into NaN, so the default never fires.
   Affects `String(x)` on any subclass whose `toString` has a numeric default.
5. **`String(a)` / `"" + a` on a PLAIN array through an any-typed parameter
   answers `"null"`**, and `a["toString"]` read through an any-typed parameter
   answers `undefined` (node: `"1,2,3"` for all three). Pre-existing, unchanged,
   pinned as controls in the test.
6. `tests/issue-1933.test.ts` fails identically before and after
   (`expected … to contain 'legacyRegExpState?:'`), i.e. already red on
   `origin/main`. Under the default `forks` pool it OOMs while vitest serializes
   the ~19k-line assertion string; `--pool=threads` shows the real assertion.
