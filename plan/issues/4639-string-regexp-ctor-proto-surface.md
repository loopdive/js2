---
id: 4639
title: "ES5 standalone: String/RegExp constructor+prototype surface — new String(obj) ToPrimitive, proto.constructor as ctor, RegExp flags as proto accessors, builtin static expando CE (~37 rows)"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: string-regexp
goal: standalone-gap
related: [4465, 4481, 4619, 4621, 4426]
origin: "2026-08-23 wave-3 residual map (196 true failures). Lane C (.tmp/lane-C-stringregexp.txt)."
---

# #4639 — String/RegExp ctor+proto surface

## Problem (measured 2026-08-23 on branch tree)

- **C1 — `new String(obj)` / `String(obj)` ToPrimitive with OVERRIDDEN
  toString/valueOf (~7)**: `new String({toString(){return "tostr"}})`
  renders "[object Object]" — the ctor path doesn't run the user
  override; includes a FUNCTION argument (`new String(function(){})` must
  stringify via its toString) and `String(new Array(...))` with a
  REPLACED `Array.prototype.toString`. The wrapper-ctor ToPrimitive must
  route through the same reflective machinery #4465/#4619 built for
  method receivers.
- **C2 — builtin static EXPANDO properties CE (~5)**:
  `String.indicator = 1; String.indicator` → Codegen error "built-in
  static property value read is not supported" (also RegExp.indicator,
  Array.myproperty, Math.NaN read). The #4485/#4621-C carrier serves
  KNOWN own props; an arbitrary WRITE+READ on a builtin constructor
  carrier needs the carrier's expando store (it is a `$Object` — route
  the static-property read/write through it instead of the compile-time
  whitelist; CE→runtime is the win even where the row needs more).
- **C3 — `<Builtin>.prototype.constructor` as a CONSTRUCTOR (~4)**:
  `new String.prototype.constructor("...")` → "is not a constructor"
  (also Object.prototype.constructor, RegExp S15.10.6.1_A1_T2). The
  #4442 `%Function%`-emitter family: the `.constructor` VALUE read works;
  its [[Construct]] arm is the gap.
- **C4 — RegExp instance flags as PROTOTYPE ACCESSORS (~4)**:
  `__re.hasOwnProperty('global'/'multiline'/...)` must be FALSE (current
  test262 tests ES2015+ semantics: flags are get accessors on
  RegExp.prototype, not own data props). Move the flag surface to proto
  accessors while keeping reads working — check the #4481 identity
  singleton pattern for where proto accessors live.
- **C5 — dynamic-pattern refusals (3)**: "Unsupported dynamic regular
  expression pattern" for runtime-BUILT pattern strings
  (S15.10.2.8_A3_T15/T16, annexB control-escape-russian-letter). Read
  the #4439 deferred-refusal design — the refusal fires at compile time
  for patterns the static engine can't take; route through the dynamic
  RegExp path (provider-minted) instead of refusing, where the eval tier
  is available; decline with owner where it is genuinely
  engine-capability-walled.
- **C6 — replace/split residual (~6)**: `S15.5.4.11_A1_T9` (function
  replacer `undefined`-return renders — #4518 residual 1's JS-lane arg
  pad), `split` with a RegExp instance receiver on a Number
  (argument-is-regexp rows), 2 compile_errors "replace(...) with a
  RegExp or symbol-protocol search value" in a shape #4426 hasn't
  claimed. Per-row triage; the CE rows first.
- **C7 — regexp-literal 65k-eval rows (7: S7.8.5_A*_T2 + annexB
  leading/trailing escapes)**: measured by #4621 as runtime-eval
  THROUGHPUT-walled (>30x over budget with .source reads removed). DO
  NOT re-attempt; verify the wall still holds with one row, then keep
  the decline with the runtime-eval-throughput owner.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   live; C6's compile_errors and C2's CEs first (crash/CE class).
2. C1: find the wrapper-ctor argument coercion (new-builtin-globals.ts /
   the String ctor arm) and route object args through the reflective
   ToPrimitive (#4465's object-arg machinery — same splice discipline as
   #4518's null arm).
3. C2: locate the "built-in static property value read is not supported"
   refusal site; when the builtin has a #4485-family carrier, compile
   static expando reads/writes as ordinary carrier member ops.
4. C3: give the `%Function%`/constructor-value a [[Construct]] arm —
   read #4442's emitter + #4623's routing precedent.
5. C4: proto-accessor surface for RegExp flags; own-props emptied;
   `lastIndex` STAYS an own data property (spec).
6. Verify: scoped sweeps built-ins/String{,/prototype} +
   built-ins/RegExp{,/prototype} + literals/regexp before/after (own
   runs); pins 4465/4481/4619/4621/4426 suites green; pins
   tests/issue-4639.test.ts; zero regressions.
