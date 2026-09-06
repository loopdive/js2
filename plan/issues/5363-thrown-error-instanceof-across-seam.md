---
id: 5363
title: "`assert.throws(RangeError, …)` fails on errors thrown through the linked Temporal provider — `instanceof` on a THROWN error across the seam (22 of 123 rows)"
status: done
completed: 2026-09-06
sprint: current
priority: high
horizon: m
goal: error-model
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
---

# #5363 — thrown-error identity across the linked seam

## Problem

Measured by dev-5208 (PR #5666) on the 123-row #5249 Temporal calendar list,
provider linked, after #5208 unblocked the calendar path: **22 rows** fail on
"cross-seam `instanceof` on thrown errors" — the test262 harness's
`assert.throws(RangeError, fn)` runs `e instanceof RangeError` on an error the
polyfill threw INSIDE the provider, and it answers false.

This is adjacent to, but not the same as, #5226 (PR #5369) and #5247
(PR #5651):
- #5226 made a provider throw reach the CONSUMER's compiled `catch` by identity
  (shared host-owned `__exn` tag);
- #5247 made an uncaught compiled throw reach the HOST as the real `Error`
  (export-boundary wrapper) — and deliberately EXCLUDED linked-provider
  exports from wrapping so #5226's route survives.
The gap is the composition: the harness (host) calls a CONSUMER export, the
consumer calls into the PROVIDER, the provider throws, nothing catches it in
wasm, and what reaches the host `catch` is not a `RangeError` instance — or is
a `RangeError` from a different realm/constructor identity than the harness's
`RangeError` (test262 compares against the global of the realm it runs in).

## Implementation Plan (Fable, 2026-09-06)

1. **Probe, both routes, before touching anything**: (a) consumer export →
   provider function that throws `new RangeError("x")`, uncaught, host `catch`:
   report `Object.prototype.toString.call(e)`, `e instanceof RangeError`,
   `e.constructor === RangeError`, `e.name`; (b) the same with the provider's
   throw caught and re-thrown by the consumer; (c) control: single-module
   export throwing the same. Also check whether the `RangeError` constructor
   the POLYFILL sees (`globalThis.RangeError` inside the provider module) is
   the host's — if the provider mints errors through a compiled `Error`
   subclass or a per-module intrinsic, `instanceof` against the host global
   is false by construction.
2. Likely roots, in order: (i) the #5247 wrapper is skipped for the CONSUMER
   export when the throw ORIGINATES in the provider (the wrapper catches
   `$__exn` — the shared tag in a linked graph — so this should work; verify
   the consumer export is actually wrapped in the linked build); (ii) the
   payload is a compiled-object error (the polyfill constructs errors via
   `new RangeError(...)` → if `RangeError` is bridged as a compiled class
   value, the instance is a struct marshalled to a proxy, not a host Error);
   (iii) realm mismatch — the harness's `RangeError` vs the import object's.
3. Fix at the identified layer; do NOT re-wrap provider exports (would undo
   #5226). Base-failing test in the linked lane, control green single-module.
4. Measure `family-123.txt` provider-linked stacked on the #5208 PR
   (`issue-5208-compiled-date-host-bridge`) + #5661; report the 22 and the
   next layer.

## Acceptance criteria

1. Probe evidence for (a)/(b)/(c); the layer named with file:line.
2. `assert.throws(RangeError, …)` passes for a provider-originated throw;
   #5226 and #5247 suites stay green; equivalence at baseline.
3. 123-row re-measurement with counts.

## Notes

- Filed from dev-5208's next-layer table (PR #5666), 2026-09-06.
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.

## Implementation notes (dev-5363, 2026-09-06)

Branch `issue-5363-thrown-error-seam`, stacked on
`issue-5208-compiled-date-host-bridge` + `issue-5354-linked-class-instanceof` +
`docs-5360` + `origin/main`. **Land order: after PR #5666 and PR #5661.**

### Verdict: the reported defect does not exist. The 22 rows were mis-attributed.

Every route the issue names already answers correctly on this stacked base.
Nothing is fixed here because nothing was broken; what lands is the regression
test that pins the composition, the re-attribution, and a NEW defect the
measurement uncovered (§4, unfixed, with a bound).

### 1. Probes (a)/(b)/(c) — `.tmp/probe-seam.mts`

A linked npm provider (`linkPlan.mode = "separate"`) against the identical
two-file program compiled as ONE module. The descriptor reads `typeof`,
`e.constructor === RangeError`, `e instanceof RangeError`, `e instanceof Error`,
`e.name`, `e.constructor.name`, `e.message`.

| route | LINKED | CONTROL |
| --- | --- | --- |
| (a) host catch; provider throws, uncaught through the consumer export | `ctorIsRE=true instRE=true [object Error] n=RangeError m=range-x` | identical |
| (b) host catch; consumer catches and re-throws | identical to (a) | identical |
| (c) host catch; single-module export throwing the same | identical to (a) | identical |
| compiled catch of the provider throw | `ctorIsRE=true instRE=true cn=RangeError` | identical |
| `typeof RangeError` inside the PROVIDER | `function`, name `RangeError` | identical |
| provider catching its OWN throw: `e.constructor === RangeError` | `same` | identical |

So the polyfill's `new RangeError(...)` IS the host's `RangeError` — not a
compiled class, not a mirror, not another realm — and the #5247 export wrapper
does fire for the consumer in the linked build (`exportsConsumedByWasm` is false
for the consumer, true only for the provider). Roots (i), (ii) and (iii) from
the plan are all ruled out.

The same holds through the REAL linked `@js-temporal/polyfill` provider
(`.tmp/probe-temporal-5363.mts`), running test262 `harness/assert.js`'s actual
decision procedure — which is **not** `instanceof`, it is
`thrown.constructor !== expectedErrorConstructor`:

    Temporal.PlainDate.from("not-a-date")     assert.throws predicate  PASS
    new Temporal.PlainDate(2020, 13, 40)      ctorIsRE=true instRE=true n=RangeError
    ....until(…, {largestUnit:"bogus"})       ctorIsRE=true instRE=true n=RangeError
    Temporal.Duration.from({days: Infinity})  ctorIsRE=true instRE=true n=RangeError
    Temporal.PlainDate.from(5)                instTE=true n=TypeError
    uncaught → host                           [object Error] n=RangeError

### 2. What the 22 rows actually are

They are **not** `assert.throws`. The reason strings read
`Test262Error: <description>: instanceof`, which is the message
`TemporalHelpers.assertPlainDate` / `assertDuration` / `assertPlainDateTime`
hand to a plain `assert`:

```js
// test262/harness/temporalHelpers.js:231
assert(date instanceof Temporal.PlainDate, `${prefix}instanceof`);
```

That is `instanceof` on a value the provider **RETURNED** — #5354's family — not
on a thrown one. No row in the bucket involves an error object.

### 3. `family-123.txt`, provider linked, measured on this base

Driver `.tmp/bucket-run.mts`, `JS2WASM_TEST262_TEMPORAL=1` with a FRESH
`JS2WASM_TEMPORAL_CACHE=.tmp/tcache-base` (cold build, `cacheHit=false`), all
123 rows. **13 pass / 110 fail** — up from the 4 pass dev-5354 measured before
#5208 landed.

| failure bucket | rows |
| --- | ---: |
| `assert*: …: instanceof` | 23 |
| `RangeError: infinity is out of range` | 22 |
| `Test262Error: eraName must be string or undefined …` | 21 |
| `RangeError: Era am/aa (ISO year N) was not matched by any era` | 21 |
| `Test262Error: Unsupported era name: gregory / japanese / roc-inverse / …` | 10 |
| `RangeError: Invalid monthCode: M13` | 5 |
| `RangeError: Invalid ISO date` | 1 |
| other | 7 |
| **pass** | **13** |

The `Unsupported era name` and `eraName must be string` buckets are a POLYFILL
VERSION gap, not ours: `TemporalHelpers.CalendarEras.gregory` is
`[{era:"bce"},{era:"ce"}]` per the intl-era-monthcode proposal, while the pinned
`@js-temporal/polyfill` still reports `era: "gregory"`.

### 4. Reported, NOT fixed — the real finding, with a bound

**A process that instantiates MORE THAN ONE linked project against the same
provider binary cross-contaminates class identity. A later project resolves its
own instances through an EARLIER project's exports, so `x instanceof C` is false
against the live `C` while `x.constructor.name` still reads right.**

Measured, deterministic:

- `.tmp/probe-solo-5363.mts` — the program
  `var x = d.add({days:1}); if (x.day !== 1) { x = x.add({days:1}); }` run ALONE
  in a fresh process: `inst=true protoIs=true ctorIs=true`.
- `.tmp/probe-bisect-5363.mts` — the byte-identical program run after ten other
  linked programs in the SAME process: `inst=false protoIs=false ctorIs=false`,
  `cn=PlainDate`. Internally consistent (`ctor.prototype === getPrototypeOf(x)`)
  — two complete, unrelated `PlainDate` mirrors, not a broken one.
- Conformance-level:
  `intl402/Temporal/PlainDate/prototype/add/month-boundary-gregory.js` fails
  `endYesterdayNextDay: instanceof` inside the 123-row batch and, run ALONE with
  the same driver and cache, fails instead on `Unsupported era name: gregory` —
  the next, not-ours layer. The `instanceof` failure IS the contamination.

Mechanism, instrumented (temporary logging in `_hostConstructorForInstance`): a
program-2 instance struct resolved its `classObj` through **registry index 0**,
program 1's provider exports. `src/runtime/cross-module-struct-owners.ts` keeps
a PROCESS-GLOBAL `modules` Set that is never unregistered, and two instances of
the same provider binary have identical canonical WasmGC types, so instance A's
`__struct_field_names` names instance B's struct. `__class_object_of` then
answers the stale instance's class-object singleton.

**Consequence for every 123-row measurement quoted so far** — dev-5208's 22,
dev-5354's 13, the 23 above: the `: instanceof` bucket is INFLATED by cross-row
poisoning and is not a per-row compiler result.

**Two fixes were tried here and both REVERTED, unmerged** — recorded so the next
lane does not repeat them:

1. *Project-scoped registry* (tag each module with the instantiation's root
   import object; exclude peers of other projects). Regressed the #5225
   consumer→provider route: `d.add({days:1})` became
   `TypeError: invalid duration-like` from the second program on — the provider
   could no longer decode a consumer-minted object literal.
2. *Newest-registered-first tie-break* in `decoderFor`, with `local` competing on
   the same terms rather than winning by default. No effect on the symptom,
   which localises the remaining staleness OUTSIDE `decoderFor`: stale exports
   also arrive directly as a `callbackState.getExports()` from an import closure
   (traced through the Map/Set method bridge, `src/runtime.ts` ~L11361).

So the residual is systemic — the runtime assumes ONE live linked project per
process — and is out of scope for an error-model issue. It needs its own issue
against #5225 / #5222 / #5354. A cheaper interim worth measuring first: give the
host a way to RESET the cross-module registry between projects and have
`tests/test262-runner.ts` call it per row, which de-contaminates every future
Temporal measurement even before the underlying sharing is fixed.

Not reproducible with a small class provider (`.tmp/probe-twoproject.mts`, three
back-to-back linked projects, all correct) — it needs the polyfill's surface, so
the repro of record is the Temporal one above.

### 5. Validation

- `tests/issue-5363-thrown-error-seam.test.ts` — new. Pins test262
  `assert.throws`'s ACTUAL predicate (`typeof thrown === "object"`, then
  `thrown.constructor === RangeError`) for a provider-originated throw, in
  COMPILED code and in the HOST, on both lanes, plus two negative controls
  (wrong constructor, bare-string throw). It locks a property no existing suite
  covers: #5226 pins `instanceof` in a compiled catch, #5247 pins the host-side
  shape, neither pins `.constructor` — the door a conformance row actually uses.
- Suites and gates: see the PR body.
