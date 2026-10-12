---
id: 6973
title: "standalone perf: generic property lookup on fnctor instances walks the prototype chain recursively in `__extern_get` (deltablue ~1000× node; needs ~2× to fit the Octane run cap)"
status: done
sprint: current
created: 2026-10-11
completed: 2026-10-11
assignee: ttraenkler/senior-dev
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
language_feature: prototype, property-access, constructor-functions
goal: standalone-gap
related: [6971, 6966, 6951, 6949, 6944]
# 2026-10-11: +2 lines in object-runtime.ts (one import, one call at the head of
# unshiftExternGetProtoCacheArm) — the new arm lives in fnctor-fast-get.ts (#6973).
loc-budget-allow:
  - src/codegen/object-runtime.ts
  # 2026-10-12 (#6973 stage 2): +14 — the `__extern_set` overlay prologue routes a
  # present-element overwrite to `directOwnElementStore` (vec-overlay-carriers.ts)
  # instead of minting a descriptor companion (the deltablue leak).
  - src/codegen/vec-overlay.ts
  # 2026-10-12 (#6973 stage 2): +35 — `this.<field>.m()` admission for the guarded
  # direct-call trampoline, and the trampoline's own-expando-bag decline
  # (`noOwnExpandoBag`) that keeps `o.m = f` shadowing the prototype twin.
  - src/codegen/typed-this.ts
  # 2026-10-12 (#6973 stage 2): +5 — the `vec[untypedKey]` read opts into the
  # Number-key `__extern_get_idx` arm (array-nonindex-key.ts).
  - src/codegen/property-access.ts
  # 2026-10-12 (#6973 stage 2): +10 — `deriveFnctorFields` reserves the fields a
  # `Parent.call(this, …)` delegate assigns (analysis in fnctor-call-grown-fields.ts).
  - src/codegen/fnctor-escape-gate.ts
coercion-sites-allow:
  # 2026-10-12 (#6973 stage 2): `__unbox_number` on a key `__typeof_number` has
  # just proven to be a Number box — an unbox, not a ToNumber coercion.
  - src/codegen/array-nonindex-key.ts
func-budget-allow:
  # 2026-10-12 (#6973 stage 2): same change, inside the fill.
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  # 2026-10-12 (#6973 stage 2): the call-site flag above (+5).
  - src/codegen/property-access.ts::compileElementAccessBody
  # 2026-10-12 (#6973 stage 2): the call-grown field loop (+9).
  - src/codegen/fnctor-escape-gate.ts::deriveFnctorFields
flat-dir-budget-allow:
  - src/codegen/fnctor-call-grown-fields.ts # 2026-10-12 (#6973 stage 2): `Parent.call(this, …)` delegate-field analysis, beside its fnctor-* siblings
  - src/codegen/fnctor-fast-get.ts # 2026-10-11 (#6973): the fnctor-instance __extern_get fast arm; sits with its flat fnctor-* siblings (fnctor-struct-proto-hop.ts, fnctor-identity-fields.ts) whose helpers it composes
---

# Deltablue: prototype-method reads go through a recursive generic `__extern_get` walk

After #6971 (closure-bag slot on on-demand fnctor structs), deltablue on standalone runs at about
**77 ms per rep** against node's 75 µs. Measured on main + #6949/#6951/#6966/#6967/#6968/#6971.

The Octane harness makes 6 calls of `octane_run(703)`, because reps are calibrated on node. That is
about 325 s, against a 180 s run cap. **Deltablue needs about 2× (≤ ~40 ms per rep) to pass with
default settings.**

## Profile after #6971

| Function | Share | What it does |
|---|---|---|
| `__extern_get` | ~27 % self | recursive `[[Prototype]]` chain walk for inherited methods |
| `__obj_find` / `__obj_hash` | | per-level own-property hash lookups |
| `ref.test` chains | | struct-type dispatch per receiver |

Deltablue is method-heavy: `c.output()`, `this.strength.stronger(...)`, `v.addConstraint(...)`, all
inherited through `Constraint.prototype` / `BinaryConstraint.prototype` chains built with
`Object.inherits` (child `.prototype = Object.create(parent.prototype)` style).

## Plan (measure first)

1. Profile deltablue on integ plus #6971 and list which call sites reach `__extern_get` with a
   method name, and at what chain depth.
2. Pick the cheapest of the following that gives ≥ 2× on deltablue without an object-model
   rewrite:
   - **(a)** Make the walk iterative instead of recursive, and short-circuit levels whose `$Object`
     has no own entries.
   - **(b)** A per-call-site monomorphic inline cache for `obj.name(...)` calls, keyed on the
     receiver's struct type plus the shape of the proto object, holding the resolved closure. It
     must be invalidated on any prototype write; reuse the #6951 prototype-write routing hooks.
   - **(c)** Intern the property-name strings, so `__obj_hash` / `__obj_find` compare by identity.
3. **Acceptance:**
   - `--only deltablue --lanes node,standalone` passes with the default 180 s run timeout;
   - no change in the equivalence gate or the related tests;
   - host (gc) output is byte-identical, or any change is justified.

## Implementation notes (2026-10-11)

### Measured breakdown before the fix (deltablue standalone, c-octane-integ + #6971)

Executed-call census per rep (`JS2WASM_EXEC_CENSUS`): 304 k `__extern_get`
entries for ~123 k top-level reads — 181 k were re-entries through
`__reflect_get_receiver`: 75 k on a struct link (#6944 hop: `UnaryConstraint.prototype`
is a `new Inheriter()` struct) and ~106 k on a carrier `$bag` (the per-carrier bag
arm reads an own expando by re-entering `__extern_get` on the bag). Every entry
paid the full ladder (error/Map/vec/string arms, `__wrapper_string_value`, bag
arms, field ladder, builtin-fn metadata, instance-expando consult) before the
walk. `__extern_get` was 65 % of the run inclusive. The #3673 per-key cache never
helped: it serves only receivers whose link is an `$Object`, and is monomorphic
per key while deltablue's method keys are polymorphic (a node replay of the
method calls gives 75 % for a 1-way per-key cache, 99 % for 2-way).

### What landed — option (a) of the plan, iterative and uncached

`src/codegen/fnctor-fast-get.ts`: `__fnctor_fast_get(recv, key)`, one arm
unshifted into `__extern_get` right behind the #3673 cache arm (that arm stays
the prefix the #4157 inline extractor needs). For an interned key and an
eligible fnctor receiver it walks own `$bag` → struct links → `$Object` `$proto`
chain iteratively, DATA properties only, and declines everything else to the
unchanged ladder (accessors, tombstones, bag-shadow sentinel, null `$proto`
terminal, closed prototype edges, field-name / `constructor` / `__proto__` keys,
types the ladder does not model). The struct-chain termination guard
(`__fnctor_struct_proto_ok`) is reproduced: the walk follows links to an
`$Object` or a dead end before answering a link-bag hit, else asks the
predicate. `__obj_find_h` probes with the key's known hash and delegates any
uncertain slot to `__obj_find`. The same helper backs `__method_cache_lookup`, so
the `__call_m_*` round-13 direct-call arm (no `$ObjVec`, no
`__extern_method_call` / `__apply_closure`) now covers struct-link methods.

Why no cache (options b/c): every read re-walks live state, so prototype writes,
own shadowing, deletes and `setPrototypeOf` need no invalidation hooks — an
epoch would have had to be bumped at every `$proto` / snapshot / prototype-global
/ `$bag` write site across the codebase, and the uncached walk already reached
the target. Why not before the prefix arms: the later finalize fills (closed
prototype edges, runtime-eval carriers, linked realm, …) would then need the same
equivalence argument one by one.

### Results

| | base | head |
|---|---|---|
| deltablue `__extern_get` entries / rep | 304 k | 162 k (143 k answered by the arm) |
| deltablue standalone ms/rep (stacked branch, `.tmp` driver) | ~79 | ~32.5 |
| deltablue standalone ms/rep (c-octane-integ + fix) | ~80–88 | ~26–31 |
| `benchmark:octane --only deltablue --lanes node,standalone --timeout 600` | over the 180 s cap (issue estimate ~325 s; not re-run) | PASS, 852 reps, 25.6 ms/rep mean, 141 s wall (load avg ~6.5 on 4 cores) |
| raytrace standalone ms/rep (c-octane-integ) | ~470 | ~470 (unchanged) |

Raytrace does not move: its receivers are `$Object`s (`Class.create()` /
`Object.extend`), which this arm deliberately skips; its cost is the
`$Object` ladder path and GC (#6972).

### Pre-existing divergences found (unchanged by this fix, same on base)

- `c.constructor` on an instance whose prototype is a struct link answers the
  instance's own ctor (`$constructor` back-pointer) — node answers the inherited one.
- `delete c.m` of an own expando that shadows an inherited `m` leaves `c.m`
  reading as absent (the delete writes the bag-shadow sentinel).
- `Object.setPrototypeOf(fnctorInstance, p)`: a later CALL `c.m()` still
  dispatches through the old prototype and `Object.getPrototypeOf` misreports;
  reads (`var f = c.m`) are correct. Two re-links in one program throw.
- `Object.defineProperty(<struct-link prototype>, k, { get })` getters read as 0/absent.
- `p.hasOwnProperty("m")` answers true for an inherited method of a declared-field fnctor.
