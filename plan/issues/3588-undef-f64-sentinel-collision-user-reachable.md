---
id: 3588
title: "UNDEF_F64 sentinel collision is user-reachable: a DataView-crafted NaN (0x7FF00000DEADC0DE) compares `=== undefined` true in standalone"
status: ready
sprint: Backlog
created: 2026-07-25
updated: 2026-07-25
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: equality, NaN
goal: standalone-gap
related: [2106, 2142, 2979, 2773]
origin: "2026-07-25 Fable substrate/async review (plan/agent-context/fable-substrate-async-review-2026-07-24.md), probe s1"
---

# The UNDEF_F64 sentinel is observable: crafted NaN === undefined

## Problem (verified on main 7652f0337, target: standalone)

The `undefined`-through-f64-lane representation (#2106/#2142) reserves the sNaN
payload `0x7FF00000DEADC0DE` (`UNDEF_F64_BITS`, src/codegen/value-tags.ts). The
`is-undefined` predicate includes a `$BoxedNumber`-carrying-UNDEF_F64 arm
(#2979; `buildIsUndefinedExternBody`, src/codegen/any-helpers.ts:142). A user
can mint that exact bit pattern through `DataView`, and the resulting NaN then
**compares equal to `undefined`**:

```ts
export function test(): number {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x7ff00000);
  dv.setUint32(4, 0xdeadc0de);
  const x: any = dv.getFloat64(0); // a NaN, per spec
  let code = 0;
  if (typeof x === "number") code += 1; // correct ("number")
  if (x === undefined) code += 10; // WRONG — true in standalone
  if (x !== x) code += 100; // correct (NaN)
  if (x == null) code += 1000; // WRONG — true in standalone
  return code; // node/gc: 101 · standalone: 1111
}
```

`typeof` and NaN self-inequality classify it as a number, but `=== undefined`
and `== null` answer true — the value is simultaneously a number and undefined
depending on which observer asks. Silent, no trap. Not IR-related
(identical with `experimentalIR: false`).

## Severity assessment

Low likelihood in practice: reaching it requires bit-exact NaN crafting
(DataView / TypedArray punning / Number parsing cannot produce it otherwise —
wasm `f64` ops canonicalize NaNs they COMPUTE, but bit-punning is
load/store-faithful, so the crafted payload survives). But it is a proven,
spec-observable hole in the #2106 design, and test262's NaN-payload tests
(e.g. DataView/TypedArray NaN-canonicalization suites) can plausibly hit the
pattern space.

## Direction options

- (a) Accept + document as a known representation limit in #2106/#2142 design
  docs (cheapest; this issue then becomes the record).
- (b) Canonicalize NaN payloads at the DataView/TypedArray f64 READ boundary
  (`getFloat64`/element read) when the bits equal UNDEF_F64_BITS — flip one
  mantissa bit. Spec-legal (implementations may canonicalize NaNs) and closes
  the only known mint path.
- (c) Restrict the #2979 BoxedNumber arm to sites that can only receive
  compiler-minted sentinels (audit; risk of regressing #2979's motivating
  cases).

## Acceptance

Either the probe returns 101 under standalone, or the collision is explicitly
documented as accepted in #2106/#2142 with this repro attached.
