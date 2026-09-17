---
id: 6501
title: "ES2015 standalone: the four TypedArray methods with a dedicated dyn-view helper bypass #5961's ValidateTypedArray guard"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
related: [1645, 5961, 6500]
---

# Four methods never reach the detached-buffer guard

#5961 gave `$__ta_dyn_view` receivers the §23.2.4.4 ValidateTypedArray
prologue and banked +9 rows. The prologue lives on the **generic
`__call_m_<name>_<arity>` dispatcher** (`closed-method-dispatch.ts`), so it
covers every method that has no dedicated helper.

**Four methods have one, and therefore never reach it.**
`call-receiver-method.ts` (~line 4090) routes them to a native helper at the
call site instead:

```ts
if (methodName === "set")                          taSetIdx  = ensureTaDynSetHelper(ctx);
else if (arity <= 3 && methodName === "fill")      taFillIdx = ensureTaDynFillHelper(ctx);
else if (arity <= 3 && methodName === "copyWithin")taFillIdx = ensureTaDynCopyWithinHelper(ctx);
else if (arity <= 3 && methodName === "reverse")   taFillIdx = ensureTaDynReverseHelper(ctx);
```

`reverse` is even listed in `TA_DYN_VALIDATE_METHOD_NAMES` already — the list
is right, the path simply never consults it.

## Measured — `--isolate`, `--target standalone`, main @ `f5506015f9`

| row | result | routes via |
| --- | --- | --- |
| `sort/detached-buffer.js` | **pass** | generic dispatcher (#5961's guard) |
| `slice/detached-buffer.js` | **pass** | generic dispatcher |
| `reverse/detached-buffer.js` | **fail** — no exception | `ensureTaDynReverseHelper` |
| `fill/detached-buffer.js` | **fail** | `ensureTaDynFillHelper` |
| `copyWithin/detached-buffer.js` | **fail** | `ensureTaDynCopyWithinHelper` |

The two that pass are the control: they prove the guard works and that the
difference is purely which path the method takes.

## Why the dynamic shape is the one that matters

test262 does not call these on a statically-typed receiver. Every row goes
through `testWithTypedArrayConstructors(function (TA, makeCtorArg) { … })`, so
`TA` is a **parameter** and `new TA(makeCtorArg(0))` produces a
`$__ta_dyn_view`. A probe written as `new Float64Array(8).fill(…)` takes the
static path and looks fine — that is why this survived #5961. **Probe with a
dynamic constructor or the measurement is meaningless.**

## `reverse` additionally needs #6500

On main, `reverse` on a **packed** receiver (`Uint8Array`, `Int8Array`,
`Uint8ClampedArray`, `Uint16Array`, `Int16Array`) fails binary emit outright —
a compile-time kill, fixed in #6500 and a prerequisite here. This issue's
branch is stacked on #6500 for that reason.

## Implementation Plan

`taDynDetachedGuardInstrs(ctx, method, anyLocalIdx, pushLocal)` in
`ta-dyn-method-call.ts` is **already reusable** — #5961 wrote it as a free
function precisely so a second call site could adopt it. It needs the receiver
in an **anyref** local; the helper call site already materialises `recvLocal`
as an **externref**, so the adaptation is `any.convert_extern` into a fresh
local, then splice the returned `Instr[]` ahead of the helper call.

Preserve the guard's existing self-imposed limits — they are deliberate and
documented in its body:

- it declines unless `ctx.standalone` and `ctx.taDynViewTypeIdx >= 0`;
- it declines when `__new_TypeError` is not already in `funcMap` (no minting,
  no `ensureLateImport`, at a seam where either would shift funcIdxs);
- it fires only on the `-1` detach marker, unreachable for a live buffer.

`set` has a different signature from the other three (`taSetIdx` vs
`taFillIdx`) but shares the `(recv, v1, v2, v3, argc)` shape at the emit block;
check whether one splice covers all four or whether `set` needs its own, and
say which.

## Acceptance

1. `reverse`, `fill`, `copyWithin` detached rows pass; `sort` and `slice` stay
   passing (they must not change at all — they do not go through this path).
2. Measured on **both** a merge-base tree and the branch, same
   `.test262-cache` symlinked into both: the full
   `built-ins/TypedArray/prototype/{reverse,fill,copyWithin,set}` directories,
   plus a `built-ins/TypedArray` control sample. **Zero rows lost** — the
   per-test edition ratchet fails the required check on a single
   pass→not-pass in ES2015, with no waiver.
3. A live (non-detached) `fill`/`copyWithin`/`reverse`/`set` on a dyn view
   still mutates correctly and returns `this` — the guard must be inert on a
   live buffer. Pin this; it is the regression the splice could cause.
4. `result.imports` stays `[]`; the gc/host lane stays byte-identical.
5. All gates exit 0, run bare.
