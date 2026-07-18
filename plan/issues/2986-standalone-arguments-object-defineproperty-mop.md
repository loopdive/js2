---
id: 2986
title: "Standalone defineProperty on mapped arguments object (~82, #2667 lineage)"
status: blocked
sprint: Backlog
priority: medium
horizon: l
feasibility: hard
model: fable
area: codegen, runtime
goal: standalone-mode
related: [2965, 2667, 2992]
depends_on: [2992]
origin: "#2965 descriptor-cluster triage — follow-up class 3 (arguments-object receivers)"
---

# #2986 — standalone defineProperty on mapped arguments object

## Problem

Follow-up from #2965. ~82 tests do `defineProperty` on a (mapped) `arguments`
object and fail on the standalone lane. The arguments-object receiver has no
own-property MOP on standalone, so the define is dropped or throws opaquely.
Continues the #2667 arguments lineage.

## Scope / mechanism

- `Object.defineProperty(arguments, k, desc)` with data and accessor
  descriptors.
- Mapped-arguments semantics: for a mapped index, redefining as a data
  descriptor with `configurable:false` / accessor breaks the parameter map per
  spec (10.4.4 `[[DefineOwnProperty]]`).

## Sizing pass (2026-07-02, dev-opus-40) — BLOCKED-ON #2992; no bounded slice

An honest sizing pass was run **before** committing to implementation (the
recurring mis-sized-M pattern of #2857/#2959/#2984/#2985). Verdict: **this is
substrate-scale own-property-MOP work, not an M slice, and it has no
independently-shippable flip-positive slice.** It is the arguments projection of
**#2992 slice 2 ("array/arguments own-property MOP")** and should be done as
part of #2992, not on its own branch.

### Measured evidence (standalone lane, in-process `compile({target:"standalone"})`)

Every one of the ~82 failing tests is a test262 **destructive
`verifyProperty` / `verifyEqualTo`** check (harness `propertyHelper.js`), which
reads the descriptor via `Object.getOwnPropertyDescriptor`, mutates
(delete → redefine), then restores. So all of them need a working **gOPD +
defineProperty + attribute-fidelity + destructive-survival** MOP on the
receiver. Probes:

| probe (standalone)                                              | result |
| -------------------------------------------------------------- | ------ |
| `gOPD(plainObj, "k").value`                                    | **works** — plain dynamic objects HAVE the descriptor MOP |
| `gOPD(array, "0").value`                                       | **FAILS** — vec-backed array index has no descriptor MOP |
| `gOPD(arguments, "0")`                                         | **returns `undefined`** even for a genuine existing index |
| `defineProperty(arguments,"0",{value:10,…})` then read `[0]`  | **FAILS** — define does not persist into the vec-backed object |
| `defineProperty(arguments,"newKey",{…})` then read `.newKey`  | **FAILS** — new data property does not attach |
| `arguments[0] = v` then read `[0]`                            | works (plain element write path is fine) |

Root cause: the `arguments` (and `array`) receiver is **WasmGC-vec-backed** and
carries **no sidecar own-property descriptor table** on standalone. `gOPD`
therefore answers `undefined`, and `Object.defineProperty` on such a receiver
does not route to a descriptor store. **Plain dynamic `$Object` receivers DO
have the MOP** (their gOPD works) — the gap is specifically the vec-backed
exotic receivers (arrays + arguments), which is exactly what #2992 slice 2
names.

The #2667 machinery (compile-time `fctx.mappedArgsInfo`
+ `emitMappedArgValueDefine`) handles only the **statically-resolvable inline**
mapped-index value-define; it does not give the object a **runtime-queryable**
descriptor table, so `verifyProperty`'s runtime gOPD read still misses. There
is thus **no inline-only slice** that flips any of the ~82 tests — they all
require the runtime vec-receiver descriptor MOP.

### Recommendation

- **Fold #2986 into #2992** as the arguments half of slice 2 ("array/arguments
  own-prop MOP") — arrays and arguments share the vec representation and the
  identical missing MOP; splitting them buys nothing and risks two half-builds.
- Do the work under #2992's slicing plan (delete-tombstone survival → vec index
  + `length` own-prop MOP → accessor-attribute fidelity), not on a standalone
  #2986 branch.
- `status: blocked`, `depends_on: [2992]` set accordingly. Reopen/ready only if
  a genuinely arguments-specific bounded win is later identified that #2992's
  array MOP does not already cover.

## Acceptance (unchanged — inherited by #2992 slice 2)

- Measured flip count on the arguments-object defineProperty standalone subset
  with zero regressions on a passing-test sweep; gc/host byte-inert.
