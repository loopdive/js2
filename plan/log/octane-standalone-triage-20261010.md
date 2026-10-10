# Session D standalone Octane triage, 2026-10-10

Refined plans for #1472 (raytrace) and #6941 (box2d compile time), from the Session D triage pass. The issue files for these two live on PR branches (#6622 and #6621), so the refinements are recorded here to avoid conflicting with them. Probe and repro paths refer to the triage worktree `.tmp/` and are not committed.

Harness prerequisite (landed on PR #6618): every js2 lane compiles Octane with `inferModuleStrictArguments: false`, and the standalone lane with `runtimeEvalProvider: false`.

## #1472

# #1472 — raytrace slice: re-verification on `c-octane-integ` (Session D, 2026-10-10)

Source plan: `plan/issues/1472-no-js-host-object-property-ops.md` on `origin/claude/octane-regexp-raytrace`,
section "Octane raytrace evidence — `Object.extend` expando on a builtin constructor" (Session C).

## Re-verified on this branch

- `node --import tsx .tmp/octane-sa.mjs raytrace --script --no-eval` → compile-error
  `'__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)` (compile ≈5.5 s).
- `.tmp/rt1.js` (`Object.extend = function(d,s){…}; main(){ return Object.extend({}, {a:1}).a*10 + (typeof Object.extend === "function") }`)
  → node `11`, standalone: the same compile error. The two gaps named in the Session C plan (the call reaches
  `isHostResolvedBuiltinReceiver` → `__get_builtin`; the top-level write is dropped by `shouldKeepBuiltinReceiverWrite`)
  still hold; files/functions cited there are unchanged on this branch (`builtin-write-keeps.ts`
  `EXPANDO_NAMESPACES = {Math, JSON, Reflect}`, `BUILTIN_STATIC_METHOD_ARITY` test; `standalone-unavailable-globals.ts:165`).
- **The plan is still correct and sufficient for the COMPILE error. Keep it as written.** Refinements below.

## Refinements

1. The same `Namespace.<unknown>()` refusal fires for `Math.foo()` (`.tmp/rx3.js`) — the `isHostResolvedBuiltinReceiver`
   change should answer false for every carrier-backed builtin with no modelled static of that name (Math/JSON/Reflect
   included), not only constructors. Then the call compiles as a dynamic method call on the carrier VALUE and resolves the
   expando (seeded carriers — `emitBuiltinNamespaceObject` — already hold every modelled method as an own property).
   This also serves the regexp fix (`.tmp/#6957`, step 2) — coordinate: do the receiver
   predicate here, the patched-method call arm there.
2. Acceptance for raytrace must be phrased as "compiles AND reaches the first RUNTIME failure", because the compile fix
   alone does not make raytrace pass. Simulated with `.tmp/patch-rt-extend.mjs` (renames `Object.extend` to a plain
   function): standalone init throws at raytrace.js:357 `new Flog.RayTracer.Material.BaseMaterial()` — the dynamic-new
   gap on call-result callees (`Flog.RayTracer.X = Class.create()`), filed as
   `.tmp/#6954` (repros `.tmp/rt5.js`, `.tmp/rt6.js`, `.tmp/rt2b.js`).
   The two "out of scope" gc-host failures Session C listed are the standalone blockers too; the `Flog.RayTracer.Color =
   function(r){…}` + prototype shapes (`.tmp/rt3.js` family) PASS on this branch (rt3c/rt3d) — only the `Class.create()`
   result form fails, so that second bullet in Session C's note is resolved by #6943 already.
3. Order for the raytrace goal: #1472 raytrace slice (compile) → dynamic-new issue (init) → re-run
   `node --import tsx .tmp/octane-sa.mjs raytrace --script --no-eval` for the next failure (expected candidates: the
   `this.initialize.apply(this, arguments)` ctor body — `.tmp/rt2.js` — and prototype replacement on a call-result fnctor).
4. Harness: raytrace, like every bench, needs `inferModuleStrictArguments: false` (#6937 step 4) and `runtimeEvalProvider:
   false` on the standalone lane (`.tmp/#6956` step 4).

Size of the raytrace slice of #1472 as planned by Session C: **S/M** (two predicate changes + tests).


## #6941

# #6941 — box2d compile time: re-verification on `c-octane-integ` (Session D, 2026-10-10)

Source plan: `#6941 (issue file on PR #6621)` on `origin/claude/octane-invalid-wasm` (Session C).

## Re-measured on this branch (4-core box, two other implementers active)

| run | wall |
| --- | --- |
| `node --import tsx .tmp/trace.mjs --bench box2d --script --no-eval` (standalone compile, inside the trace driver) | **167 s** and **165 s** (two runs) |
| Session C's figure for standalone | 325 s |

Half of Session C's number, same branch family; either load or an already-landed slice (#6940/#6943 touch the
same hotspots) — treat 165 s as the current base and re-profile before claiming a delta. The plan's three hotspots
(A: 1,055 `fixupModuleGlobalIndices` rewalks from `addHostStringConstantGlobal`; B: `bindingHasWrites` whole-file walk
per `new <alias>(…)`; C: `runtimeAccessorDescriptorKey` / `arrow-phases` capture scans) are still the right targets;
box2d has ~2,900 imports and 105 alias `new` sites, so B and A dominate standalone as well.

## Refinements

1. **Runtime blocker first.** box2d does not RUN on standalone even after compiling: module init throws in
   `b2Mat22.FromVV` (`new F` on an IIFE-local alias of a nested-declaration constructor) — filed as
   `.tmp/#6954` (repros `.tmp/b2.js`, `.tmp/b3.js`, `.tmp/b5.js`).
   Compile-time work should not block on it, but the #874 acceptance ("box2d passes") needs that fix; the compile-time
   work only matters for the 300 s harness timeout (`--timeout 300` — at 165 s compile + run it is already within budget
   on an idle box, so #6941 is a P2 for the standalone goal, not a blocker).
2. **Profile standalone, not gc.** Session C profiled gc. For standalone, add the native-string lowering to the suspect
   list (`stringConstantExternrefInstrs`/`addStringConstantGlobal` per first-seen property name is hotspot A's
   standalone twin — same batching fix via `registerLateReadStringConstant`).
3. **Regression guard**: the trace driver writes `.tmp/box2d.raw.wasm` (11.9 MB) — keep a size/hash check in the PR so the
   compile-time refactors (steps 1, 3, 4 are pure refactors) are provably byte-neutral on box2d itself, not only on fixtures.
4. Step order unchanged (B → A → C1 → C2 → measure standalone). Size **M** as planned.


