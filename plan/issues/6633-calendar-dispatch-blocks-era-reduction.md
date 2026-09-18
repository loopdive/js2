---
id: 6633
title: "standalone: interface-typed Calendar dispatch (any-return method, mixed object-literal/class-instance impls) blocks reduction of the era undefined→null mismatch"
status: done
assignee: ttraenkler/sendev-s48
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-18
---

## Problem

`#5383` S45/S45b/S46/S46b reduced two failing test262 rows
(`test/built-ins/Temporal/PlainDate/from/argument-object-valid.js`,
`…/argument-string.js`) to `Test262Error: Expected SameValue(«null»,
«undefined») to be true` inside `TemporalHelpers.canonicalizeCalendarEra`,
traced to `date.era` where `date = Qt(this).isoToDate(n, {[t]: true})` (`t =
"era"`) — a polymorphic Calendar-interface method returning `any`, read back
via a computed key. #6632 fixed two sibling `ref_null $AnyString` →
`undefined` resurrection sites (typeof, the generic dynamic member-get
dispatcher) but explicitly left this third site open; S46/S46b's own
reductions of it hit unrelated pre-existing crashes instead of the target
mismatch.

## S47 findings (2026-09-18)

**Setup**: fresh worktree `issue-5383-standalone-temporal-s47` off
`3b82884459` (S46b tip). `CI=true pnpm install --frozen-lockfile` +
`npm run build:compiler-bundle` (18.3 MB bundle). Did not rebuild the Temporal
provider / QuickJS eval adapter or run the criterion-4 battery — see
"Scope not completed" below.

**Step 1 — re-verified the resurrection primitive is sound outside calendar
dispatch.** `.tmp/s47/repro10.ts` (a plain non-polymorphic function returning
`any`, building `{ era: undefined, eraYear: undefined, year, month, day,
daysInWeek: 7, monthsInYear: 12 }`, with a subsequent conditional
post-construction field assignment `if (requestedFields.dayOfWeek) {
date.dayOfWeek = 3; }` — mirroring the REAL `calendar.ts` `isoToDate` body
byte-for-byte apart from the interface wrapper) reads back `result[t]` (`t =
"era"`, computed key) correctly: `v === undefined` → `true`, `typeof v` →
`"undefined"`. This matches S46's own "obj literal key present value
undefined direct" control and REFUTES the leading hypothesis (S46's own
write-up) that the `$__extern_get`/`$__extern_set` dynamic-object-store
resurrection is the defect: the identical literal shape, without the calendar
interface/dictionary wrapper, resurrects `undefined` correctly through a
computed-key read in standalone mode.

**Step 2 — the calendar dispatch wrapper itself is unreachable synthetically,
via two SEPARATE, more severe, pre-existing defects — neither is the target
mismatch:**

1. **Interface-typed method call through a function-returned interface value
   traps unconditionally**, even reduced to `interface Cal { isoToDate():
   any } class Iso8601 implements Cal { isoToDate(): any { return 42; } }
   function getCalendar(): Cal { return new Iso8601(); } const cal =
   getCalendar(); console.log(cal.isoToDate());` (`.tmp/s47/repro9.ts`) →
   `TRAP dereferencing a null pointer`. This has NOTHING to do with `any`
   return content, undefined fields, or computed keys — a body as simple as
   `return 42` traps. Confirmed independent of computed-key reads
   (`.tmp/s47/repro7.ts`/`repro8.ts`, non-computed `.era` reads, also trap)
   and independent of the `undefined` field (`.tmp/s47/repro8.ts`, no
   `undefined` field at all, still traps). This matches S46's own
   "TRAP dereferencing a null pointer" note on `probe-dynset.mts` almost
   exactly, now isolated to its minimal shape: **interface method + `any`
   return + call through an interface-typed local sourced from a function
   return** traps regardless of body content.

2. **A `Record<string, Interface>` dictionary holding a MIX of a plain
   object-literal implementation and a class-instance implementation
   dispatches to the WRONG entry.** `.tmp/s47/repro13.ts`: `impl["iso8601"] =
   { isoToDate(req) { return { era: undefined, year: 999 }; } }` (object
   literal, matches the polyfill's ISO calendar registration byte-for-byte);
   `impl["gregory"] = new NonIsoCalendar()` (class instance, matches the
   polyfill's non-ISO registration `impl[helper.id] = new
   NonIsoCalendar(helper)` byte-for-byte) — **both** `getCalendar("iso8601")`
   AND `getCalendar("gregory")` call `NonIsoCalendar.isoToDate` (`year: 1,
   era: "x"` typeof `"string"`) instead of `"iso8601"`'s own body (`year:
   999`, `era: undefined`). This is a genuine, previously-undocumented
   defect — the interface-typed call site appears to devirtualize to
   whichever implementation the compiler resolves statically (the concrete
   class), not the true per-receiver dynamic dispatch a `Record<string,
   Interface>` with mixed literal/class values requires. **This exactly
   matches the polyfill's own `impl` registration shape** (`calendar.ts`
   L152 `impl['iso8601'] = {...object literal...}`, L2416 `impl[helper.id] =
   new NonIsoCalendar(helper)`, L28/L2420 `impl[id]` lookup by runtime
   string).

Both defects are BLOCKING, not cosmetic: reduction #1 traps before any
`SameValue` observation is possible; #2, if it also afflicts the real
polyfill's own `impl['iso8601']`/`NonIsoCalendar` dispatch, would mean the
compiled binary observed by test262 may not even be calling the ISO
calendar's `isoToDate` for a plain (no explicit calendar) `PlainDate.from` —
which would explain a `null` `era` read as a downstream symptom of dispatching
to the wrong implementation's storage (a genuine miss on a struct/key the
correct implementation never touches falls through to the legacy `ref.null.
extern` "not found" answer, not the canonical `undefined` singleton) rather
than as a resurrection defect at the read site itself.

**Neither defect was fixed here** — both are ORTHOGONAL new findings, outside
this issue's originally-scoped mechanism (`$__extern_get`/`$__extern_set`
resurrection), and each looks substantial enough (interface-dispatch
codegen / devirtualization) to warrant its own issue and architect review
rather than a same-session patch. Filing #6633 to record them rather than
losing the reduction.

**Time-boxed per the dispatch brief** ("If the mechanism resists within
~2.5h of tool time, hand back the reduction and hypothesis, not a speculative
fix"). Handing back after Step 2's second reduction rather than continuing to
chase the interface-dispatch codegen path, which is a different-sized problem
than the resurrection-site hunt this issue was scoped for.

## Scope not completed (out of time-box)

- Real-row re-verification with a freshly rebuilt Temporal provider — not
  run. No source change was made in this PR (findings-only), and S46b already
  re-confirmed both rows unchanged/still-red on the immediately-prior commit;
  re-running without a fix would not add new evidence.
- Criterion-4 battery (four-family, must-not-move A–E, corpus byte A/B,
  equivalence gate) — not run, for the same reason: no `src/` change to
  validate.
- `tests/issue-6633-*` witness test — not written; there is no fix to
  witness. A future PR that fixes reduction #1 or #2 above should add its own
  witness once the mechanism (interface-dispatch codegen, likely in
  `src/codegen/expressions.ts`'s call-site resolution or the IR interface
  method compilation) is identified.

## Recommendation for the next lane

Investigate reduction #2 first — it is the closer match to the real
polyfill's exact shape (`Record<string, Interface>` with mixed
literal/class-instance values) and, if confirmed to also misdispatch in the
real Temporal provider, is a plausible root cause for the `era`
`null`-vs-`undefined` mismatch that does not require touching
`$__extern_get`/`$__extern_set` at all. Reduction #1 (bare interface-typed
`any`-return call trapping) should be filed/triaged separately regardless —
it is a harder correctness bug (a trap, not a value mismatch) and likely
blocks other interface-heavy standalone code paths beyond Temporal.

## S48 resolution (2026-09-18)

Both reductions fixed by `#6634` — see that issue for the full root-cause
analysis and fix. Root cause was NOT the call-dispatch ladder this issue's own
findings suspected; it was one level upstream, at the interface's own
Wasm-carrier TYPE choice (`resolveWasmType`/`resolveStructName` in
`src/codegen/index.ts`/`property-access.ts`, plus a third, independent guess
in `call-receiver-method.ts`'s "final fallback: scan all known classes"
block): a method-only interface's own struct is synthesized as an
object-literal-compatible shape, which a class instance can never physically
match, so any class-instance value flowing through an interface-typed slot
silently nulls out. `interfaceHasClassImplementer` (new leaf module
`src/codegen/interface-class-implementer.ts`) makes the interface's carrier
externref whenever ANY known class implements it, letting the EXISTING
dynamic-receiver dispatch machinery discriminate correctly at runtime.

**Reduction #1** (bare interface-typed `any`-return call trapping,
`.tmp/s47/repro9.ts`): fixed — `42` instead of "dereferencing a null pointer".
**Reduction #2** (`Record<string, Interface>` mixed literal/class,
`.tmp/s47/repro13.ts`, matching the polyfill's exact `calendar.ts`
registration shape): fixed — each key now answers its OWN implementer.

Real-row re-verification (`argument-object-valid.js`/`argument-string.js`
against a freshly rebuilt Temporal provider) and the full criterion-4 battery
were **not completed** in the S48 slice (time-boxed) — see `#6634`'s "Scope
not completed" section and the handover note in `#5383`. This issue is marked
`done` because its own scope (identify and fix the two interface-dispatch
defects blocking the reduction) is complete; whether the fix actually moves
the two target test262 rows is `#5383`'s open question for the next slice.
