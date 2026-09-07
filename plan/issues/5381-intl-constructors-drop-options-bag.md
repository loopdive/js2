---
id: 5381
title: "`Intl.NumberFormat` / `Intl.ListFormat` (and any extern-class constructor taking an options bag) receive an opaque WasmGC struct instead of their options — `new Intl.NumberFormat(\"en-US\", {minimumFractionDigits: 3}).format(1.5)` answers `\"1.5\"`; `Intl.DateTimeFormat` without `new` traps"
status: done
completed: 2026-09-07
sprint: current
priority: medium
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
# 2026-09-07 — growth grants, measured by the LOC/func gates on the MERGED tree
# (`LOC_GATE_BASE=$(git rev-parse origin/main)`). This branch stacks on #5378,
# which stacks on #5377's PR #5699, so BOTH predecessors' grants are RESTATED
# here: the gate reads the change-set's own issue files, and a grant that lives
# only in a file this PR does not modify is a stranded grant.
#
# NEW growth from THIS issue:
#
# `src/codegen/expressions/call-namespace-static.ts` (+24): the
# `argumentsListIndex` parameter of `emitReflectArgs` plus the doc block
# recording the measured `Reflect.construct(Intl.DateTimeFormat, ["en-US"])`
# padding. It has to live in `emitReflectArgs`: that closure is the only place
# the argumentsList expression is compiled, and the `_arrayLiteralForceVec`
# override must be in scope AROUND that one `compileExpression` call. A
# separate module cannot wrap a call it does not make.
#
# `src/runtime.ts` (+63 for THIS issue on top of #5377's +187 and #5378's +25):
# the `_structArgIdentityCtors` set with its rationale, the
# `marshalsStructArgsForHost` predicate that inverts the per-class
# `webInitArgIndex` list into a default-plus-exceptions rule, and the dynamic
# twin inside `_marshalHostConstructArg`. Both arms are inside the
# `resolveImport` closure family that physically contains the extern-class
# constructor bridge; the comment weight is the measurement record (base
# answers vs node) for five constructors.
#
# `plan/audit/host-import-policy-baseline.json`: `maximumRuntimeTsLines`
# 19453 → 19728, the measured merged `wc -l src/runtime.ts`. main's baseline
# file was taken on the merge conflict and re-measured here, per the
# host-import-policy gate's own instruction.
#
# `src/codegen/property-access-dispatch.ts` (+64), `src/codegen/typeof-delete.ts`
# (+9), `src/codegen/class-bodies.ts`: inherited from #5378/#5377 verbatim, no
# growth from this issue.
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/runtime.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/class-bodies.ts
# `compileNamespaceStaticCall` is the function holding `emitReflectArgs`;
# `resolveImport` (and its anonymous constructor factory) is the one holding
# both runtime arms. The remaining entries are #5378's / #5377's, restated for
# the same stranded-grant reason as above.
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/runtime.ts::resolveImport
  - src/runtime.ts::_marshalHostConstructArg
  - src/runtime.ts::<anonymous>#95
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

# #5381 — extern-class constructors do not marshal their options bag

## Problem

Measured by dev-5378 (PR #5706) through the test262 runner:

| expression | compiled | node |
| --- | --- | --- |
| `new Intl.NumberFormat("en-US", { minimumFractionDigits: 3 }).format(1.5)` | `"1.5"` | `"1.500"` |
| `new Intl.ListFormat("en", { type: "disjunction" }).format(["a","b"])` | `"a, b"` (default) | `"a or b"` |
| `new Intl.DateTimeFormat("en-US", {...})` — FIXED in #5378 by routing arg 1 through `_wrapForHost` | `1/1/2024` (options ignored) → `1/1/2024 AD, 12:34:00` | — |
| `Intl.DateTimeFormat("en-US")` (call without `new`, legal per spec) | `RuntimeError: dereferencing a null pointer` | a `DateTimeFormat` |
| `Reflect.construct(Intl.DateTimeFormat, ["en-US"])` | `TypeError: undefined is not a constructor` | a `DateTimeFormat` |

#5378 fixed the `DateTimeFormat` arm only, deliberately, to keep its diff scoped
to the ZonedDateTime ladder. The other Intl constructors take the bag at the
same argument index and lose it the same way: the compiled object literal
reaches V8 as an opaque WasmGC struct, V8 reads no properties, the defaults
apply silently. Blast radius: every `intl402/NumberFormat/**`,
`intl402/ListFormat/**`, `intl402/PluralRules/**`, `intl402/RelativeTimeFormat/**`,
`intl402/Collator/**`, `intl402/Segmenter/**`, `intl402/DisplayNames/**` row
that asserts an option is honoured (not counted here — Step 3 counts it), plus
the Temporal `toLocaleString` family that builds a `DateTimeFormat` from a bag
via the polyfill.

## Implementation Plan (Fable, 2026-09-07)

**Step 1 — one arm, not seven.** #5378's fix is in `src/runtime.ts`'s
extern-class construct path (the `Request`/`Response` init-dictionary arm it
reused). Generalise: for a registered extern class (`src/codegen/extern-declarations.ts`,
the #5355 registration), marshal EVERY argument that is a compiled struct
through `_wrapForHost` at construction — not by class name. Measure that the
`DateTimeFormat`-specific arm becomes redundant and remove it (or keep it as
the generic one). Primitive/externref arguments are untouched.

**Step 2 — call-without-`new` and `Reflect.construct`.** The extern-class
callable must construct when called (Intl constructors are `[[Call]]`-able
and behave as `new`); `Reflect.construct(Intl.X, args)` must see a
constructor. Locate where `Intl.DateTimeFormat` is bound as a value
(`extern-declarations.ts` + the runtime mirror) and make the value a real
constructible function whose `[[Call]]` forwards to construct. Bound: these two
spellings only; no change to user classes.

**Step 3 — tests + measure.** `tests/issue-5381-intl-options-bag.test.ts`:
`NumberFormat`, `ListFormat`, `PluralRules`, `RelativeTimeFormat` with one
option each, consumer-only AND through a linked provider; the two
`DateTimeFormat` spellings; the `Request` init-dictionary control unchanged.
Measure `intl402/NumberFormat/prototype/format/**` + `intl402/ListFormat/**`
+ `intl402/DateTimeFormat/prototype/format*/**` (bounded, ≤400 rows) base vs
fix per row, 0 pass→fail. Never the full bucket.

## Acceptance criteria

1. All rows in the table above match node.
2. The generic arm replaces the per-class one (or the PR says why not).
3. Sample measured, 0 pass→fail, counts with artifacts.

## Notes

- Filed from PR #5706's "reported, not fixed"; predecessor #5355 (the
  `DateTimeFormat` bridge). Stacks on #5378.
- Id reserved via `claim-issue --allocate --allow-unscanned`; open PRs
  hand-checked 2026-09-07 — highest in-flight issue file is #5379.

## Implementation notes (dev-5381, 2026-09-07)

### The arm — one default, not a longer list

Step 1 asked whether the `DateTimeFormat`-specific arm becomes redundant. It
does, and it is **gone**: `webInitArgIndex` no longer exists. What replaced it
is not a longer list but an inverted rule.

`Request`, `Response` and `DateTimeFormat` were never three constructors. They
are one **shape** — a host constructor that READS PROPERTIES off an argument —
and a list of names is the wrong shape of fix for it, because every other
member of the shape is silently broken until someone notices and appends a
fourth name. So marshalling a compiled struct argument through `_wrapForHost`
is now the **default**, and the exceptions are exactly the constructors that
consume an argument by some *other* protocol. Every one of those already had
its own flag a few lines above, so the exception list is a re-use, not a new
list:

| exception | why the default must not apply |
| --- | --- |
| `isWrapperCtor` (String/Number/Boolean) | arity-sensitive; `new String(undefined)` ≠ `new String()` |
| `isIterableCtor` (Map/Set/WeakMap/WeakSet) | wants the iteration protocol (`_convertIterableForHost`) |
| `isBufferConsumer` (DataView / TypedArrays) | wants real bytes, not properties |
| `coercesArgsToPrimitive` (RegExp/Date/String/Number) | runs ToPrimitive on the struct (#1716) |
| the Error family | arg 0 is ToString'd (#3481); arg 1 carries `cause`, whose **object identity** §20.5.8.1 preserves verbatim — a proxy there breaks `e.cause === obj` |
| `isPromiseExecutorCtor` | arg 0 is a callable, not a bag |
| `_structArgIdentityCtors` | Object/Function/Array/WeakRef/FinalizationRegistry/AggregateError/SuppressedError/Test262Error — they store or hand back the argument itself |

Primitives and host externrefs are untouched: the guard is `_isWasmStruct`, and
a host object never satisfies it.

### Three paths, not one

The same defect lives on three paths, and fixing only the first would have left
two of the five table rows failing:

1. **`src/runtime.ts`, the registered-extern-class `new` resolver** — the rule
   above. Fixes `NumberFormat`, `ListFormat`, and anything registered later.
2. **`_marshalHostConstructArg`, the dynamic twin** — `new (Intl as any).PluralRules(…)`
   is *not* a registered extern class; it lowers to `__construct` on the host
   function fetched off the `Intl` global (#5206), a path the first arm never
   sees. Same default, scoped to host callees and excluding the identity set.
3. **`emitReflectArgs` (`src/codegen/expressions/call-namespace-static.ts`)** —
   a different root cause than the issue reported. `Reflect.construct(Intl.DateTimeFormat, ["en-US"])`
   did not fail with "undefined is not a constructor" (that symptom predates
   #5355); on this base it failed with **`TypeError: Intl.DateTimeFormat called
   on null or undefined`**, which is V8's message for `new Intl.DateTimeFormat("en", null)`.
   TypeScript types `Reflect.construct<A extends any[]>` so `A` infers from the
   TARGET's constructor signature — for `DateTimeFormat` that is the optional
   2-tuple `[locales?, options?]` — and the tuple-literal lowering padded the
   one-element literal to a full 2-field struct with an `undefined` second
   field. But `Reflect.construct`'s argumentsList is read with
   CreateListFromArrayLike (§7.3.18): the literal's **length** is the argument
   count, and an arity *signature* is not a length. That one argument position
   now compiles as a vec (`_arrayLiteralForceVec`), so the literal keeps its own
   length. `Reflect.construct(Map, [])` had the identical padding and escaped
   notice only because `new Map(null)` is legal.

### Measurement — `sample: 325 rows, 2026-09-07, this branch`

Base = the merged tree with only `src/runtime.ts` and
`src/codegen/expressions/call-namespace-static.ts` reverted to their
pre-change copies (file-copy A/B; both sides run through
`tests/test262-runner.ts`'s own `runTest262File`, one TSV row per test, so a
flip inside an already-failing row is visible).

| bucket | rows | base pass | fix pass | delta |
| --- | --- | --- | --- | --- |
| `intl402/NumberFormat/prototype/format/**` | 95 | 13 | 89 | **+76** |
| `intl402/ListFormat/**` | 81 | 12 | 18 | **+6** |
| `intl402/DateTimeFormat/prototype/format*/**` | 149 | 62 | 62 | 0 (already #5378's) |
| **total** | **325** | **87** | **169** | **+82** |

**pass→fail: 0.** fail→pass: 82. No other status transitions.
Artifacts: `.tmp/base-5381.tsv`, `.tmp/fix-5381.tsv`, `.tmp/paths-5381.txt`.

### Reported, not fixed — with the bound

- **The TYPED spellings `new Intl.PluralRules(…)` / `new Intl.RelativeTimeFormat(…)`
  / `new Intl.Collator(…)` still answer a NULL receiver** (`TypeError: Cannot
  read properties of null (reading 'select' | 'format' | 'compare')`, measured
  on this branch). That is #5355's defect verbatim — those three are not
  registered in `src/codegen/extern-declarations.ts`, so `compileNewExpression`
  falls through every arm — not this one. Bound: registering them is ~15 lines
  each plus a `builtinCtors` entry, gated on the JS-host lane exactly like
  `DateTimeFormat` (the #2961 no-leak ratchet forbids a new unsatisfiable host
  import in a standalone binary). Once registered they get the options-bag
  marshalling for free, which is the point of the generic arm. The tests here
  use the dynamic spelling for those two, which *does* work.
- **`Intl.DateTimeFormat("en-US")` without `new` and `Intl.NumberFormat(…)`
  without `new` already worked on this base** — measured `"1/1/1970"` and
  `"1.500"`. The issue's `RuntimeError: dereferencing a null pointer` row was
  recorded before #5355 landed. Both spellings are now asserted so the
  behaviour cannot silently regress.
- **The standalone `Reflect.construct` boundary path** (`__boundary_object_construct`,
  `boundaryReflectInterop`) carries the same tuple padding and was deliberately
  left alone: it hands the list to a compiled helper rather than to a host
  constructor, so switching its representation is a separate change with its own
  risk. Bound: the two `emitReflectArgs(3)` call sites at
  `call-namespace-static.ts` ~L1849/~L1962.
