---
id: 6647
title: "standalone Temporal: the five `Expected a RangeError … no exception thrown` rows are a polyfill-grammar gap + i64 BigInt; the fixable defect found underneath is a live-global-bound call answering `null` for an object result"
status: done
completed: 2026-09-20
assignee: ttraenkler/sendev-s69
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
---

## Problem

Five red rows in the standalone Temporal lane share one symptom —
`Test262Error: Expected a RangeError to be thrown but no exception was thrown
at all`:

| row | first failing assertion |
| --- | --- |
| `Duration/compare/relativeto-propertybag-invalid-offset-string.js` | offset `"+00:0000"` |
| `Duration/compare/relativeto-string-invalid.js` | `"2025-01-01T00:00:00+00:0000"` |
| `Duration/compare/throws-when-target-zoned-date-time-outside-valid-limits.js` | `new Temporal.ZonedDateTime(864n * 10n ** 19n, "UTC")` |
| `PlainDateTime/from/argument-string-invalid.js` | `"2025-01-01T00:00:00+00:0000"` |
| `ZonedDateTime/prototype/add/overflow-adding-months-to-max-year.js` | `new Temporal.ZonedDateTime(-(864n * 10n ** 19n), "UTC")` |

All five reproduce on the branch base `ce58705b68` (S68 head) against a fresh
`cacheHit=false` `--target both` provider
(`JS2WASM_TEMPORAL_CACHE=…/.test262-cache/s69-1`).

## Finding — the brief's two hypotheses are both WRONG, and the five rows split two-and-three

Neither hypothesis (a) "the provider throws but the exception is swallowed at
the link boundary / in `assert.throws`'s callback path" nor (b) "a value
crosses the seam wrongly" survives measurement.

Hypothesis (a) is dead: exception propagation through a closure passed to a
helper, through an `assert.throws`-shaped call, and through `assert.throws`
itself is **clean** (`.tmp/s69/probes/l3.js`) — `v6=THREW`, `v7=OK`, `v8=OK`,
`v9=THREW`, `v10=THREW` for a plain `throw`, a Temporal-originated `RangeError`
and an `assert.throws` wrapper alike.

### Mechanism A — the polyfill itself does not reject `+00:0000` (3 rows). NOT a js2wasm defect.

`@js-temporal/polyfill`'s offset grammar is

```js
_o = new RegExp(`^${/([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9])(?::?([0-5][0-9])(?:[.,](\d{1,9}))?)?)?/.source}$`)
```

— the hour/minute and minute/second separators are **independently optional**
(`:?`), so `+00:0000` matches and `ParseTimeZoneOffsetString` returns instead of
throwing. test262 asserts the *newer* normative rule ("the hour/minute and
minute/second separator or lack thereof needs to match"), which this polyfill
version predates.

Measured under **plain Node, importing the polyfill directly** — no js2wasm in
the path at all (`.tmp/s69/probes/host-truth.mjs`):

| expression | polyfill under Node |
| --- | --- |
| `Temporal.PlainDateTime.from("2025-01-01T00:00:00+00:0000")` | **NO-THROW** `2025-01-01T00:00:00` |
| `Temporal.PlainDateTime.from("2025-01-01T00:00:00+0000:00")` | **NO-THROW** |
| `…from("202501-01T00:00:00")` | THREW RangeError |
| `…from("2025-0101T00:00:00")` | THREW RangeError |
| `…from("2025-01-01T00:0000")` | THREW RangeError |
| `…from("2025-01-01T0000:00")` | THREW RangeError |
| `Duration.compare(d, d, { relativeTo: "2025-01-01T00:00:00+00:0000" })` | **NO-THROW** `0` |
| `Duration.compare(d, d, { relativeTo: { …, offset: "+00:0000" } })` | **NO-THROW** `0` |

The two NO-THROW strings are exactly the two the standalone rows stop on, and
`argument-string-invalid.js` reports the **first** list entry that fails to
throw — `+00:0000` — which is the first of the six separator-mismatch strings.
So the whole gap for those three rows is the polyfill version; the host lane
fails them for the same reason.

**Consequence:** these three rows are only movable by upgrading (or patching)
the vendored polyfill's ISO/offset grammar. They are NOT fixable in codegen and
should not be counted against the standalone lane.

### Mechanism B — standalone BigInt is a branded i64, so the >2^63 epoch-ns limits never trip (2 rows)

`src/codegen/host-bigint-carrier.ts` selects the arbitrary-width JS BigInt
carrier **only** when `environment === "javascript" && semanticProviders ===
"host-assisted"`. On the native-first/standalone lane a `bigint` maps to
`{ kind: "i64", bigint: true }` (`src/checker/type-mapper.ts` ~L50), and
`src/codegen/bigint-format-native.ts` says so in its own header: *"Emit exact
signed-**i64** BigInt formatting"*, buffer `sign + 64 binary digits`.

Both remaining rows build their out-of-range receiver from a BigInt literal
larger than 2^63, so the value silently wraps and lands **inside** the
supported range (`.tmp/s69/probes/l2.js`, `l4.js`):

| expression | standalone | expected |
| --- | --- | --- |
| `String(864n * 10n ** 19n)` | `6923773503929844000` | `8640000000000000000000` |
| `String(10n ** 19n)` | `-8446744073709552000` | `10000000000000000000` |
| `String(8640000000000000000000n)` (literal) | `6923773503929844000` | itself |
| `new Temporal.ZonedDateTime(864n*10n**19n,"UTC").epochNanoseconds` | `6923773503929843712` | `8640000000000000000000` |
| `new Temporal.ZonedDateTime(-(864n*10n**19n),"UTC").epochNanoseconds` | `-6923773503929843712` | `-8640000000000000000000` |

`8.64e21 mod 2^64 = 6.923773503929843712e18` — an exact i64 wrap. The
constructed `ZonedDateTime` is therefore ~219 years from the epoch, not at the
limit, so `Duration.compare(…)` answers `1` and `minYear.add(…)` succeeds.

`overflow-adding-months-to-max-year.js` has a **misleading line attribution**:
the runner reports `L12` (the `maxYear` assertion), but `L12` PASSES —
`.tmp/s69/probes/l4.js` `[c1=THREW][c2=OK]` — and the real failure is `L15`,
the `minYear` assertion, `[c3=NOTHROW][c4!Expected a RangeError…]`. Anyone
debugging from the reported line will chase the wrong assertion.

**Consequence:** these two rows need arbitrary-precision BigInt on the
native-first lane. That is an XL project of its own, not an `m`-horizon splice.

## The defect this probing surfaced and FIXED — a live-global-bound function declaration answers `null` for an object result

While reducing the rows above, a broader standalone defect fell out, and it IS
fixable at this horizon. Under the **linked standalone Temporal provider with
`eval` reachable**, a **function declaration that returns a freshly built plain
object or array** answers `null` at its call site, while the same function
answers correctly through `.call`/`.apply`/`new`.

`.tmp/s69/probes/l8.js` (with `features: [Temporal]`) vs `l8b.js` (identical
source, feature tag removed):

| shape | with provider | without provider |
| --- | --- | --- |
| `function f(){ return {a:1}; } f()` | **NULL** | object |
| `function f(){ return [1,2]; } f()` | **NULL** | object |
| `function f(){ var o={}; o.a=1; return o; } f()` | **NULL** | object |
| `function f(){ return "s"; } f()` / `return 1` | string / number | same |
| `function f(){ return Object.create(null); } f()` | object | object |
| `f.call(undefined)` / `f.apply(undefined, [])` / `new f()` | **object** | object |
| `var f = function(){ return {a:1}; }; f()` (expression) | object | object |

### The trigger is `eval`, not the provider — a one-line repro

Bisected by prefix (`.tmp/s69/probes/tp3.mts`, ~7 s per run against the REAL
provider through `compileWithTemporalGlobal`):

| prefix fed to the probe | result |
| --- | --- |
| `harness/assert.js` + `harness/sta.js` | object (clean) |
| `scripts/test262-fyi-runtime.js` with its three `eval` uses REMOVED | object (clean) |
| `function ev(s) { return eval(s); }` — **one line** | **NULL** |

`eval` alone without the provider is clean (`.tmp/s69/probes/fasteval.mts`,
`canonical=false|true` both `object`), and `sharedExceptionTag: true` is not
the trigger either (`fasteval2.mts`). The two together are: `eval` +
`runtimeEvalPlan.sharedRealmMayContainCanonicalValues` (which the link
supplies) set `ctx.runtimeEvalGlobalFunctionBindings`
(`src/codegen/index.ts` ~L9886).

### Root cause

With that flag set, `hasLiveFunctionBinding` (`call-identifier.ts` L274) is
true for every top-level function declaration, so `compileIdentifierCall`
routes the call through `tryEmitInlineDynamicCall` instead of emitting a direct
`call` — correct in itself, since runtime eval may replace the binding.

The dynamic dispatcher can only produce an `externref`. But the function-value
wrapper minted by `ensureFuncClosureSingleton`
(`src/codegen/closures/method-trampolines.ts` L1170) keeps the callee's own
wasm result type, so for `function g(){ return {a:1}; }` the trampoline's
funcref type returns a CONCRETE struct:

```wat
(func $__fn_tramp_g1_cached (type 142)
  (block (result (ref null 53)) f64.const 1  ref.null 3  struct.new 53  br 0))
```

No dispatcher arm can match that shape, so the call answers `null`. The two
promotions already sitting on that same line — the parked-async `$Promise`
promotion (#4630) and the native-generator state bridge — are the precedent:
the WRAPPER's result is promoted to `externref` while the declaration's own
signature and every direct call site are left untouched.

### The fix

One gate + one `extern.convert_any` in `ensureFuncClosureSingleton`, armed only
when the module is host-free AND `runtimeEvalGlobalFunctionBindings` is set AND
the callee's single result is a concrete `ref`/`ref_null`. A program without
`eval` is byte-identical: the standalone Temporal provider binary is 3 489 530 B
before and after (the polyfill has no `eval`, so its own functions keep the
precise wrapper type).

### Witness

`tests/issue-6647-live-global-binding-object-result.test.ts` +
`tests/dogfood/temporal-6647-harness.mjs` (child process — the 3.3 MB provider
compile OOMs a vitest worker in-process, same rationale as the S2 smoke
harness). Five defect probes, four controls.

| probe | true base `ce58705b68` | fix |
| --- | --- | --- |
| `objectLiteral` | 0 (null) | 1 |
| `objectProperty` | −1 (null) | 7 |
| `arrayLiteral` | 0 | 1 |
| `builtObject` | 0 | 1 |
| `calledFromNested` | 0 | 1 |
| `ctrlNoEval` / `ctrlApply` / `ctrlStringResult` / `ctrlTemporal` | 1 | 1 |

Base run: file-copy revert of the one touched file to `ce58705b68`
(`.tmp/s69/ab/base/method-trampolines.ts`), log `.tmp/s69/witness-base.log`.

## A SEPARATE, still-open provider defect — `PlainDate.prototype.add` is broken for every input

Initially mis-attributed to the mechanism above; **falsified**. It reproduces
with no `eval` and no test262 harness at all, straight through
`compileWithTemporalGlobal` (`.tmp/s69/probes/spec2.json`):

```
PD.toString()                       => [object Object]      (control, ok)
PD.with({ day: 3 }).toString()      => [object Object]      (control, ok)
PD.add({ days: 1 }).toString()      => !Cannot destructure 'null' or 'undefined'
PD.add(DUR).toString()              => !Cannot destructure 'null' or 'undefined'
PD.subtract(DUR).toString()         => !Cannot destructure 'null' or 'undefined'
PlainYearMonth.from('2000-05').add({months:1}) => !Cannot destructure …
```

So the failure is inside the PROVIDER module, on the `Wr()` path
(`function Wr(e){ const t=qr(e), n=Math.trunc(t.time.sec/86400); … return
{...t.date, days:n} }`) which the `PlainDate`/`PlainYearMonth` arithmetic uses
and the `ZonedDateTime` arithmetic (which goes through `Ar`) does not —
matching the measurement that `zdt.add(dur)` works.

Measured row cost, standalone, provider `s69-1`:

| directory | fail / total | same error |
| --- | --- | --- |
| `PlainDate/prototype/add/` (first 39 files, `.tmp/s69/pdadd.tsv`) | 22 / 39 | 20 |
| `PlainDate/prototype/subtract/` + `PlainYearMonth/prototype/{add,subtract}/` (`.tmp/s69/scope1.tsv`) | 56 / 111 | ~41 |

~78 rows in four directories on one mechanism.

### Reduced (`.tmp/s69/probes/linked5.mts` → `linked8.mts`, ~15 s per run)

It reduces INSIDE a provider module, which is why every consumer-side reduction
came back clean (`linked3.mts`: object literal, array, nested literal,
statement-built object, `{...o, k:v}`, `Object.assign`, null-proto object all
cross the link correctly).

**An object built by an object-SPREAD literal from a provider-LOCAL source is
broken once it crosses a FUNCTION-RETURN boundary** — reading a property of it
answers `null` or traps, even though `typeof` still says `"object"`:

| provider function | consumer reads | result |
| --- | --- | --- |
| `s2(){ const o={years:1}; const x={...o,days:9}; return x.days; }` (read INSIDE, no return of the object) | `NS.s2()` | **9** ✅ |
| `collideParam(o){ return {...o, days:9}; }` (spread of a PARAM) | `.days` | **9** ✅ |
| `plain(e){ return {years:e, days:0}; }` (no spread) | `.years` | ✅ |
| `noCollide(){ const o={years:1,months:2}; return {...o,days:9}; }` | `.days` | **`Cannot access property on null or undefined`** |
| `collide(){ const o={years:1,days:0}; return {...o,days:9}; }` | `.days` | same |
| `{days:9, ...o}` (spread last) | `.years` | same |
| `wr(e){ const t=qr(e); return {...t.date, days:n}; }` | `typeof NS.wr(3)` | `"object"` — but `.days` fails |
| `wrDays(e){ return wr(e).days; }` (the read is INSIDE the provider) | `NS.wrDays(3)` | **TRAP `dereferencing a null pointer`** |

So the carrier survives a `typeof` but not a property read, and the boundary it
does not survive is the **function return**, not the link: the in-provider
`wrDays` read traps too. A spread of a PARAMETER is fine, which points at the
source object's local/return representation rather than at the spread builder.

That is the highest-value remaining target in this lane.

## Verification

| check | result | artifact |
| --- | --- | --- |
| witness `tests/issue-6647-*` on a TRUE file-copy revert of `src/codegen/closures/method-trampolines.ts` to `ce58705b68` | 5 of 9 probes fail (`objectLiteral` 0, `objectProperty` −1, `arrayLiteral` 0, `builtObject` 0, `calledFromNested` 0); all 4 controls pass on both sides | `.tmp/s69/witness-base.log`, `.tmp/s69/ab/base/method-trampolines.ts` |
| the same probe file through the REAL runner (`.tmp/s69/probes/l8.js`, 15 shapes) | base 14 NULL / 1 object → fix **15 / 15 object** | `.tmp/s69/rows-after.log` |
| four-family battery, fresh `cacheHit=false` `--target both` provider `s69-2` built from HEAD | **463 / 480** — PlainDate 120, Duration 109, PlainDateTime 117, ZDT 117 — identical to S68 | `.tmp/s69/battery/*-cur.tsv` |
| all 13 battery groups (3 684 rows) vs the S68 base | **0 pass→fail, 0 fail→pass**, 0 missing | `.tmp/s69/battery/diff-all-s69.log` |
| the one flip the contended run showed | `Duration/negative-infinity-throws-rangeerror.js` → `compilation timeout (32322.27ms)` against the runner's 30 s budget, while the corpus/equivalence/sweep runs shared the box. Re-run on an idle box with the battery's OWN `run-family` settings: **pass**, family 109/120, 0 pass→fail. The contended TSV is kept as `Duration-cur-contended.tsv`; `Duration-cur.tsv` is the idle-box run | `.tmp/s69/battery/duration-rerun.log` |
| corpus 47 files × {gc, standalone} | statusFlips=0 shaFlips=0 over 84 matched rows (the fix run has 10 extra rows — five `tests/fixtures/normalize-ucd17-*` files absent from the S68 worktree's base; new rows, not flips) | `.tmp/s69/corpus-fix.jsonl` |
| equivalence | 22 failing / 1 720 passing / 22 known — unchanged from S68 | `.tmp/s69/equiv.log` |
| witness sweep `tests/issue-66*` + 6484 + 6493 (52 files / 290 tests) | Node 22.22 and Node 25.9: 288 pass, 2 fail — `issue-6602` and `issue-6603`, the two known `origin/main` breakages (PRs #5999–#6004), not this slice's | `.tmp/s69/sweep-node22.log`, `.tmp/s69/sweep-node25.log` |
| gate chain (`LOC_GATE_BASE=origin/main 2f6c0f4f57`) | loc OK (+21 LOC, **no allowance needed**), func OK, coercion-sites OK, oracle-ratchet OK, dead-exports OK, boundaries inventory `inventoryValid: true`, typecheck OK, lint OK | `.tmp/s69/{loc,func,coerce,oracle,dead,boundaries,typecheck,lint}.log` |

### The five briefed rows — before / after

Unchanged, by design: their mechanisms are the polyfill grammar and i64 BigInt,
neither of which this slice touches.

| row | base | fix |
| --- | --- | --- |
| `Duration/compare/relativeto-propertybag-invalid-offset-string.js` | fail (`"+00:0000" is not a valid offset string`) | fail — Mechanism A |
| `Duration/compare/relativeto-string-invalid.js` | fail | fail — Mechanism A |
| `PlainDateTime/from/argument-string-invalid.js` | fail (`+00:0000`) | fail — Mechanism A |
| `Duration/compare/throws-when-target-zoned-date-time-outside-valid-limits.js` | fail | fail — Mechanism B |
| `ZonedDateTime/prototype/add/overflow-adding-months-to-max-year.js` | fail (reported L12; the real failure is L15) | fail — Mechanism B |

## Residuals (measured, not fixed)

1. Three offset rows — polyfill grammar, needs a polyfill upgrade (Mechanism A).
   Reduced probe: `.tmp/s69/probes/host-truth.mjs` under plain Node.
2. Two epoch-limit rows — need >64-bit BigInt on the native-first lane
   (Mechanism B). Reduced probe: `.tmp/s69/probes/l2.js` rows `bigLit`,
   `zdtMaxEp`, `minEp`.
3. The `PlainDate.prototype.add` provider defect above — ~78 rows, unreduced.
4. The runner's `assert.throws` line attribution reports the FIRST
   `assert.throws(` in the file, not the failing one
   (`overflow-adding-months-to-max-year.js` reports L12, but L12 PASSES and
   L15 is the failure). Anyone debugging from the reported line chases the
   wrong assertion.

## Acceptance criteria

- The five rows are each attributed to a named mechanism with a reduced probe. ✅
- Any mechanism fixable at `m` horizon is fixed with a witness that fails on
  the true reverted base `ce58705b68`. ✅ (the live-global-binding object result)
- No pass→fail anywhere in the four-family battery or the nine must-not-move
  groups. ✅ (3 684 rows, 0 pass→fail, 0 fail→pass)
