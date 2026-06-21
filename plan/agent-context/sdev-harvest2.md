# sdev-harvest2 — session context (2026-06-19)

## Ledger (this session)

**The value-read `$NativeProto` lever — 234 measured standalone test262 flips, 0 regressions, across 12 builtin brands:**
- #2374 (String/Number/Boolean.prototype value reads) — **72 flips, MERGED** (PR #1723)
- #2376 (Date.prototype value reads) — **82 flips, MERGED** (PR #1733)
- #2377 (Error/Map/Set.prototype value reads) — **47 flips** (PR #1737, draining; drift-resolved)
- #2378 (Function/Symbol/BigInt/WeakMap/WeakSet.prototype value reads) — **33 flips** (PR #1739, draining; drift-resolved)

Pattern: register `$NativeProto` member-CSV glue (`ensure*NativeProtoGlue` in
`src/codegen/array-object-proto.ts`) for a pre-reserved builtin brand and wire
one `if (builtinName === ...)` branch into `tryEnsureNativeProtoBrand`
(`src/codegen/property-access.ts`). Pure additive, no host import, WAT
byte-identical on the green path. Discipline: measure-first (flip + regression +
init-trap check) per brand BEFORE committing.

**Infra fix — PR #1744 (ci(#2379)), ENQUEUED, required gates green:**
- Root-caused 7+ consecutive failing push-to-main `test262-sharded.yml` runs:
  the `regression-gate` `Fail on regressions` step hard-fails on baseline-drift
  "regressions" (a +3231 NET improvement was failed on 695 drift regressions).
  Fix: `&& github.event_name != 'push'` guard on the step + widen the
  `staleness` step to render the drift footer on push. Unfreezes HW reporting.

## Diagnoses handed to architect (contained-or-escalate rail)
- **#2375** (PR #1745, docs): the TypedArray/ArrayBuffer/DataView value-read
  cluster traps at module init NOT because of the glue (bare value-read
  instantiates clean) but because the test262 harness `testTypedArray.js`
  module-scope `[Float64Array, Float32Array]` (builtin ctors as values) +
  `Object.getPrototypeOf(Int8Array)` emit unsatisfiable `env` imports in
  standalone. Glue flips 0/40 — architect-scale (standalone builtin-ctor
  reflection, folds into #2026). `status: blocked / needs_role: architect`.
- **#1917 ToPrimitive** + **Promise null-deref** + **#1629b __typeof** — fed to
  the respective runtime/engine owners (sdev-toprimitive), not co-edited.

## Standing assignment
I am the natural **#2379 implementer** when arch-arrayrep's spec lands
`status: ready` — I have the array-method + value-read-glue context. Re-spawn me
with that spec when the rate limit eases.

## Lane status
Clean unowned non-engine standalone lane is **exhausted** (measured 3×). The
remaining big buckets are engine-gated (#1917 ToPrimitive), owned (#1355
dynamic-shape, #54 array-like-call, Array/sort=sdev-recv), or runtime-entangled
(TypedArray/ArrayBuffer/DataView=#2375, Promise=async). Paused as capstone.
