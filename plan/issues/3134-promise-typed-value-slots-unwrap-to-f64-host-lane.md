---
id: 3134
title: "Promise<T>-typed value slots unwrap to T (f64) on the JS-host lane — a real promise externref gets __unbox_number'd to NaN at the declaration"
status: done
assignee: ttraenkler/fable-senior
created: 2026-07-10
updated: 2026-07-17
completed: 2026-07-17
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
goal: async-model
parent: 2967
related: [2905, 1042, 2906]
origin: "#2967 triage (2026-07-10) — the issue's 'const p = f(); return await p; resolves to null' bug, root-caused during slice-1 work"
---

# #3134 — `Promise<T>` value slots must be externref when the initializer is a REAL host promise

## Problem (probe-verified 2026-07-10, post-#2967-slice-1 main)

```ts
export async function main(): Promise<number> {
  const p = Promise.resolve(21).then((x: number) => x * 2);
  return await p; // NaN (expected 42)
}
```

Same for `const p = f(); return await p;` where `f` is an activated async fn
(and for `const a = await p; return a;`). Direct-call operands
(`return await f();`) are correct (42). Pre-#2967 the CPS lane manifested the
same bug as `null`; the frame engine manifests it as `NaN`. **The suspension
engines are innocent.**

## Root cause

`resolveWasmType` (src/codegen/index.ts:11826-11851) unwraps `Promise<T>` → T
on the JS-host/GC lane (line 11848: `return resolveWasmType(ctx, inner, ...)`),
so a `Promise<number>`-typed local lowers to **f64**. The declaration then
coerces the initializer — a REAL host-promise externref (Promise builtin chain,
or a call to an activated async fn returning externref) — through
`__unbox_number` → **NaN** (WAT-verified: the awaited operand compiles as
`Promise_resolve(__box_number(__unbox_number(<promise>)))`). Awaiting NaN
settles immediately with NaN.

The unwrap-to-T contract only holds for the **legacy sync-fakery** population,
where calling an async fn really does return the unwrapped value. The lane now
mixes reps: sync-fakery call sites produce T, activated call sites and Promise
builtins produce a real externref promise — but the slot type is decided from
the TS type alone, so it can't tell.

This is the exact hazard the #2905 comment above the branch documents for the
wasi carrier (which already returns externref at line 11847 when
`isStandalonePromiseActive`). The host lane needs the same end-state, but a
blanket flip breaks the sync-fakery population's rep — it must be a measured
change.

## Additional probe shape (found during #2967 slice 2a, 2026-07-10)

The bug is not limited to locals — any `Promise<T>`-typed slot mangles a real
promise, including **non-async function returns and typed callback params**:

```ts
function runTest(cb: () => Promise<number>): Promise<number> {
  return cb(); // runTest's wasm return is f64 → real promise → NaN
}
export function main(): any {
  return runTest(async function (): Promise<number> { ... }); // NaN
}
```

Control-verified NaN on pristine main 32bae1f48f (pre-slice-2a, closure still
legacy) — pre-existing, engine-independent. Untyped (`any`) boundaries are
unaffected (externref end-to-end). Fix direction 1 must therefore cover
non-async RETURN types and function-type param signatures, not just locals —
which pushes toward direction 2 (always-externref + call-site assimilation)
as the honest end-state.

## Fix directions (pick one, measure on full CI)

1. **Initializer-sensitive slot typing (narrow)**: at variable-declaration
   compile, when the declared TS type is `Promise<T>` and the initializer's
   compiled ValType is externref, keep the slot externref (skip the unwrap).
   Sync-fakery initializers (compile to f64) keep f64 — byte-stable for the
   legacy population. Must cover: locals, params with defaults, class fields.
2. **Rep convergence (broad, the end-state)**: `Promise<T>` slots are ALWAYS
   externref on the host lane, and sync-fakery async call sites wrap their
   value via `Promise_resolve` assimilation when consumed as a promise. This
   converges the two reps but changes the whole legacy population — measure
   like #2967 slice 1. Natural to fold into the #2967 endgame (once the CPS
   lane is gone the sync-fakery population is the only remaining special case).

## Acceptance

- The three probe shapes above resolve to 42 on the host lane.
- Full-corpus A/B net ≥ 0 (this touches declaration typing — broad impact,
  full CI validation, never scoped-sweep only).

## Implementation (2026-07-11, fable-senior) — Direction 2 (rep convergence)

Chose direction 2 (the issue's recommended end-state) over the narrow
direction 1 because `resolveWasmType` is a PURE function of the TS type — it
cannot see the initializer, so direction 1 would need per-call-site changes at
every typing site (locals, params-with-defaults, fields, non-async returns,
AND vec element types), and direction 1 cannot reach a `Promise<T>` VEC ELEMENT
at all (no per-element initializer to inspect). Direction 2 is the single site
that fixes all of them — and it is exactly the rep the #2967 2c class-2 blocker
needs (a `Promise<T>[]` vec element now resolves to `vec<externref>`, matching
the stored promise, so the async-frame spill guess stops diverging).

**The change** (`src/codegen/index.ts`, the `sym?.name === "Promise"` branch of
`resolveWasmType`): `Promise<T>` → `externref` on EVERY lane (dropped the
`isStandalonePromiseActive` gate that made host/GC unwrap to `T`). One
externref serves BOTH reps:

- a REAL promise (Promise builtin, activated async fn result) passes through
  as externref — fixing the `__unbox_number` → NaN;
- a SYNC-FAKERY value (a legacy async call compiled synchronously returns the
  unwrapped `T` = f64) boxes at the declaration coerce (`__box_number`), then
  either `__unbox_number`s back for a later numeric use, or assimilates through
  `Promise_resolve` at `await` — both correct.

Why it's safe where it matters: an async fn's OWN wasm return signature is
pre-unwrapped via `unwrapPromiseType` (declarations/closures/class-bodies)
BEFORE this branch runs, so activated result types are unaffected. externref is
a leaf valtype — no new type registration, no DCE remap / funcIdx churn.

**Local validation:** the 5 acceptance cases (3 probe shapes + sync-fakery
parity + the class-2 vec-element rep) all resolve to 42. Async battery
(async-await / equivalence async-function / 1042-host-drive / 2957 /
2967-engine-convergence / 2906-multiawait) green; the only 2 failures are
`promise-combinators` `Promise.all/race with resolved values` — pre-existing
("undefined is not iterable", the exact documented #2967-slice-1 failure mode,
engine-independent). tsc clean.

**Risk:** broad — every `Promise<T>` value slot's rep flips f64→externref. The
merge_group full-corpus A/B is the hard gate (never scoped-sweep only).

status: in-review pending the full-CI A/B.
