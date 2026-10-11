---
id: 6972
title: "standalone: `this.initialize.apply(this, arguments)` inside a constructor retains ~400 B per construction (raytrace leaks ~29 MB/rep → V8 OOM)"
status: done
completed: 2026-10-11
assignee: ttraenkler/claude-session-d
sprint: current
created: 2026-10-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: arguments, Function.prototype.apply, constructor-functions
goal: standalone-gap
related: [6967, 6968, 6971, 6961, 6964]
depends_on: [6964]
# 2026-10-11: the arguments-companion slot arms splice into the overlay core
# (vec-overlay.ts ensureOverlayCore: lookup + shared append tail); the slot
# field and the arm builder live with the arguments brand
# (arguments-length-brand.ts). Restated here so the grant is not stranded in
# #6964's issue file once that lands first.
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/arguments-length-brand.ts
  - src/codegen/arguments-vector-tail.ts
func-budget-allow:
  - src/codegen/vec-overlay.ts::ensureOverlayCore
---

# `fn.apply(this, arguments)` in a constructor leaks per construction

Found by the #6971 implementer (Session D, 2026-10-11) while profiling Octane raytrace on
standalone (integration branch = main + #6949/#6951/#6966/#6967/#6968/#6971). With #6967 and #6968
in place, raytrace runs and validates, but its harness row aborts with a V8 out-of-memory error:
the heap grows by about **29 MB per rep** and is never reclaimed.

The cost is not the problem. At ~0.4 s/rep, the node-calibrated 48 reps × 6 calls take about 115 s,
which fits the harness's 180 s run cap. **The leak alone keeps raytrace off the scorecard.**

## Repro (narrowed by the #6971 implementer)

```js
var Class = { create: function () { return function () { this.initialize.apply(this, arguments); }; } };
var V = Class.create();
V.prototype = { initialize: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
                add: function (o) { return new V(this.x + o.x, this.y + o.y, this.z + o.z); } };
export function test(n) {
  var acc = new V(0, 0, 0);
  for (var i = 0; i < n; i++) acc = acc.add(new V(1, 2, 3));
  return acc.x + acc.y + acc.z;
}
```

Compile it with `target: "standalone", allowJs: true, inferModuleStrictArguments: false,
runtimeEvalProvider: false`, then call `test(100000)` in batches with `gc()` between them. The heap
grows by about 400 B per construction.

- **Does not leak:** `this.initialize.apply(this, [a, b, c])` (an array literal) and plain
  `arguments[i]` reads.
- **So the suspect is** the materialized `arguments` object once it escapes into `.apply`. Something
  global keeps it, or the receiver, reachable. This is the same shape as #6961, #6964 and #6971: a
  global, never-pruned side table (an arguments companion or overlay, a closure-bag entry, an
  integrity bag, an `apply` spread cache…).

## Plan

1. Reproduce on `c-octane-integ` plus this fix. Use a heap snapshot or the wasm GC-type census to
   find which struct type accumulates, then find the global or table that keeps it alive.
2. Fix the retention at its source: prune, use a weak key, or avoid materializing it. Keep semantics
   (`arguments` aliasing in sloppy mode, `apply` with array-likes).
3. **Acceptance:**
   - the repro's heap is flat across batches;
   - the raytrace harness row (`--only raytrace --lanes node,standalone`) passes with the default
     run timeout;
   - a regression test asserts the result, and asserts boundedness where that can be observed;
   - host (gc) output is byte-identical if the fix is standalone-only.

## Implementation notes (2026-10-11)

**Root cause.** A sloppy function whose `arguments` escapes (here into `.apply`) builds the
branded `$__arguments_vec` and seeds its own `@@iterator` and `callee` through
`__args_own_define_value` (#6964). That native puts the properties on an overlay **companion**
`$Object`, and `__vec_overlay_ensure_newest` / `_fresh` registered the `(vec, companion)` pair in
the global `$__overlay_tab`. The table is strongly held and never pruned, so every arguments
object and its companion stayed reachable for the life of the instance. #6964 removed the
*scan* cost of that table but not the *retention*. Measured: about 400 B per call, the same
for a constructor and for a plain `function fwd() { return g.apply(null, arguments); }`
forwarder. Array-literal `apply` and `arguments[i]` reads do not leak because they never
materialize an observable arguments object.

**Fix.** The arguments object keeps its own companion. `$__arguments_vec` gets a sixth field,
`overlayCompanion` (mutable `anyref`, null until the first own-property define). In the overlay
core:

- `__vec_overlay_lookup` answers a branded arguments vec from that field;
- the shared table-append tail (`__vec_overlay_ensure` after a miss, and
  `__vec_overlay_ensure_fresh`, which `_ensure_newest` falls through to) stores a fresh companion
  in the field instead of appending.

The append tail still initializes the table's state global first. That keeps the
`__extern_get` / `__vec_prop_get` string-key read prologues working: they skip the overlay
whenever that global is null, so a module whose only companions are arguments objects would
otherwise stop seeing `callee`, `@@iterator` and expandos.

The numeric-entry table (`__vec_overlay_mark_num` / `_lookup_num`) is unchanged. It registers
an arguments companion only after an index-keyed define or delete, which is rare, and it
returns the same companion object as the slot, so the two stay consistent.

Unbranded (aliased extras-vec) arguments objects and array companions keep the table path.
`fillVecOverlayHelpers` and the brand are standalone-only, so host (gc) output is unchanged.

**Files:** `src/codegen/arguments-length-brand.ts` (field + `buildArgumentsCompanionArm`),
`src/codegen/arguments-vector-tail.ts` (the single `struct.new` site pushes the null slot),
`src/codegen/vec-overlay.ts` (the two arm splices).

**Base:** stacked on #6964 (`claude/standalone-overlay-table-bound`, not yet on `main`). The
arguments seed natives and `__vec_overlay_ensure_newest` that this fix touches come from that
branch.

**Measured (c-octane-integ + this fix, 4-core container):**

- repro `leak1.js`, `test(100000)` × 5 with `gc()` between batches: base 299 → 613 MB
  (~78 MB per batch); head flat at 220 MB, and each batch is ~15 % faster.
- Octane raytrace standalone, `octane_run(5)` × 5: heap flat at 4.8 MB.
- `benchmark:octane --only raytrace --lanes node,standalone`, default run timeout:
  - base: skipped ("timeout after 180s", 72 reps);
  - head: PASS (34 reps, score 227);
  - head with fixed `--reps 72`: PASS in 154 s wall (~0.32 s per rep).

Raytrace is still ~240× slower than node. That throughput gap is separate from this issue and
not addressed here.
