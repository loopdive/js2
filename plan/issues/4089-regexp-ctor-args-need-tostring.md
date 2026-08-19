---
id: 4089
title: "dynamic `new RegExp(pattern, flags)` casts its arguments instead of calling ToString — an object argument null-derefs and kills the module"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/H-crashes
created: 2026-08-02
completed: 2026-08-02
# RETIRE THIS ALLOWANCE IN #4067 (godfile-split: regexp-standalone engine vs
# bridge). It is paid for by 13 measured flips, and it is NOT permanent: the
# split moves `emitArgAsNativeString` out of the god-file and lets the second
# ToString site (`emitRegexSearchCall`) be deduped against it, at which point
# this line should be deleted rather than re-baselined.
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
---

## Problem

In standalone mode, a `new RegExp(...)` whose **flags** (or pattern) argument
is an object traps during top-level evaluation:

```js
new RegExp("abc{1}", { toString() { return ""; } });
// → RuntimeError: dereferencing a null pointer in __module_init()
```

`__module_init` dies, so the file loses **100 %** of its assertions.

Bisected — the object argument is the whole trigger:

| repro | result |
| --- | --- |
| `new RegExp("abc{1}", "")` | OK (control) |
| `new RegExp("abc{1}", {toString(){return ""}})` | **null-pointer deref** |

## Root cause

`compileStandaloneRegExpNew` (`src/codegen/regexp-standalone.ts`) compiled each
dynamic argument **with a native-string expectation and then `coerceType`d it**:

```ts
const emitted = compileExpression(ctx, fctx, flagsArg!, strType);
if (emitted.kind !== "ref" || emitted.typeIdx !== ctx.anyStrTypeIdx) {
  coerceType(ctx, fctx, emitted, strType, "string", compileStringLiteral);
}
```

For a string that is the same thing. For an **object** it is not a conversion
at all — §22.2.3.1 steps 5/7 require **ToString**, which must call the object's
own `toString()`. The emitted cast dereferenced a null instead.

The correct conversion already existed **in the same file**:
`emitRegexSearchCall` routes every `.test`/`.exec` subject through the runtime
`__extern_toString` (#3724). Two call sites needed the identical conversion and
only one had it — the recurring #4080 shape — so this extracts
`emitArgAsNativeString` as the single owner and the constructor now uses it.

### #4080 is now PREDICTIVE, not just retrospective

This is the sixth instance in one cluster (#3989, #4077, #4079, #4082, #4084,
this), and the distinction worth recording is that #4080 stopped being a
post-hoc label and started **finding** things:

| # | shape | how it was found |
| --- | --- | --- |
| #3989 | store half of a slot-type pair not updated with the load | reported |
| #4077 | arg↔param pairing re-derived instead of read | root-caused |
| #4079 | 8 copies of read/±1/store, all missing `i32` | root-caused |
| #4082 | third dispatch arm copied the `call_ref`, not the boxing | root-caused |
| #4084 | `elemToStr`'s last arm assumes "must be a string ref" | **predicted** |
| #4089 | second ToString site missing the conversion the first has | **predicted** |

For the last two the pattern came first: "look for a decision that must hold in
several places, where the newest copy is the one missing a case, and where the
invariant is stated in a **comment** rather than enforced." Both were then
confirmed by measurement. Six retrospective examples argue that #4080 is real;
two predictions argue it is *useful*, which is the stronger case for funding a
standing gate.

## Verified before relying on it

Reusing `__extern_toString` would be worthless if it did not honour a
user-defined `toString`, so that was measured first, not assumed:

```js
String({ toString() { return "ZZ"; } })   // → "ZZ"   (probe returns 1)
"" + { toString() { return "ZZ"; } }      // → "ZZ"   (probe returns 1)
```

It does. So this is a spec-correct conversion, **not** a crash-traded-for-a-
wrong-value (the #4083 hazard).

## Measurements

Baseline `test262-standalone-current.jsonl`, row timestamp `2.8.2026, 03:32` ·
official 43,505 run / 25,995 pass (59.75 %) · ES5+untagged goal scope 8,545 run
/ 6,298 pass (73.70 %) / 0 unopenable.

| stage      | count | note                                                       |
| ---------- | ----: | ---------------------------------------------------------- |
| population |    84 | goal-scope `illegal cast` / `null deref` in `__module_init` |
| mechanism  |    21 | the `built-ins/RegExp` sub-group                           |
| reachable  |    21 | all compile; the trap is at top-level evaluation           |
| **flips**  |    13 | `runTest262File`, `--target standalone`, run **serially**  |

**Kill-switch control** — same 21 files, same runner, `regexp-standalone.ts`
reverted to its `HEAD` version: **21 fail / 0 pass**. With the fix:
**13 pass / 8 fail**.

The 8 residuals hit the dynamic-engine pattern subset
(`Unsupported dynamic regular expression pattern`, a catchable TypeError) —
e.g. `abc{1}` needs `{n}` quantifier support in
`__regex_compile_dynamic_simple`. That is the regexp-engine lever, a different
issue, and explicitly out of scope here.

## The coercion-site gate caught a second hand-rolled site — and it was right

The first cut of this fix failed `quality` on the **coercion-site drift gate**
(#2108/#3131/#3279): `regexp-standalone.ts: 2 → 4 (__extern_toString 2→4)`.
My helper had its own `ensureLateImport` + `funcMap` lookup, duplicating the
one already in `emitRegexSearchCall`.

That gate offers a `coercion-sites-allow:` escape, and taking it would have
meant **two allowances in one PR** — exactly the trade this issue argues
against. It was also diagnosing the real defect: two hand-rolled ToString
lookups is precisely how these two paths drifted apart in the first place,
with only one of them actually applying ToString.

Fixed properly instead: `ensureRuntimeToStringIdx` is now the single resolver
and **both** paths call it. No allowance taken; the gate passes with no net
vocabulary growth.

Note this is the dedupe I explicitly declined earlier in this issue — but only
the *lookup*, not the surrounding control flow. `emitRegexSearchCall` keeps its
own compile/coerce sequence, including the subtle path where a `null` from
`compileExpression` does **not** bail. Verified by running the existing
standalone regex suites: **238 tests pass**
(`issue-1539-standalone-regex`, `-replace`, `issue-2161-regex-const-ctor`,
`issue-1474-standalone-regex-refuse`).

## Why this bucket is smaller than it looks (context for #4080 / triage)

While scoping this I classified where each of the 84 crash-bucket files
actually crashes:

| | count |
| --- | ---: |
| crash while building `throw new Test262Error(...)` — **downstream of an already-failed assertion** | 50 |
| crash at an `assert.*` line (ambiguous) | 30 |
| no source line in the error | 4 |

For those **50**, the test had already decided it failed. Fixing the crash
converts an opaque trap into a proper `Test262Error` — real diagnosability, and
**zero** conformance gain. So "84 crash files" is **not** 84 potential flips.
This RegExp sub-group was worth doing precisely because it was disambiguated by
probe and shown to crash in *construction*, upstream of every assertion.

## LOC-budget allowance — deliberate, and narrower than it looks

`src/codegen/regexp-standalone.ts` is a god-file at its ceiling and this adds
~40 lines, so the change-set takes a `loc-budget-allow:` above.

The alternatives were tried first and rejected on their merits:

- **Move the helper to a subsystem module.** `src/codegen/regex/` holds
  engine-only code (bytecode/compile/parse) and this is a *codegen bridge*
  (it needs `compileExpression` + `coerceType`); `shared.ts` is a
  delegate-registry that exists to break import cycles, not a home for emission
  logic. Either would have imported codegen-context deps into the wrong layer
  to satisfy a line count.
- **Dedupe by refactoring `emitRegexSearchCall`'s inline copy** to call the new
  helper. That would pay for the growth, but the search-call site has a subtle
  path the helper does not reproduce: when `compileExpression` returns `null` it
  does **not** bail — it still calls `__extern_toString`. Silently changing that
  under a 13-flip fix is the wrong risk to bundle.

This is **not** the #4084 precedent. There the same gate blocked a **0-flip**
change and taking an allowance would have been a bad trade, so it was filed
unshipped instead. Here the trade is 13 measured flips against ~40 lines in a
file already slated for splitting under **#4067** — which is the natural place
to retire this allowance and dedupe the two ToString sites together.

## Test

`tests/issue-4089-regexp-ctor-tostring.test.ts` — the object-flags repro
validates, instantiates and **runs** `__module_init` without trapping, and the
string-flags control still works. Asserted by value, not just by validation.
