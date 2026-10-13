---
id: 6972
title: "standalone: `this.initialize.apply(this, arguments)` inside a constructor retains ~400 B per construction (raytrace leaks ~29 MB/rep → V8 OOM)"
status: ready
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
