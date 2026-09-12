---
id: 5406
title: "standalone: a value that crosses a `link:` boundary is not an ordinary object in the consumer — `Object.prototype.toString` refuses it, and a provider-thrown error's `constructor` is not the consumer's (136 of 360 measured Temporal rows fail on this alone, and it is the reported text on 352 of them)"
status: ready
sprint: current
priority: high
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-12
---

## Problem

Measured in #5383 S5 (2026-09-12), the standalone test262 lane with the compiled
`@js-temporal/polyfill` provider linked: **352 of 360 rows** across three
non-Intl Temporal families report exactly one error text —

```
TypeError: Object.prototype.toString is not yet implemented in --target standalone
```

That text is **not** the failure. `Object.prototype.toString` appears in exactly
one place in the test262 harness (`test262/harness/assert.js`,
`formatSimpleValue`), inside the `catch` of `String(value)`:

```js
function formatSimpleValue(value) {
  var basic = formatIdentityFreeValue(value);
  if (basic) return basic;
  try { return String(value); }
  catch (err) { if (err.name === 'TypeError') return Object.prototype.toString.call(value); throw err; }
}
```

So the reported message is the **third** event in a chain: an assertion had
already failed, `String()` of the offending value then threw, and the fallback
is unimplemented. Every row's real first-failing operation is hidden behind it.

Sub-classifying the 352 by the harness call named in the row's `at L<n>:`
fragment (`.tmp/s5-subbuckets.mjs`):

| sub-bucket | PlainDate | Duration | ZonedDateTime | total |
| --- | --- | --- | --- | --- |
| `assert.throws` over a provider call | 55 | 46 | 35 | **136** |
| `assert.sameValue` on a provider value | 34 | 32 | 58 | 124 |
| no line attributed (threw during setup) | 25 | 30 | 13 | 68 |
| plain `assert()` | 0 | 0 | 9 | 9 |
| `assert.compareArray` | 4 | 2 | 1 | 7 |
| other harness line | 0 | 3 | 1 | 4 |
| `assert.notSameValue` | 0 | 4 | 0 | 4 |

### Two reductions, both measured host-free through the shipped provider path

`.tmp/s5-firstfail.mts` and `.tmp/s5-throwshape.mts` (`buildTemporalProvider` +
`compileWithTemporalGlobal`, `target: standalone`, `hostBridge: "off"`,
`instantiateLinkedProject(result, {})` — an empty import object).

**(A) A provider-minted object refuses `Object.prototype.toString`, while the
consumer's own object does not.**

| probe | result |
| --- | --- |
| `Object.prototype.toString.call(new Temporal.PlainDate(2024,1,1))` | **throws** |
| `Object.prototype.toString.call({ a: 1 })` (consumer-owned) | returns a string |
| `String(new Temporal.PlainDate(2024,1,1))` | returns a string |

So the refusal is not "the method is unimplemented" in general — it is
unimplemented *for a carrier that came across the link boundary*. The message
text is therefore also misleading to whoever reads it.

**(B) A provider-thrown error is not an instance of the consumer's error
constructor.** `assert.throws` compares
`thrown.constructor !== expectedErrorConstructor` by **identity**, so this
alone fails all 136 `assert.throws` rows no matter how correct Temporal is:

| probe (`Temporal.PlainDate.from("not-a-date")` throws) | result |
| --- | --- |
| `e instanceof Error` | true |
| `e instanceof RangeError` | **false** |
| `e.constructor === RangeError` (consumer's) | **false** |
| `e.constructor.name` | **`undefined`** |
| control: consumer's own `throw new RangeError("x")` → `e.constructor === RangeError` | true |

The harness's failure message then reads "Expected a RangeError but got a
undefined", which is exactly the shape seen in the run.

### Why this is worth its own issue

- It is the **single largest blocker** to standalone Temporal conformance: with
  it fixed, 136 rows become answerable on their merits and the other 216 become
  *readable* (their true first failing operation stops being masked).
- It is **not Temporal-specific**. It is a property of the `link:` boundary, so
  every future separately-compiled standalone provider inherits it.
- It is also what makes the S5 measurement partly unreadable — see #5383 S5.

## Implementation Plan (sketch)

1. **Reproduce without Temporal.** Build a two-module standalone link project
   whose provider exports a class and a function that throws a `RangeError`;
   assert the three probes above in the consumer. That reduction belongs in
   `tests/` and must fail before any fix. (The Temporal provider is a 3.3 MB
   compile — do not make it the regression test.)
2. **(A) `Object.prototype.toString`.** Find the standalone `Object.prototype`
   method dispatch that raises `… is not yet implemented in --target standalone`
   and give it the boundary-carrier arm the other `__extern_*` readers already
   have (cf. #5383 S2d's peer-terminal registration in
   `src/codegen/object-runtime.ts`, and S2l's array-like carrier arms). The
   answer for a provider class instance should be `"[object Object]"` unless a
   `Symbol.toStringTag` crosses.
3. **(B) Error identity.** The consumer and provider each mint their own
   `RangeError`/`TypeError` constructors, so error identity across the boundary
   is a **realm** question, not a marshalling one. Two candidate designs, and
   the choice must be measured, not assumed:
   - *Shared error realm*: the linker designates one module's intrinsic error
     constructors as canonical and the peer imports them (mirrors how the
     boxed-number carrier became one singleton `struct(f64)` in #5383 S2k).
   - *Re-wrap at the terminal*: the boundary catches a peer error and rethrows
     a consumer-realm error of the same kind. Cheaper, but loses identity for
     any error the consumer passes IN and gets back.
   Whichever is chosen, `constructor.name` must answer — `undefined` is a
   second, independent defect (the class's `name` static is not crossing).
4. **Order preservation.** Single-module standalone and `--target gc` bytes must
   be unchanged: byte A/B on ≥8 modules × both targets, as #5383 S2p did.
5. **Acceptance.** The reduction test passes; re-run #5383's S5 three-family
   sample and report the new `assert.throws` sub-bucket count.

## Notes

- Found by #5383 S5. Artifacts: `.tmp/{pd,du,zdt}-{base,link}.tsv`,
  `.tmp/s5-firstfail.out`, `.tmp/s5-throwshape.out` in the S5 worktree.
- Related: #5383 (umbrella), #2860 (standalone gap umbrella), #5383 S2d/S2k/S2l
  (the boundary work this sits on top of).

## S6 (in progress, 2026-09-12)

Opus senior-dev lane started on branch `issue-5383-standalone-temporal-s6`
(stacked on S5). Measuring (A) and (B) reductions before any `src/` change.
