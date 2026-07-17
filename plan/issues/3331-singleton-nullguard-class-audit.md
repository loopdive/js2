---
id: 3331
title: "AUDIT: #2106 $undefined-singleton null-guard bug class — systematic sweep + Map get-miss fix (4th instance)"
horizon: m
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-gamma
created: 2026-07-17
updated: 2026-07-17
priority: high
feasibility: medium
task_type: bug
area: runtime
goal: spec-completeness
sprint: current
related: [2106, 3316, 3319, 3328, 2606, 3008]
loc-budget-allow:
  - src/codegen/map-runtime.ts
  - src/codegen/closed-method-dispatch.ts
---

# #3331 — the #2106 singleton null-guard bug class: audit + Map fix

## The class

The #2106 `$undefined`-singleton flip (default-ON for standalone/nativeStrings
since `6f7f93c856`, Jul 4) changed the MISS/absence value of runtime lookups
from `ref.null` to the NON-NULL tag-1 `$AnyValue` singleton. Every guard that
still encodes "absent ⇔ ref.is_null" (consumer direction), and every producer
that still emits `ref.null` where JS observes `undefined` (producer direction),
silently breaks. Instances found one at a time before this audit:

1. **#3316/#3307** — gOPD accessor halves (producer: null half must surface
   as the singleton).
2. **#3319** — gOPD miss + descriptor undefined-slots (producer).
3. **#3328** — JSON.stringify toJSON miss-guard (consumer: `ref.is_null`
   read the singleton miss as a callable toJSON → every object → "null").
4. **THIS PR** — `Map`/`WeakMap` `.get(missingKey)` returned null ⇒
   `=== undefined` false (typed, any-receiver, and WeakMap lanes); an
   `undefined` LITERAL element stored as null read back as `null`;
   dispatch-lane `clear()` returned null-extern.

## Sweep method (reproducible)

1. **Static scan** (`.tmp` scanners, this PR's methodology): all
   `{op:"call"}` emissions of singleton-miss producers (`__extern_get`,
   `__extern_get_idx`, `__getOwnPropertyDescriptor`, `__extern_method_call`,
   `__call_fn_method_*`, `__apply_closure`, replacer/toJSON drivers) followed
   by a `ref.is_null` guard within 25 lines → 20 candidate sites.
2. **A/B battery** (`tests/issue-3331.test.ts` mirrors it): 18 miss-path
   behavior patterns compiled+run under `JS2WASM_UNDEF_SINGLETON=0` vs `1`.
   Regime-DIVERGENT ⇒ the class; fails-both ⇒ pre-existing (out of class).

## Classification table (static candidates)

| Site                                                              | Class    | Verdict                                                                    |
| ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| dyn-read.ts `__dyn_get`/`__dyn_has`                               | consumer | GATED (explicit S1 arms)                                                   |
| string-raw.ts step-4/5 nullish guards                             | consumer | GATED (`__nullish_to_null` norm)                                           |
| array-to-primitive.ts join element                                | consumer | GATED (`__extern_is_nullish`, availability-keyed)                          |
| object-runtime.ts ToPrimitive method lookup (2687)                | consumer | GATED (`__nullish_to_null`)                                                |
| object-runtime.ts groupBy presence (4060)                         | consumer | GATED (`__nullish_to_null`)                                                |
| object-runtime-proxy.ts trap reads (926-942)                      | consumer | GATED (`__nullish_to_null`)                                                |
| object-runtime-descriptors.ts gOPD halves (2198)                  | producer | FIXED by #3316/#3319                                                       |
| json-codec-native.ts toJSON guard (783)                           | consumer | FIXED by #3328                                                             |
| json-codec-native.ts root-replacer result (1085)                  | consumer | OK (verified: replacer-root-undefined → undefined, both regimes)           |
| json-codec-native.ts reviver delete (3056)                        | consumer | pre-existing bug, BOTH regimes (see below)                                 |
| map-runtime.ts `__map_get` miss (706)                             | producer | **FIXED HERE** (singleton miss, regime-gated)                              |
| map-runtime.ts groupBy internal miss test (1302)                  | consumer | **FIXED HERE** (`ref.test $AnyValue` ⇔ miss)                               |
| map-runtime.ts `compileCollectionElementArg` undefined literal    | producer | **FIXED HERE** (stores the singleton)                                      |
| closed-method-dispatch.ts collection `clear` (void)               | producer | **FIXED HERE** (singleton return)                                          |
| closed-method-dispatch.ts collection `get` boundary               | —        | no change needed (miss now honest at producer)                             |
| destructuring-params.ts (693) / disposable-runtime.ts (921, 1197) | consumer | GATED (S1 arms present — spot-checked via battery destrDefault/spreadCopy) |

## A/B battery results (post-fix)

**Regime-divergent: NONE** (was 1: mapGetMiss). All Map probes pass both
regimes: typed/any/WeakMap get-miss, stored-null (`get → null`), stored
undefined-literal (`get → undefined`, `has → true`), Set has-miss,
getOrInsert, clear-returns-undefined.

## Out-of-class findings (pre-existing, fail BOTH regimes — for PO triage)

- `o.zz()` on a missing method: no TypeError (returns 0 instead of throwing)
- `{valueOf: () => 7} + 1`: ordinary ToPrimitive on typed object literal broken
- `[1, undefined, 3].join(",")`: hole/undefined rendering wrong
- JSON replacer key-drop (`{a:1,b:2}` → drop "a"): null-pointer trap
- JSON reviver returning undefined does NOT delete the key (§25.5.1.1)
- JSON replacer on array element → trap (should render "null")
- `Map.groupBy` static call shape: compile refusal (`__get_builtin`)

## Guard-authoring rule (retire the class)

Any new **absence guard** on a value that can carry `undefined` MUST use one
of the canonical primitives — `__extern_is_nullish` / `__nullish_to_null`
(externref plane), `ref.test $AnyValue` exclusion (anyref plane, when the
slot can never hold a legitimate box), or `emitIsUndefinedSingletonExternAt`
— never a bare `ref.is_null`. Any new **producer** whose JS-visible miss is
`undefined` materializes via `undefinedExternInstrs(ctx)` /
`global.get ctx.undefinedGlobalIdx`, regime-gated.
