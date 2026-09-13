---
id: 5406
title: "standalone: a value that crosses a `link:` boundary is not an ordinary object in the consumer — `Object.prototype.toString` refuses it (FIXED, S6). The issue's second half (a provider-thrown error's `constructor` is not the consumer's) was NOT reproducible: re-measured in S6, error identity already crosses; and the 352-row error text is the module-init failure now filed as #6432"
status: done
completed: 2026-09-12
sprint: current
priority: high
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-12
func-budget-allow:
  # 2026-09-12 (S6) — `emitObjectProtoToStringClassifier` +34. The CODE is the
  # boundary-carrier arm at the end of the chain: call the peer's
  # `__js2wasm_link_to_string_tag` terminal, return its answer when it is
  # non-null, fall through to the unchanged loud refusal when it is null —
  # about 14 lines. The remaining ~20 are the rationale, and they are
  # load-bearing in two independent ways a reader cannot re-derive from the
  # code:
  #   (a) WHY the arm is last and miss-path only. It is what keeps the
  #       single-module standalone lane byte-identical (a module with no linked
  #       provider emits nothing here) and what keeps a receiver this module can
  #       decode from paying a cross-module call.
  #   (b) WHY the `exportsConsumedByWasm` guard is not redundant with the
  #       `funcMap` lookup. A PROVIDER registers the very same terminal name in
  #       its own `funcMap` — that is how the export is published — so without
  #       the guard a provider would emit a call to ITSELF at the tail of its
  #       own classifier and recurse. The same trap is documented on
  #       `standaloneLinkBoundaryPeerIndex`; a reader who trims the note will
  #       "simplify" the guard away and the failure is an infinite recursion no
  #       byte A/B would show.
  - src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier
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

## S6 findings (2026-09-12) — (A) fixed; (B) was never broken; the lane's real blocker is elsewhere and is now reduced to six lines

Three results, in the order a reader needs them.

### 1. (B) error identity across a link ALREADY works — the problem statement read a real TypeError as a boundary defect

The table in "Problem" above came from probing
`Temporal.PlainDate.from("not-a-date")` and expecting a `RangeError`. Re-measured
through the same shipped path (`.tmp/s6-realerr-base.out`, base tree, provider
built by the same compiler), that call throws a **TypeError** whose message is
`Unsupported dynamic regular expression pattern` — a RegExp gap inside the
provider (#5408), not an identity failure. `instanceof RangeError === false` was
the right answer to the wrong question.

Asking the same questions about calls that really do throw a `RangeError`:

| probe, real provider, host-free | base | S6 |
| --- | --- | --- |
| `new Temporal.PlainDate(2024, 14, 1)` → `e instanceof RangeError` | true | true |
| …`e.constructor === RangeError` | true | true |
| …`e.name === "RangeError"` | true | true |
| …`e.message` | `value out of range: 1 <= 14 <= 12` | same |
| `Duration.from({hours:1}).total("bogus")` → `instanceof RangeError` | true | true |
| `PlainDate.from("not-a-date")` → `instanceof TypeError` | true | true |
| …`e.constructor === TypeError` | true | true |
| the harness's own shape — both sides through PARAMETERS, `thrown.constructor === expected` (`.tmp/s6-throwsparam.out`) | 1 (holds) | 1 |
| the control: a consumer `RangeError` compared against `TypeError` | 3 (differs) | 3 |

#5383 S2m's shared exception tag is what made this work; S6 adds the
parameter-passing spelling (`assert.throws`'s own) to the evidence, and asserts
all of it in `tests/issue-5406-standalone-link-boundary-tostring.test.ts` so it
cannot silently regress.

**Residual, and it is NOT a boundary defect:** `e.constructor.name` reads
`undefined`, and the bare-value spelling reads the TYPESCRIPT interface name.
Measured in a SINGLE standalone module with no link at all
(`.tmp/s6-ctorname{,2,3}-base.out`): `RangeError.name` (the #2501 static fold)
answers `"RangeError"`; `const C = RangeError; C.name` answers
**`"RangeErrorConstructor"`**; any read through an `any` answers `undefined`.
Upstream `assert.throws` compares CONSTRUCTOR IDENTITY and only formats `.name`
into the failure message, so this costs no test262 row today. Left as an
`it.todo` with the measurement rather than fixed here — it is a single-module
builtin-carrier defect, not this issue.

### 2. (A) is real, and is fixed

The consumer classifies `Object.prototype.toString` by WasmGC type test, and a
type test only sees types THIS module declared. The vec/string families are in
the canonical rec group; `$Object` and every nominal class struct are not
(`.tmp/s6-probe-a-{base,fix}.out`, `.tmp/s6-tagtext-{base,fix2}.out`):

| receiver, in the consumer | base | S6 |
| --- | --- | --- |
| the provider's class instance | throws | `[object Object]` |
| the provider's `{ a: 1 }` | throws | `[object Object]` |
| the provider's `new RangeError("x")` | throws | `[object Error]` |
| the provider's `[1, 2]` | `[object Array]` | `[object Array]` |
| the provider's `new Date(0)` | throws | throws (declined on purpose) |
| the provider's `new Map()` | throws | throws (declined on purpose) |
| the provider's `new Number(5)` | `[object Number]` | `[object Number]` |
| a CONSUMER class instance through an `any` | throws | `[object Object]` |
| a consumer `{ a: 1 }` / `[1,2]` / `null` / `undefined` | correct | unchanged |

Mechanism: the provider publishes `__js2wasm_link_to_string_tag` and the
consumer asks it only after its own chain has missed — the same miss-path shape
as `__js2wasm_link_member_get` (S2d) and `__js2wasm_link_method_call` (S2h).
**The candidate the issue sketched second — a per-intrinsic BRAND id in the
canonical ABI — was not needed for either half**: (B) needed nothing (one tag
per graph already), and for (A) "ask the owner" is strictly cheaper than
widening the frozen rec group, which would re-key every existing artifact.
Importing the consumer's intrinsics into the provider was rejected for the
reason S2m already records: the linker instantiates providers FIRST, so a
provider cannot import from its consumer.

The decline list inside the terminal is load-bearing: with only the `$Map`
decline, `toString.call(new Date(0))` answered `[object Object]` where the base
threw — a loud refusal converted into a silent mis-tag. Named residual:
`@@toStringTag` is not consulted, so a provider class that sets one (Temporal's
do) answers the §20.1.3.6 step-13 default rather than its tag.

### 3. The lane does not move, and the reason is a DIFFERENT defect — now reduced to six lines (#6432)

Re-running the S5 sample (120 rows per family, linked side only, provider and
quickjs eval adapter rebuilt with this tree):

| | PlainDate S5 → S6 | Duration S5 → S6 | ZDT/prototype S5 → S6 |
| --- | --- | --- | --- |
| pass | 0 → **0** | 0 → **0** | 0 → **0** |
| fail | 118 → 109 | 117 → 110 | 117 → 111 |
| compile_error (all compile TIMEOUTS) | 2 → 11 | 3 → 10 | 3 → 9 |
| rows reporting the one text | 118 → 109 | 117 → 110 | 117 → 111 |

**0 pass→fail** (there were no passes to lose). The compile-timeout rise is a
CONTENTION artifact, not a regression: S6 ran the three families as three
concurrent processes where S5 ran pairs, and the timeout is wall-clock. Three
flipped rows re-run SOLO (`PlainDate/basic.js`, `Duration/max.js`,
`PlainDate/from/argument-string.js`) all come back `fail`, not `compile_error`.

The top bucket is unchanged, and S6 found out why: **every linked row fails at
MODULE INIT, before its first statement.** An EMPTY row (`var s6 = 1;` with
`features: [Temporal]`) fails through the real runner with the identical text,
and the reduction is six lines — a `var obj = { evalScript: function (s) {
return eval(s); } }` in a module that links a provider. Unlinked it inits fine;
linked it throws. Identical on the base tree and this one, so #5406's fix
neither causes nor cures it. Filed as **#6432** with the full bisect.

Consequence for the record: S5's sub-bucket table (136 `assert.throws`, 124
`assert.sameValue`, …) classified rows by the `at L<n>` fragment of a failure
that never reached that line. Those counts are not a classification of Temporal
defects, and #5406's headline ("136 of 360 rows fail on this alone") does not
survive the re-measurement.

### 4. Order preservation

12 module shapes x {gc, standalone}, base captured by file copy before the first
edit (`.tmp/s6-ab-{base,fix}.out`): **24 of 24 sha256-identical.** Both new arms
are emitted only inside a linked graph — the consumer arm requires an imported
peer terminal, the provider arms require `exportsConsumedByWasm` — so a
single-module compile in either lane cannot reach them.

