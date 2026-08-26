---
id: 4485
title: "ES5 standalone: builtin-surface smalls — Error.prototype.toString, global value props, annexB Date (getYear/setYear/toGMTString), Array surface tail (~25 rows)"
status: done
completed: 2026-08-16
sprint: 78
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: builtins
goal: standalone-gap
related: [3006, 4426, 4481]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. Error (6) + built-ins/global (6) + annexB/Date (6) + Array surface tail (RangeError rows, [object Array] toString) grouped as bounded S-slices."
loc-budget-allow:
  # The LOGIC that could move DID move: the whole Error-instance write arm is a
  # new subsystem module (`src/codegen/error-instance-field-write.ts`, ~125
  # lines), which is why `assignment.ts` takes only the 7-line call site. What
  # remains in these four is growth that cannot live anywhere else, and it is
  # majority COMMENT — each of these edits is a table entry or an opcode swap
  # inside an existing emitter, and the measured reasons are longer than the
  # code.
  #
  #  - native-strings.ts +19: `__error_to_string`'s body IS this function.
  #    Steps 5-6 change from an early `return name` to materialising the empty
  #    string, and step 7 (empty NAME -> return msg) is new. Net ~8 emitted
  #    instructions + the §20.5.3.4 step-order note explaining why the old
  #    conflation made step 7 unreachable.
  #  - expressions/builtins.ts +13: the `setYear` 0..99 window inside
  #    `CALENDAR_SETTERS`. Three real instructions (`f64.trunc` into a temp,
  #    then test the temp) plus the note on why -0.9999999 must answer 1900 and
  #    why IEEE -0 needs no extra normalisation opcode.
  #  - array-object-proto.ts +11: two entries in the `DATE_PROTO_METHODS` CSV,
  #    one arity-table entry, and the `memberAliasOf` hook wired for Date. This
  #    file OWNS those tables; there is no subsystem module to move a table row
  #    into.
  #  - expressions/assignment.ts +11: the 2-line call to
  #    `tryEmitErrorInstanceFieldWrite` + its import + a 6-line note on why the
  #    arm must sit ABOVE the generic member-set arms (the standalone .name
  #    READ is a hard struct.get, so a write routed lower is invisible). Arm
  #    ORDER is load-bearing, so it cannot move to another function.
  - src/codegen/native-strings.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/assignment.ts
func-budget-allow:
  # The same two edits, seen per-function.
  #  - compileDateMethodCall 1022 -> 1035: this function IS the per-method
  #    ladder for Date.prototype, and `setYear` lives in its `CALENDAR_SETTERS`
  #    arm. The truncation fix is three instructions inside that arm; moving it
  #    out would mean lifting one branch of a switch away from the locals
  #    (`argLocals.y`, `tempAnyInvalid`) the surrounding arm allocates.
  #  - compilePropertyAssignment 706 -> 716: this function is the ORDERED chain
  #    of `try*` assignment arms. A new arm is one more link, and its position
  #    (above the generic member-set arms) is the mechanism — so it cannot be
  #    hoisted into a helper without changing the order the chain encodes. The
  #    arm's body already lives in its own module.
  - src/codegen/expressions/builtins.ts::compileDateMethodCall
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
---

# #4485 — builtin-surface smalls

## Problem

Four bounded surface families, ~25 rows:

- **A — Error.prototype.toString (6)**: §15.11.4.4 — `"Error: msg"` /
  `"Error"` composition from `name`/`message` (own or inherited), empty-name
  edge; `err.constructor.length === 1`; `new`-ability of the Error carrier
  ("is not a constructor").
- **B — global value props (6)**: `encodeURI === null`, `Date === null` —
  reading builtin GLOBALS as VALUES answers null; TypeError rows for
  calling missing ones. Same read-as-value class as #4442 solved for
  `Function` — the carrier dispatch generalizes per-name.
- **C — annexB Date (6)**: `getYear`/`setYear`/`toGMTString` must exist as
  own properties of Date.prototype with function typeof and B.2 semantics
  (`getYear` = getFullYear−1900 incl. the −0.999999 → 0 edge).
- **D — Array surface tail**: `new Array(2^32)` → RangeError ("too large"
  rows must be a catchable RangeError instance);
  `x.toString()` → `"[object Array]"` via Object.prototype.toString.call.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   per-family lists.
2. B first — it is the #4442 pattern verbatim: per-name carrier or
   provider-linked intrinsic, decided by module-level demand
   (`function-intrinsic-carrier.ts` is the template; #3006's
   `BUILTIN_CTOR_ARITY` seeds names/arities).
3. A: the Error family already has carriers (#3006 lineage) — the
   composition body is a small reflective method (pattern:
   `string-proto-concat.ts` (#4426) for building strings native-side).
4. C: Date.prototype surface — add the three names to the existing Date
   proto dispatch with B.2 bodies; own-property assertions need them
   visible to hasOwnProperty (check how existing Date methods answer it).
5. D: RangeError instance at the `new Array(len)` length gate (#4426's
   `emitArraySetLengthValidation` is the adjacent validated path);
   `[object Array]` tag from Object.prototype.toString's class table.
6. Controls: scoped sweeps per directory; Date/Error/Array pins; zero
   regressions.

## Acceptance criteria

- ≥14 rows flip across the four families; zero regressions; residuals with
  owners.

## Root cause

Five distinct causes, one per landed change. Family C's three were recorded by
the first agent before its worktree was lost; each is re-stated here only
because I re-measured it myself on this branch's base — the numbers below are
mine, not inherited.

### C — annexB `Date.prototype` (three causes)

1. **`setYear` / `toGMTString` absent from the `DATE_PROTO_METHODS` CSV**
   (`src/codegen/array-object-proto.ts`). That CSV is the proto object's own
   member set, so `hasOwnProperty` / `getOwnPropertyDescriptor` /
   `Date.prototype.setYear` all answered "not there" even though `setYear`'s
   CALL body had existed since #1440 (`CALENDAR_SETTERS`). Two of the three
   gaps were table entries.
2. **`setYear` tested the RAW f64 against the 0..99 window.** §B.2.4.2 step 5
   takes `ToIntegerOrInfinity(y)` FIRST. Every fractional year in `(-1, 0)`
   was mis-routed: `setYear(-0.9999999)` truncates to `-0`, which IS in
   `[0, 99]`, so the answer is 1900 — but `-0.9999999 >= 0` is false, so it
   fell to the else arm and later truncation produced year 0.
3. **`toGMTString` minted its OWN closure singleton.** §B.2.4.3 requires the
   SAME function object as `toUTCString`, and the closure factory keys its
   identity-bearing meta struct type on `proto:<brand>:<kind>:<member>`, so
   two names meant two objects.

### B — `encodeURI` as a value

`STANDALONE_ES5_GLOBAL_FUNCTION_NAMES` (`standalone-global-functions.ts`)
listed `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `decodeURI`,
`decodeURIComponent`, `encodeURIComponent` — **and not `encodeURI`**. Its
direct CALL had a native lowering all along, so only the VALUE read broke, and
it broke silently: `encodeURI` read as `null` while all three siblings read as
functions. That sibling asymmetry is the whole finding.

### A — `Error.prototype.toString` composition (two causes)

4. **`err.name = "X"` was a WRITE bug, not a formatting one.** The standalone
   `.name` / `.message` read is a hard `struct.get` of `$Error_struct` field
   2 / 1 (`property-access-dispatch.ts`, #1536/#2077); the WRITE had no
   matching arm, so it landed where no reader looks. Measured on base:
   `e = new Error("m"); e.name = "N"; e.name` → `"Error"`. `toString` was
   reading the constructor's value, correctly, from a field the program had
   tried to change.
5. **`__error_to_string` conflated §20.5.3.4 steps 5-6 with steps 7-9.** An
   absent/non-string message early-returned `name` instead of becoming the
   empty string, so step 7 (`name is "" → return msg`) was unreachable.

### D — Array surface tail: NO defect on this base

`new Array(2^32)` and `new Array(-1)` already throw a catchable **RangeError
instance**, and `Object.prototype.toString.call([])` is already
`"[object Array]"` — verified through `runTest262File` on the standalone lane
before any edit. Recorded as a regression guard in the pin file, **not claimed
as a fix**. The issue's D bullet was a map, not a measurement.

## Fix

| file | change |
| --- | --- |
| `src/codegen/array-object-proto.ts` | `setYear` + `toGMTString` into `DATE_PROTO_METHODS`; `toGMTString: 0` arity; `memberAliasOf` wired for Date |
| `src/codegen/native-proto.ts` | new optional `NativeProtoBuiltinGlue.memberAliasOf`, applied at the TOP of `ensureStandaloneNativeMethodClosure` so func name, `nativeClosureMeta` and the identity-bearing meta struct type all key on the canonical member |
| `src/codegen/expressions/builtins.ts` | `setYear` window test + `+1900` now use `f64.trunc(y)` |
| `src/codegen/standalone-global-functions.ts` | `encodeURI` added (name list + arity); mask table picked by helper FAMILY, not by a single name |
| `src/codegen/registry/types.ts` | `$Error_struct.name` (field 2) → `mutable: true`; index unchanged |
| `src/codegen/error-instance-field-write.ts` (new) | `tryEmitErrorInstanceFieldWrite` — `struct.set` arm for `.name` / `.message` on a statically-Error receiver |
| `src/codegen/expressions/assignment.ts` | +7 lines wiring that arm into `compilePropertyAssignment`, above the generic member-set arms |
| `src/codegen/native-strings.ts` | `__error_to_string` re-ordered to the spec's steps 3-9, with a real empty-string message and the empty-NAME arm |

Only closure IDENTITY is aliased for `toGMTString` — it stays its own entry in
`memberCsv`, so it is still an own property of `Date.prototype` for
`hasOwnProperty` / gOPD. No other builtin family has an alias.

### Two narrowings the measurements forced (both worth keeping)

- **The field table is a `Map`, not an object literal.** As a plain object,
  `TABLE["toString"]` inherits `Object.prototype.toString` — a FUNCTION, so
  the `=== undefined` decline never fires and the arm emitted `struct.set`
  with a function where a field index belongs. Not hypothetical: it produced
  `Codegen error: struct field index out of range — function toString()
  { [native code] } (valid: [0, 6))` and **broke a passing row**,
  `built-ins/Error/prototype/S15.11.4_A2.js`, which does exactly
  `Error.prototype.toString = Object.prototype.toString`. Same class as the
  `hasOwnProperty`-not-`in` note on `CALENDAR_SETTERS` (#1638).
- **`stack` is excluded, and `<Ctor>.prototype` receivers are declined.**
  Including `.stack` turned `err.stack = null`
  (`.../Error/prototype/stack/setter-via-assignment.js`, failing either way)
  from a missing-TypeError into a runtime `illegal cast` trap; the error-stack
  proposal makes `stack` an ACCESSOR whose setter throws on a non-string, so a
  silent data write is the wrong answer, not an incomplete one. Separately,
  `Error.prototype` is typed as the INSTANCE type by the checker but is not an
  `$Error_struct` at runtime. Absent-not-wrong: both decline.

## Test Results

Every number below is from a sweep **I** ran on branch `issue-4485-take2`,
base captured as `.tmp/base-*.ts` revert copies and re-run, standalone lane via
`runTest262File`.

| directory | base | after | delta |
| --- | --- | --- | --- |
| `annexB/built-ins/Date` (C) | 14/24 | **23/24** | **+9**, 0 broke |
| 44-row list over `encodeURI` + 9 sibling global-fn dirs (B) | 31/44 | **36/44** | **+5**, 0 broke |
| `built-ins/Error/prototype/toString` (A) | 7/17 | **11/17** | **+4**, 0 broke |
| `built-ins/Error` (whole dir, control) | 24/93 | **28/93** | **+4**, 0 broke |
| `built-ins/NativeErrors` (control) | 54/94 | 54/94 | 0, 0 broke |
| `built-ins/Date/prototype` (485 files, control) | 434/485 | 434/485 | 0, 0 broke |

**Total +18 rows, zero regressions**, against a ≥14 acceptance bar.

Flip list (every row, all measured):

- C: `setYear/{B.2.5, length, name, not-a-constructor, this-not-date,
  year-number-relative}.js`, `toGMTString/{not-a-constructor, prop-desc,
  value}.js`
- B: `encodeURI/{name, not-a-constructor, prop-desc, S15.1.3.3_A5.2,
  S15.1.3.3_A5.3}.js`
- A: `Error/prototype/toString/15.11.4.4-{8-1, 8-2, 9-1, 10-1}.js`

Pins: `tests/issue-4485.test.ts` — **34 tests, all green**. Most drive
`runTest262File` on the exact rows above rather than a bare `compile()` probe,
because the two harnesses **disagree** on several of these behaviours in both
directions (`typeof Date === "function"` is true in a bare probe and false on
the lane; `e.name = "N"` write-through is the reverse — same trap recorded in
`es5-standalone-ctor-identity.test.ts`, #4223/#4232). Six residual rows are
pinned by asserting they STILL FAIL, so a later fix trips the pin rather than
passing silently.

Named neighbouring suites re-run green: `issue-2500-uri-encoding`,
`issue-2671-getyear`, `issue-1440`, `issue-3401` (48 tests) and
`es5-standalone-ctor-identity`, `issue-2962` (32 tests).
`tests/issue-4442.test.ts` has **6 pre-existing environmental failures** in
this container (`JS2WASM_EVAL_ENGINE=quickjs`, no quickjs provider built) —
unrelated to this diff; its non-provider half is green.

## Residuals

| residual | rows | owner |
| --- | --- | --- |
| `Error.prototype.toString` on an ARBITRARY receiver — needs a reflective body doing a real property Get plus ToString/ToPrimitive abrupt propagation; the native helper only reads `$Error_struct` fields | `toString/{undefined-props, invalid-receiver, called-as-function, tostring-get-throws, tostring-message-throws-symbol, tostring-message-throws-toprimitive}.js` (6) | successor A-slice; the composition half is done |
| Bare builtin **CONSTRUCTOR** globals (`Date`, `Array`, `Object`, `Error`, …) still read as `null` | `built-ins/Date/{prop-desc, name, length, is-a-constructor, S15.9.4_A1..A5}.js` and the same shape per builtin (dozens) | the #4442 carrier generalisation. `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` is the seam, but a plain `$Object` carrier is NOT enough: these rows need a CALLABLE with own `length`/`name`/`prototype`. Family B here covered the function-PROPERTY half only |
| `Object.prototype.toString` @@toStringTag overrides + builtin class tags (`[object Map Iterator]`, …) | `built-ins/Object/prototype/toString/symbol-tag-*.js` (~14) | separate slice; the `[object Array]` tag family D asked for already works |
| `verifyPrimordialCallableProperty` derefs null — calling a function value held in an object property | `built-ins/{isNaN,isFinite,parseInt,parseFloat}/prop-desc.js` (4) | indirect-call-of-function-value lane, not the value-read lane |
| `__uri_encode` / `__uri_decode` illegal cast on an object argument with `valueOf` | `built-ins/{encodeURI,decodeURI,encodeURIComponent,decodeURIComponent}/*_A6_T1.js` (4) | ToPrimitive-at-the-URI-boundary slice |

> Note for the merge: the lead's checkout carries a `## Recovered findings`
> section (the first agent's family-C notes) that this worktree's copy predates.
> It was the INPUT to family C above and is superseded by `## Root cause` /
> `## Test Results`; keep either, but the numbers here are the re-measured ones.
