---
id: 3181
title: "standalone: Number.prototype brand-check / property-surface / method .length / toExp+toPrec no-arg (residual #3175 gap)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: medium
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: number
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3175, 3171, 3174, 2896]
origin: "residual clusters split off from #3175 (PR #2933) after the +46 dominant-bucket close"
---

# #3181 — standalone Number.prototype residual clusters (from #3175)

## Problem

#3175 (PR #2933) closed the DOMINANT standalone gap under
`built-ins/Number/prototype/**` — the `Number.prototype.<m>()` receiver
`[[NumberData]]` = +0 recovery, `toString(undefined)` base-10, `toFixed`
ToIntegerOrInfinity truncation, and real `RangeError` instances — flipping
**84 → 130 of 168** standalone passes (+46). The `≥55` acceptance bar was NOT
met; ~38 files remain, in FOUR independent clusters below. Each is a separate,
harder slice than the receiver fix, which is why they were split off here rather
than forced into #3175 (which stays `in-progress`).

Measurement method: real `wrapTest` + `compile({target:"standalone"})` over every
`Number/prototype` file (same harness as #3175).

## Residual clusters

### A. Brand-check / "not generic" (~12 files) — HARDEST

- `toString/S15.7.4.2_A4_T01..T05`, `valueOf/S15.7.4.4_A2_T01..T05`,
  `toExponential/this-type-not-number-or-number-object`,
  `toPrecision/this-type-not-number-or-number-object`.
- Shape: `s.toString = Number.prototype.toString; s.toString()` where `s` is a
  `String`/other object → must throw **TypeError** ("not generic", §21.1.3).
- Needs `Number.prototype.<m>` materialized as a **first-class function VALUE**
  that brand-checks its receiver on transfer/dynamic-dispatch. Wire the shared
  brand preamble from **#3171/#3174** (`src/codegen/receiver-brand.ts` /
  `collections-brand.ts` landed on main) to the boxed-Number brand. This is the
  bulk of the remaining work.

### B. Property surface (~12 files)

- `S15.7.4_A3.1..A3.7` (`Number.prototype.hasOwnProperty("constructor"|method)`),
  `S15.7.3.1_A2_T1/T2`, `S15.7.3.1_A3`, `15.7.3.1-2`, `S15.7.4_A1`.
- Needs `Number.prototype` as a real object exposing its own-property set +
  descriptors (`hasOwnProperty`, property enumeration). Likely reuses the
  `array-object-proto.ts` `$NativeProto` machinery already used for
  `Array.prototype`/`String.prototype` — extend the `NUMBER_PROTO_METHODS`
  wiring so `Number.prototype` answers reflective own-property queries.

### C. Method `.length` (3 files)

- `toString/length` (=1), `valueOf/length` (=0), `toLocaleString/length` (=0).
- The `.name` fold ALREADY fires
  (`tryCompileStandaloneBuiltinProtoMemberMeta`, `property-access.ts`) — `.name`
  returns "toString" correctly. `.length` returns NaN because an EARLIER generic
  `.length` handler intercepts the `Number.prototype.<m>.length` shape before
  the meta fold at ~L4186. Fix = run the meta fold before the generic `.length`
  handler for this shape (dispatch-order), OR let the generic handler defer the
  builtin-proto-member shape to the fold. Small but needs care to avoid
  property-access reordering regressions. Also verify `PROTO_METHOD_LENGTH` /
  `memberLength` returns 0 for `valueOf`/`toLocaleString` (currently `?? 1`).

### D. toExponential / toPrecision no-arg + coercion (~8 files)

- `toExponential/{undefined-fractiondigits,return-values,tointeger-fractiondigits,
  return-abrupt-tointeger-fractiondigits-symbol}`,
  `toPrecision/{undefined-precision-arg,exponential,tointeger-precision,
  precision-cannot-be-coerced-to-a-number-in-range}`, plus
  `toFixed/toFixed-tonumber-throws-typeerror-{bigint,toprimitive}`.
- The standalone no-arg render is a documented **6-digit approximation**
  (`number-format-native.ts`: "shortest round-trip out of scope"), so
  `(123.456).toExponential()` → `"1.234560e+2"` not `"1.23456e+2"`, and
  `toPrecision(undefined)` should be `ToString(x)` (§21.1.3.5 step 2) but the
  fix collides with the `number_toString` ← `number_toString_radix` emit-graph
  (attempted in #3175, reverted with a CE). Untangle the emit dependency so
  `number_toString` is available to the no-arg toPrecision delegation, and
  implement a shortest-representation (or trailing-zero-trim) no-arg render.
  Symbol/BigInt args must throw **TypeError** as a real instance.

## Acceptance criteria

- Address clusters A–D (any subset is a valid partial PR — prefer C then B then
  A/D by effort). Net standalone `Number/prototype` passes strictly increase
  toward the original #3175 `≥55` bar (130 → ideally ≥139 to clear it).
- Zero host-mode regressions; zero standalone high-water regressions.
- Number family only.

## Notes

- Do NOT re-do #3175's receiver / undefined-radix / toFixed-trunc / RangeError
  work — it landed in PR #2933. Start from post-#2933 main.
- `buildThrowJsErrorInstrs` (helpers.ts, added in #3175) is the reusable
  conditional-throw helper for any new TypeError/RangeError instance gate here.

## Implementation Plan

(arch, 2026-07-12. Anchors re-verified post-#2933 by Fable review — PR #2933
has LANDED on main; `buildThrowJsErrorInstrs` lives at
`src/codegen/expressions/helpers.ts:231`. Cluster C's root cause was
re-diagnosed empirically and corrected — see the cluster.)

Ship order: **C → B → D → A** (effort-ascending; each cluster is an
independently mergeable PR-let).

### Cluster C — method `.length` (3 files, S)

**Root cause (empirically pinned, Fable review 2026-07-12 — the earlier
"dispatch-order interception" theory is WRONG; there is NO `.length` arm
between `compilePropertyAccess`'s start (:3492) and the meta fold call
(:4186), and an instrumented compile shows the fold IS reached and emits for
`.length`)**: the fold emits garbage, not the wrong handler. In `makeGlue`
(`src/codegen/array-object-proto.ts:1434`),
`memberLength: (member) => PROTO_METHOD_LENGTH[member] ?? 1` indexes the
plain-object-literal table `PROTO_METHOD_LENGTH` (:399). For
`member === "toString" | "valueOf" | "toLocaleString"` the lookup hits the
**prototype-INHERITED `Object.prototype` methods** (the table has no own
entry for them), so `?? 1` never fires and `memberLength` returns a JS
**Function**. The fold (property-access.ts:1153-1154) then pushes
`{op: "f64.const", value: <Function>}` → the emitter encodes NaN.
Instrumented proof: `FOLD EMIT length toString [Function: toString]`.
`.name` works because it goes through `compileStringLiteral`, which never
touches the table. The bug is NOT Number-specific: measured
`Array.prototype.toString.length` is also NaN on main today.

**Change** (`src/codegen/array-object-proto.ts`):
- Make the arity tables immune to prototype pollution: give
  `PROTO_METHOD_LENGTH` (:399) and `TYPED_ARRAY_PROTO_METHOD_LENGTH` (:380)
  a null prototype (`Object.assign(Object.create(null), {...})` keeping the
  `Readonly<Record<string, number>>` annotation), or equivalently switch the
  lookups to `Object.hasOwn(T, m) ? T[m] : default`. Null-prototyping the
  table fixes every consumer at once and is preferred.
- Add explicit own entries `valueOf: 0` and `toLocaleString: 0` to
  `PROTO_METHOD_LENGTH` (spec §21.1.3.4/§21.1.3.7 — and 0 is also correct
  for every other builtin family sharing this table). `toString` needs NO
  entry: after the null-proto fix the `?? 1` default yields 1, correct for
  `Number.prototype.toString` (§21.1.3.6). (Known shared-table nuance, out
  of scope for the 3 target files: Array/Object/Error `toString.length` is
  spec-0 but will report the default 1 — a per-glue override can follow.)
- Same-hazard audit (one grep, same PR): any other member-keyed
  plain-object table consulted with user-visible property names —
  `BUILTIN_STATIC_METHOD_ARITY` (builtin-fn-meta.ts:80, inner records are
  plain literals: `Number.toString.length`-shape reads hit the same
  inherited-Function path at property-access.ts:1126 and
  builtin-static-gopd.ts:302) — null-proto those inner records too.

**No dispatch-order change is needed** — do not add a deferral predicate.

**Reuse**: `tryCompileStandaloneBuiltinProtoMemberMeta`
(property-access.ts:1104, called at :4186; `memberLength` consumed at
:1153) and the `NUMBER_PROTO_METHODS` glue table
(array-object-proto.ts:208) — extend, do not add a new fold.

**Tests**: `built-ins/Number/prototype/toString/length.js`,
`valueOf/length` (0), `toLocaleString/length` (0); plus an equivalence probe
asserting `Array.prototype.toString.length` no longer NaNs (the
generalized-bug canary); scoped standalone sweep of
`built-ins/Number/prototype/**` + a host-lane byte-identity spot-check.

### Cluster B — property surface (~12 files, M)

**Root cause**: `Number.prototype` does not answer reflective own-property
queries (`hasOwnProperty("toString")`, `hasOwnProperty("constructor")`,
enumeration) — only direct method dispatch works.

**Change** (`src/codegen/array-object-proto.ts`):
- The `$NativeProto` machinery already models `Array.prototype`/
  `String.prototype` as objects — `makeGlue` at :1434, per-builtin
  registrations at :1527-1709; the Number one is
  `ensureNumberNativeProtoGlue` at :1561 (`registerNativeProtoBuiltin(ctx,
  makeGlue(ctx, brand, "Number", NUMBER_PROTO_METHODS))`). Extend the same
  reflective arms for the Number brand: `hasOwnProperty(name)` over the
  glue's member table + `"constructor"`, and
  `Number.prototype.constructor === Number` identity.
- Grep how `Array.prototype`-surface tests pass today (the glue's
  `hasOwnProperty` arm) and mirror it — the member list is
  `NUMBER_PROTO_METHODS` ∪ {`constructor`} exactly as registered
  (`toLocaleString` is already in `NUMBER_PROTO_METHODS`, :208-216).

**Reuse**: `registerNativeProtoBuiltin` / `makeGlue`
(array-object-proto.ts:1434, Number registration :1561) — one table drives
dispatch AND reflection; do not build a parallel descriptor store.

**Tests**: `S15.7.4_A3.1..A3.7`, `S15.7.3.1_A2_T1/T2`, `S15.7.3.1_A3`,
`15.7.3.1-2`, `S15.7.4_A1`.

### Cluster D — toExponential/toPrecision no-arg + arg coercion (~8 files, M)

**Root cause** (two parts): (1) the no-arg render in
`src/codegen/number-format-native.ts` is a 6-digit approximation, not the
spec shortest/`ToString(x)` form; (2) the previous attempt to delegate
`toPrecision(undefined)` → `number_toString` hit an emit-graph collision
around the helper-registration function `emitNativeNumberFormat`
(number-format-native.ts:379 — the "must run before any function bodies
that call them" block; the plan's earlier name `ensureNumberFormatHelpers`
does not exist) and was reverted with a CE.

**Change** (`src/codegen/number-format-native.ts`):
- In `emitNativeNumberFormat` (:379), the dependency edges are the
  `needRadix`/`needPrecision`/`needFixed`/`needExp` derivations (:388-405).
  NOTE (verified): `number_toPrecision` ALREADY transitively emits
  `number_toString` (`needFixed = toFixed || needPrecision` at :397, and
  toString is emitted when `needFixed`, :398) — so for the toPrecision
  delegation the topological edge exists today; re-diagnose what the #3175
  CE actually was before assuming emit ORDER (candidates: a caller invoking
  the kernel by funcMap name before `emitNativeNumberFormat` ran, or a
  `which`-set at the `declarations.ts:1400` call site missing the member).
  The one genuinely missing edge is `number_toExponential` →
  `number_toString` (`needExp` at :404 does not imply toString): add it if
  the no-arg toExponential render delegates to ToString.
- `toPrecision(undefined)` → emit `call number_toString` (§21.1.3.5 step 2).
- `toExponential()` no-arg: implement trailing-zero-trim on the 6-digit
  render (sufficient for the cited test262 rows; full shortest-round-trip
  stays documented out of scope).
- Symbol/BigInt fractionDigits/precision args → real TypeError instance via
  `buildThrowJsErrorInstrs` (from PR #2933) before ToIntegerOrInfinity.

**Reuse**: `emitNativeNumberFormat` registration block
(number-format-native.ts:379-406); `buildThrowJsErrorInstrs`
(src/codegen/expressions/helpers.ts:231, landed with #3175/PR #2933); the
existing ToIntegerOrInfinity truncation from #3175.

**Tests**: `toExponential/{undefined-fractiondigits,return-values,
tointeger-fractiondigits,return-abrupt-tointeger-fractiondigits-symbol}`,
`toPrecision/{undefined-precision-arg,exponential,tointeger-precision,
precision-cannot-be-coerced-to-a-number-in-range}`,
`toFixed/toFixed-tonumber-throws-typeerror-{bigint,toprimitive}`.

### Cluster A — brand check on transferred method values (~12 files, L)

**Root cause**: `s.toString = Number.prototype.toString; s.toString()` — the
method must exist as a first-class function VALUE that brand-checks its
receiver at CALL time (§21.1.3 "not generic" TypeError). Today the method
only exists as compile-time dispatch; a transferred reference either CEs or
runs without the brand gate.

**Change** (corrected pointers, Fable review 2026-07-12 — the value-mint
machinery is NOT in array-object-proto.ts; it already exists end-to-end):
1. `Number.prototype.<m>` VALUE reads already materialize as closures today:
   `tryCompileStandaloneBuiltinProtoMemberRead` (property-access.ts:1162) →
   `resolveStandaloneProtoMemberValueClosure`
   (src/codegen/native-proto-value-read.ts:52) →
   `ensureStandaloneNativeMethodClosure(..., {refusalBodyFallback: true})`.
   What the Number glue lacks is a REAL wrapper body: `makeGlue`'s
   `emitMemberBody` (array-object-proto.ts:1456-1462) routes Number to
   `emitProtoMemberBodyRefusal` (:659) — every transferred Number method
   currently throws TypeError for ALL receivers, valid numbers included.
   The work = add an `emitNumberProtoMemberBody` arm to that ternary,
   following the `emitStringProtoMemberBody` receiver-unbox pattern
   (:771-1116 — it shows exactly how a wrapper body recovers a boxed
   primitive receiver).
2. Inside `emitNumberProtoMemberBody`, FIRST emit the receiver brand gate:
   `emitReceiverBrandCheck` (src/codegen/receiver-brand.ts:58) /
   `emitReceiverBrandThrow` (:146) against the boxed-Number brand — note
   the gate's primitive-scalar arm throws unconditionally for a raw f64
   receiver (receiver-brand.ts ~:75-81), so the raw-f64-accept path must be
   handled BEFORE/around the gate, mirroring how #3175's direct-dispatch
   receiver `[[NumberData]]` recovery (PR #2933) accepts it. TypeError on
   mismatch as a real instance via `buildThrowJsErrorInstrs`
   (src/codegen/expressions/helpers.ts:231). Then delegate to the existing
   number-format kernels (number-format-native.ts) with the recovered f64.
3. Dynamic dispatch of the transferred value goes through the existing
   closure/`__apply_closure` bridge — no new calling convention.

**Reuse**: `emitReceiverBrandCheck`/`emitReceiverBrandThrow`
(receiver-brand.ts:58/:146 — the #3171/#3174 shared gate, landed);
`NUMBER_PROTO_METHODS` glue + `emitMemberBody` hook (array-object-proto.ts
:1456); `resolveStandaloneProtoMemberValueClosure`
(native-proto-value-read.ts:52); the `number_*` kernels
(number-format-native.ts). Do NOT hand-roll a per-method brand test.

**Edge cases**: receiver is a raw f64 (accept); receiver is a `$BoxedNumber`
(accept, unwrap `[[NumberData]]`); `String` object / plain object / null →
TypeError; `call`/`apply` transfer shapes.

**Tests**: `toString/S15.7.4.2_A4_T01..T05`, `valueOf/S15.7.4.4_A2_T01..T05`,
`toExponential/this-type-not-number-or-number-object`,
`toPrecision/this-type-not-number-or-number-object`.

### Global acceptance gates (all clusters)

- Zero host-mode regressions (host lane byte-identity for modules without
  the construct — every new arm `ctx.standalone`-gated).
- Standalone `built-ins/Number/prototype/**` sweep strictly increases from
  the post-#2933 130/168 baseline toward ≥139.
- Coordinate with PR #2933 (in-flight): branch AFTER it lands; its issue
  file (#3175) stays untouched by this work.
