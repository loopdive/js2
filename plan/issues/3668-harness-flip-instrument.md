---
id: 3668
title: Harness-path flip instrument — measure whether a candidate fix flips real test262 tests
status: done
sprint: 77
priority: high
horizon: m
assignee: ttraenkler/opus-loop-g
completed: 2026-07-26
---

# Harness-path flip instrument (#3668)

## Problem

Every probe written against the detached-builtin defect family (#3667, #3661,
#3662, #3663) was a bare `compile()` of a hand-written snippet. That is **not**
the path conformance is scored on, and it measurably disagrees with it. So the
question _"does fixing this actually flip real tests?"_ was unanswerable, and
got argued rather than measured — three lanes produced three mutually
contradictory symptom tables for the same surface in one session.

## Deliverable

`scripts/harness-flip-probe.ts` — runs a list of test262 files through
`runTest262File` → `assembleOriginalHarness`, i.e. the real upstream harness
(`propertyHelper.js` et al.) inlined verbatim, and records pass/fail per file.

```bash
npx tsx scripts/harness-flip-probe.ts --self-test
npx tsx scripts/harness-flip-probe.ts --files list.txt --out before.jsonl
#   apply candidate fix, re-run to after.jsonl
npx tsx scripts/harness-flip-probe.ts --diff before.jsonl after.jsonl
npx tsx scripts/harness-flip-probe.ts --files list.txt --check-determinism
```

Method rules enforced **structurally**, not by convention — each one has burned
this project before:

1. **Mandatory positive control.** Every run first executes an always-pass and
   an always-fail fixture (`scripts/fixtures/harness-flip-control/`). If both
   directions are not observed, the tool aborts with exit 3 _without emitting a
   flip count_. Verified by sabotaging the must-fail fixture to pass: the tool
   correctly refused to run.
2. **Local-vs-local A/B only.** `--diff` detects and rejects the committed CI
   baseline jsonl as an arm (it sniffs `oracle_lane`/`oracle_version`).
3. **The partition must sum.** `--diff` asserts
   `gained + lost + other-change + unchanged + only-before + only-after ==
|union|` before printing anything.
4. **`skip` is its own outcome**, never folded into pass or fail.
5. **Status only.** `runTest262File`'s error _category_ and _source location_
   are known artifacts; the tool never aggregates or classifies by them.
6. **Zero flips is reported as a result**, explicitly, not as a failed run.

## Findings (verification of #3667)

All readings through the assembled harness on `origin/main` a69565b55, each
probe carrying a positive control. The 2x2 was confirmed deterministic
(byte-identical on repeat) and not a shadowing artifact (re-run with
uniquely-named captures gave an identical grid).

### The detached-builtin cell is real, but narrow

|                | read DIRECT   | read DETACHED |
| -------------- | ------------- | ------------- |
| write DIRECT   | ok            | ok            |
| write DETACHED | **undefined** | ok            |

Exactly **one** cell is broken. This **inverts** the table #3667 was opened on,
which reported detached _reads_ returning `undefined`/`null` — those all work
here. Detached `Object.keys` also works. A detached `defineProperty` is not a
silent no-op either: the **value lands** (`o.p === 33`) while the descriptor
stays invisible to the direct reader.

Mechanism: a detached write reaches the raw host `defineProperty`, which writes
a real host-visible property but never populates `_wasmPropDescs`. The direct
reader lowers to the `__getOwnPropertyDescriptor` import, which for a wasm
struct consults the sidecar (`src/runtime.ts:~198`) with **no host fallback**.
Refinement: when a sidecar entry already exists from a prior direct write, the
direct reader returns the **stale** entry rather than `undefined` — so this can
present as silently-wrong data, not only missing data.

### It is NOT one defect, and the detached cell is not the dominant one

`verifyProperty` fails on a property with no sidecar involvement at all:

```
var o = {}; o.p = 1;
verifyProperty(o,'p',{value:1,writable:true,enumerable:true,configurable:true});
  -> Test262Error: obj['p'] descriptor should be writable
```

Root cause is **property slot monomorphism**, upstream of the whole
detached-builtin story. `propertyHelper.js:isWritable` decides `writable` by
assigning the string `"unlikelyValue"` over the current value and reading it
back. A property whose first value was a **number** cannot subsequently hold a
**string**:

```
p4:  CTL-str2str:ok  CTL-num2num:ok  num2str:other  str2num:ok
     isWritable-shape:would-return-FALSE
p5:  typeof:string   value:NaN       CTL-strslot:ok
```

Both same-type controls pass and the reverse direction works, so the reading is
not vacuous. After the string write the slot holds a value reporting
`typeof === "string"` that is **not equal to itself** (`v !== v`). So
`isSameValue` fails, `isWritable` returns `false`, and `verifyProperty` reports
"descriptor should be writable" for **any numeric property of a user-created
object**.

### Reach (bounds, not flip counts)

- 5,067 corpus tests call `verifyProperty`.
- Only **382** pass `{restore: true}`, and `propertyHelper.js:132` is the only
  site where propertyHelper uses its detached `__defineProperty`. So the
  detached-write cell is reachable through propertyHelper in at most 382 tests.
- The `isWritable` path runs in essentially every `verifyProperty` call that
  asserts `writable`.
- 5,206 files declare `includes: [propertyHelper.js]`; of the 4,896 with a
  baseline status, **3,478 pass** / 1,400 fail / 9 compile_error / 7
  compile_timeout / 2 skip (verified to sum). So "propertyHelper is broken" is
  not a supportable claim, and the fail bucket is heterogeneous (Temporal etc.).

**No flip count is quoted for any of this**, and the widely-circulated "~1,038"
figure is not used — it comes from a different filter. Flip counts are what the
instrument exists to produce, from a local-vs-local A/B.

### Falsified prediction (recorded because it was wrong)

The proposed corroboration was that failing propertyHelper tests should be
enriched for `defineProperty`-defined properties. Measured over a three-way
partition verified to sum (n=4,896): `defineProperty` 75.1% pass,
`plain-own-object` 79.5%, `builtin-only` 65.1%. The `defineProperty` bucket
passes at a _slightly lower_ rate, but 671 of its 893 tests **pass** — nowhere
near the near-total failure the sidecar mechanism predicts. In the
non-propertyHelper control the direction even reverses (60.9% vs 49.0%). The
prediction is **not confirmed**, which is what pointed at a different root cause.

## Instrument hazards found (worth knowing before writing probes here)

- **`compile()` is `async`** and its result carries a lazily-built
  `importObject`. The `CLAUDE.md` validation snippet (un-awaited `compile`,
  `buildImports()` with no args) is stale: un-awaited it yields `{}` with
  `success === undefined`, which reads as "compile failed". A bare-`compile()`
  probe built that way produces garbage, and bare `compile()` disagrees with the
  harness path even when built correctly.
- `if (d.writable === true)` on a descriptor field fails to compile
  (`if[0] expected type i32, found global.get of type externref`), as does
  `"..." + err.message` in a `catch`. Both are unrelated codegen bugs — a
  CompileError from a probe is not evidence about the defect under study.

## Test Results

`tests/issue-3668.test.ts` covers the guard behaviour without compiling
test262: control fixtures present and correctly shaped, `--diff` partition
arithmetic, committed-baseline rejection, and `skip` never folded into
pass/fail. The end-to-end control was verified manually (`--self-test` reports
both directions; sabotaging the must-fail fixture makes the tool abort, exit 3).
