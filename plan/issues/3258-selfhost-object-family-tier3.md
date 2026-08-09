---
id: 3258
title: "Self-host stdlib: convert object-runtime.ts hand-emitted Instr[] to TS (Tier-3)"
status: done
assignee: ttraenkler/symphony-3258-object-runtime-tier3
completed: 2026-07-20
sprint: 73
priority: medium
horizon: xl
feasibility: hard
model: fable
task_type: refactor
area: codegen, stdlib, ir
language_feature: compiler-internals
goal: ir-full-coverage
created: 2026-07-14
updated: 2026-07-21
depends_on: [3257]
related: [3141, 3256, 3257]
origin: "sprint-71 bloat audit — object-runtime.ts = 11.6k LOC / 3,738 hand-emitted Instr[] sites (largest single lever)"
---

# #3258 — Self-host the `object-runtime.ts` family (Tier-3)

## Problem

`src/codegen/object-runtime.ts` (11.6k LOC, **3,738** hand-emitted `Instr[]`
sites) is the single largest self-host bloat lever — but also the hardest
(object/any element-kinds, dynamic shapes). Depends on Tier-1 (#3256) + Tier-2
(#3257) landing first.

## Scope (Tier-3, per plan/self-hosting-scale-up.md)

Only THEN wire the full deferred-registry machinery (Object/Closure/RefCell/
Class resolvers via integration.ts's `makeResolver`) into the driver resolver.
Convert the object-runtime helpers whose ABI is fixed; the dynamic-shape /
any-receiver ones may stay hand-emitted if the dialect can't cover their
elem-kinds (per `reference_selfhost_netnegative_needs_full_elemkind_dialect` —
self-host nets negative ONLY if the TS dialect covers ALL elem-kinds).

## Acceptance

- Tier-3 object/class resolver support lands; the fixed-ABI object-runtime helpers
  self-hosted (hand `Instr[]` deleted), net −LOC.
- A/B equivalence + containment SHA; both pure-Wasm lanes zero host imports.
- Written verdict on which object-runtime helpers are NOT self-hostable yet
  (dialect-gap) + what dialect work would unblock them.

## Measurement (the profiler is this issue's progress meter)

Use the god-file profiler from #3259 as the acceptance instrument:

- **Before/after:** `pnpm run profile:godfiles` — `object-runtime.ts` is the
  largest single lever; `ensureObjectRuntime` (baseline 7,355 LOC, d≈0.39,
  `hand-emitted-runtime`) is 42% of the file, plus `ensureProxyRuntime`
  (1,338 LOC, d≈0.32) and the `fill*`/`buildOrdered*` groups. Record the
  per-group LOC delta here and in `plan/self-hosting-scale-up.md`.
- **Landing proof:** after each helper-group conversion,
  `node scripts/profile-godfiles.mjs --update` and commit
  `scripts/godfile-profile-baseline.json` so `pnpm run check:godfiles` ratchets
  down (fails on regrowth). Helpers left hand-emitted for a dialect-gap stay in
  the baseline — the written verdict names them.
- Shape context: `plan/log/3259-bloat-quickwins-report.md`.

## Non-goals

- Big-bang: convert leaf-first, one helper group per PR, measure each.

## Result (2026-07-20) — CLOSED AT DIALECT-GAP VERDICT

The required bounded, leaf-first recon found **no remaining helper group in
`src/codegen/object-runtime.ts` that is both net-negative and expressible by the
current TS-source dialect**. No runtime body was converted: doing so would
either change semantics or add a second implementation while retaining the hand
kernel, violating this issue's own net-negative acceptance rule.

The smallest plausible group was `__hasOwnProperty` + `__object_hasOwn`, which
share one roughly 55-line body. It is not a pure externref composition: it must

1. convert externref to anyref;
2. discriminate and cast to the concrete runtime `$Object` type;
3. call `__obj_find` with a `(ref $Object, externref) -> ref null $PropEntry`
   ABI; and
4. test the returned nullable `$PropEntry`.

The self-host driver can resolve a named type index, but ordinary TS source
cannot express the required `any.convert_extern`, `ref.test $Object`,
`ref.cast $Object`, nullable `$PropEntry` value, or typed-ref call argument.
Adding `resolveObject` alone does not help: that resolver lowers compiler-owned
TS object literals/shapes, not a cast into this pre-existing dynamic-object
runtime representation. This group is additionally patched by the builtin-fn
metadata path, so replacing it with a narrower `$Object`-only composition would
regress reflective `name`/`length` properties.

Other superficially small candidates fail the same gate or the LOC gate:

- `__objvec_new` is only a five-instruction body; source descriptors plus typed
  `$ObjVec`/array allocation intrinsics would grow the tree.
- `emitStandaloneObjectConstructor` is a one-instruction tail-call wrapper and
  the vector constructor is five instructions; both are necessarily
  net-positive when represented as self-hosted source.
- `__extern_is_undefined` needs native-representation discrimination,
  `$AnyValue`/`$BoxedNumber` struct reads, and exact i64 NaN-sentinel bit tests.
- `__obj_hash`, `__key_equals`, the property-table operations, prototype walks,
  ordering, and `Object.is` require typed struct/array access plus raw ref
  discrimination/identity (`ref.test`/`ref.cast`/`ref.eq`); these are precisely
  the deferred Precursor-D operations.

The only thin, fixed-ABI externref compositions in this family were already
self-hosted by #3160 (`__object_getOwnPropertyDescriptors` and
`__object_fromEntries`). That earlier slice is the safe ceiling of the current
dialect.

### Measurement

`pnpm run profile:godfiles` on origin/main `3ff92c797db272` reports:

- `src/codegen/object-runtime.ts`: **6,616 LOC**, **2,449** `op:` emissions;
- `ensureObjectRuntime`: **3,495 LOC**, **1,298** emissions, density **0.37**;
- before/after delta for this recon: **0 LOC / 0 emissions**.

Because no hand-emitted body was removed, the god-file baseline was correctly
left unchanged. The old issue premise's 11.6k/7,355-LOC figures predate the
#3265/#3274 extractions and are not the current profiler baseline.

### Unblock condition

Do not retry another object-runtime leaf until the source IR has a typed
runtime-representation intrinsic layer (Precursor D) that can express, at
minimum, externref-to-named-ref test/cast, nullable named refs, typed struct
get/set, typed array get/set/allocation, and ref identity. Re-measure after that
lands; begin again with the duplicated has-own group. Full deferred object/class
registries are useful only after those operations are source-expressible and do
not themselves make a helper convertible.

### Validation

- `pnpm run profile:godfiles` — completed; figures recorded above.
- No behavioral tests or containment SHA were run because no emitted code
  changed.
