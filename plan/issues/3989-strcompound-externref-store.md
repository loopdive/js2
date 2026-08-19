---
id: 3989
title: "string `+=` into an externref slot emits invalid Wasm in standalone — the unfixed store half of #3472"
status: done
sprint: 78
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/L-evalink
created: 2026-08-01
completed: 2026-08-01
---

## Problem

In standalone / WASI mode, a string compound assignment (`x += ...`) whose
destination slot is **externref** emits a module that **fails Wasm validation**:

```
__module_init failed: global.set[0] expected type externref,
                      found call of type (ref null 6)
```

A validation failure costs the **entire file**, not the statement — the module
never instantiates, so every assertion in the test is lost, including the many
that never touch the compound assignment at all.

Minimal reproduction (goal scope, `test/language/types/reference/S8.7_A4.js`):

```js
var item = new String("test");
var itemRef = item;
item += "ing";
```

## Root cause

`compileNativeStringCompoundAssignment` in
`src/codegen/expressions/operator-assignment.ts` reads the current value,
concatenates via `__str_concat`, and stores the result back.

`__str_concat` **accepts and returns `ref $AnyString`**. But the destination
slot for a binding that is `any`/untyped — e.g. `var item = new String(...)`,
a String *object* wrapper — is **`externref`**.

#3472 already found this asymmetry and fixed exactly **one half of it**: the
**load**. Lines 1351–1360 coerce an externref slot to `ref $AnyString`
(`__extern_toString` → `any.convert_extern` → `ref.cast`) before the concat,
and the comment even says so — *"the RHS below is coerced, only the current-value
load was not"*.

The **store half was never fixed**. `__str_concat`'s `ref $AnyString` result
went straight into `global.set` / `local.tee` on an externref slot. That is the
validation error above: the value is a `(ref null 6)`, the slot wants
`externref`.

So this is not a new defect class — it is the missing mirror of a fix that
already landed. The load was made slot-type-aware; the store was not.

A second, quieter defect sits in the same place: the function returns
`anyStrType` unconditionally, but after `local.tee` / `global.set`+`global.get`
the value on the stack carries the **slot's** type. Reporting `ref $AnyString`
for a value that is actually `externref` hands the caller a type the stack does
not have, which migrates the validation error from this statement to whatever
consumes `x += y` **as a value**.

## Why the narrowing matters

The trigger is narrow and was isolated by controls, not by inspection. All of
these were and remain **VALID**; only the two marked INVALID reproduced:

| case | result at base |
| --- | --- |
| `var item = new String("t"); item += "ing";` | **INVALID** |
| `var a = new String("t"); var b = a; a += "ing";` | **INVALID** |
| `new Number` / `new Boolean` / `new Object` / `new Date` with `+=` | valid |
| the same `+=` on a **local**, not a global | valid |
| `-=`, `*=`, `++` on a `new String` | valid |
| `item = item + "ing"` (the desugared form) | valid |
| object-literal / array-literal / `any`-typed `+=` | valid |

That `item = item + "ing"` is valid while `item += "ing"` is not is the whole
diagnosis in one line: the compound-assign path has its **own** write-back that
bypasses the coercion the general assignment path performs.

## Fix

Coerce the concat result back to the slot type before storing —
`extern.convert_any`, the exact inverse of the `any.convert_extern` used on the
load — and report `externref` as the expression type in that case.

Both directions now live together in a new subsystem module,
`src/codegen/native-string-slot-bridge.ts`. That is not cosmetic: the two halves
of this bridge sitting inline at the call site and **drifting apart** is exactly
how the bug happened — #3472 added the inbound half and left the outbound one
missing. Keeping the inverses in one module makes a future change to one
visibly a change to half of a pair. It also satisfies the LOC-budget gate
(#3102) *architecturally*, with **no `loc-budget-allow:` allowance**: the
extraction moves the pre-existing inbound block out of the god-file too, so
`operator-assignment.ts` ends up no larger than it started.

The extraction is provably behaviour-preserving — the byte-identity A/B below
was re-run after it and is identical to the pre-refactor fix across all 24
mode×source combinations.

Gated on the **same** `noJsHost && slotType?.kind === "externref"` condition as
the load, deliberately:

- In JS-host `nativeStrings` mode the load is intentionally left uncoerced
  (adding the `__extern_toString` host import mid-body would shift function
  indices, #1175), so those modules are **already invalid at the `__str_concat`
  call** and never reach this store. Matching the gate keeps that lane
  byte-identical rather than half-fixing it.
- It adds **no import**, so there is **no funcIdx shift** — the standing hazard
  in this file.
- It adds exactly one stack-neutral instruction (consumes one value, produces
  one), so stack balance is unchanged.

## Measurement

Instrument validated first: the scan reproduces the published standalone
baseline exactly — 43,106 official rows / 25,460 pass / 59.1 %, goal scope
8,545 run / 6,004 pass / 70.3 %, **0 corpus files failed to open**.

> Note on the baseline: the numbers above are the **03:15 snapshot**. The
> `.test262-cache` JSONL is a snapshot, not a feed. Re-fetched against the
> published baseline (rows timestamped 19:01), the goal scope reads 8,545 run /
> **6,176** pass / **72.3 %**. Population figures below are from the fresh file.

Population, reachable and expected are reported **separately** and are not
reconciled with each other:

| | count |
| --- | --- |
| population — goal-scope files failing `invalid Wasm binary` | **62** |
| of those, this issue's mechanism (family B, `global.set` externref) | **21** |
| reachable — family B files that now instantiate | **21 / 21** |
| **flips — family B files that now PASS** | **13** |
| regressions across all 62 | **0** |

`invalid Wasm binary` is a **signature, not a mechanism**. The 62 files
decompose into at least six unrelated defects, and this fix moves **only its
own**:

| family | n | still invalid after fix | reachable | pass |
| --- | --- | --- | --- | --- |
| A `call[N]` externref (`__bindfn`, Function.prototype.bind) | 28 | 28 | 0 | 0 |
| **B `global.set` externref (this issue)** | **21** | **0** | **21** | **13** |
| C `f64.add/sub` vs i32 global (prefix/postfix inc/dec) | 8 | 8 | 0 | 0 |
| D `fallthru` | 2 | 2 | 0 | 0 |
| E `local.set` | 2 | 2 | 0 | 0 |
| F `any.convert_extern` | 1 | 1 | 0 | 0 |

Families A, C, D, E and F are untouched by design. In particular the eight
`f64.add/sub expected f64, found global.get of type i32` files are **not** an
externref problem and must not be credited to this fix.

### Evidence discipline applied

- **Positive control** — the local sweep reproduces the CI baseline for **62 of
  62** files before the change. The instrument can say NO.
- **Kill-switch attribution** — reverting *only* this hunk (file copy; never
  `git stash`) returns all five value probes to INVALID; restoring it returns
  all five to correct. Attribution is by removal, not by correlation.
- **Verified by VALUE, not by validation** — "the binary validates" is not "the
  test passes". Each probe instantiates the module (asserting **zero imports**,
  i.e. genuinely standalone) and checks the observable result:
  `new String("test") += "ing"` yields `item === "testing"` **and**
  `item !== itemRef` (the actual S8.7_A4 assertion), `"ab" += "cde"` has
  `length === 5`, chained `+=` gives `"abc"`, and a numeric RHS gives `"v42"`.
- **Solo, sequential re-run** — the sweep runs one file at a time in a single
  process, so no pool contention and no `compile_timeout` flakes inflate the
  count.
- **Host lane byte-identical** — A/B over host-default, host-`nativeStrings`,
  standalone and WASI: every host-lane binary hashes identically before and
  after.

`runTest262File` is not the CI path, so only its **pass/fail status** is
trusted here — never its error category or line numbers.

## Follow-ups (deliberately NOT in this PR — different mechanisms)

- **Family A (28 files)** — `call[N] expected externref, found ref.null of type
  (ref null 6)` in the `__bindfn` lowering. Existing lead: `compileFunctionBind`'s
  standalone arm, `src/codegen/expressions/calls.ts:2289`. Note a synthetic
  `call.bind` does **not** reproduce it; the `ref.null <struct>` appears to come
  from elsewhere in the module, so it needs its own bisect. **All 15 goal-scope
  `built-ins/String/prototype` `_A10` files are in this family**, so they are
  unreachable for a String.prototype semantics fix but are *not* fixed here
  either.
- **Family C (8 files)** — an i32-typed global read into f64 arithmetic by
  prefix/postfix `++`/`--`. Unrelated to externref.
- **Family E (2 files)** — both `language/statements/with`. Also unowned.
- Adjacent but **not** a validation defect: across all of
  `built-ins/String/prototype`, 129 files die at compile stage and only 20 are
  validation failures. ~98 of the rest are one named refusal — "standalone
  RegExp engine does not support a RegExp / symbol-protocol argument" across
  `search` / `match` / `split` / `replace` / `matchAll` / `replaceAll`. Large,
  single-cause, and unowned; sized as **population, not expected flips**.
