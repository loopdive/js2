---
id: 3124
title: "Inherited member reads through host prototype chains OVER compiled structs (Object.create(struct) / getPrototypeOf round-trips) resolve undefined — struct-opacity substrate gap"
status: done
sprint: current
priority: medium
horizon: l
feasibility: hard
created: 2026-07-09
completed: 2026-07-10
assignee: fable-3124
task_type: bugfix
area: runtime
language_feature: prototype-chain
goal: spec-completeness
related: [3049, 3129]
---

# #3124 — inherited reads through `Object.create(<compiled struct>)` chains

## Source

Empirical probes from the #3049 investigation (fable-proto, 2026-07-09).
This is the REAL residue of what fable-3022 called the
"externref-prototype-storage wall" — verified to be NOT a storage gap
(identity and own-member reads round-trip fine through `F.prototype`
storage, cross-function; see #3049 notes) but a **member-read** gap when a
compiled WasmGC struct sits in the middle of a host-visible prototype chain.

## Verified repro matrix (host lane, current main + #3049)

```ts
// F — SAME function, no storage anywhere:              FAILS (-2)
var base: any = {
  greet: function (): number {
    return 7;
  },
};
var p: any = Object.create(base);
typeof p.greet; // "undefined" — inherited member not found

// I — the chain EXISTS:                                 PASSES
Object.getPrototypeOf(p) === base; // true

// K2 — own NUMBER member through the round-trip:        PASSES
var proto: any = Object.getPrototypeOf(p);
proto.n; // 5 (via __sget_n)

// J/L2 — own FUNCTION member through the round-trip:    FAILS
proto.greet; // found but NOT callable (raw closure struct pre-#3049;
// #3049's bridge marshal fixed the closure-bridge/callback
// paths, but the __extern_get receiver path remains)
```

## Mechanism

- Object literals compile to WasmGC structs; V8 sees them as opaque exotic
  objects with `[[Prototype]] = null` and no own properties.
- `Object.create(base)` lowers to the `__object_create` host import →
  `Object.create(rawStruct)` → a REAL host object whose `[[Prototype]]` is
  the opaque struct.
- A dynamic member read `p.greet` routes to the host `__extern_get`
  (src/runtime.ts): its native arm (`key in obj` + `obj[key]`) walks the
  chain natively — the struct's fields are invisible to the native MOP — and
  its struct arms (`__sget_*`, sidecars) only fire when the RECEIVER itself
  is a struct, never when a struct sits mid-chain. Result: `undefined`.

## Suggested approach

Two composable options:

1. **Wrap at the `__object_create` boundary**: when the proto argument is a
   raw struct, substitute its `_wrapForHost` live-mirror proxy as the
   `[[Prototype]]` (`Object.create(_wrapForHost(struct, exports))`). Native
   chain walks then read through the proxy traps (own fields via `__sget_*`,
   closures via the bridge). Must keep `getPrototypeOf(p) === base` working
   for compiled comparisons — `_hostEqComparableValue` already canonicalizes
   proxy↔raw for `===`, and `__getPrototypeOf` could unwrap before returning
   to wasm.
2. **Teach `__extern_get` to walk chains struct-aware**: on a miss for a
   host-object receiver, walk `getPrototypeOf` links manually; at each hop
   that `_isWasmStruct`, consult `__sget_<key>` / sidecars before moving up.

Option 1 is more systemic (fixes `in`, `hasOwnProperty` walks and native
consumers too); option 2 is more contained. Either way, validate against the
#3049 bridge-marshal identity discipline (`_hostProxyReverse` unwrap on wasm
re-entry).

## Acceptance criteria

- Probes F, H (module-global variant), and L2 (function-valued own member
  through a getPrototypeOf round-trip → callable) pass.
- Zero regressions vs the honest v2 baseline (broad-impact — full
  merge_group).

## Implementation notes (fable-3124, 2026-07-10)

**All acceptance probes pass** (F, H, K2, L2 + inherited data members +
class-instance protos + inherited literal-method calls + `in` + two-level
chains). Locked in `tests/issue-3124.test.ts` (10 tests). Runtime-only —
`prove-emit-identity` confirmed all 39 (file,target) hashes byte-identical.

### WHY the fix is shaped this way

Verified empirically before coding (WAT dumps in the session):

- `Object.create(base)` lowers to the `__object_create` host import, which
  really does `Object.create(rawStruct)` — the opaque struct IS the host
  `[[Prototype]]` (identity round-trips; `getPrototypeOf(p) === base`).
  Option 1 from the spec sketch (substituting a `_wrapForHost` proxy as the
  proto at the create boundary) was REJECTED: it would break that identity
  (`===` comparisons and `__getPrototypeOf` reads would need unwrap hooks at
  every consumer) and put a proxy on the hot native-MOP path of every
  created object. Option 2 (struct-aware chain walk at the resolution
  boundaries) is strictly additive: it only runs where the old code
  unconditionally returned `undefined`/threw.
- The member read for a non-struct receiver lands in the per-name
  `__get_member_<name>` dispatcher's else-arm → `__extern_get`. There are
  TWO `extern_get` implementations in runtime.ts (name-based ~9000 and
  intent-based ~14500 — modern compiles bind the INTENT one); both had the
  identical `getPrototypeOf(obj) !== null → return undefined` bail and both
  got the walk. Patching only the name-based one silently no-ops.

### What changed (src/runtime.ts, all host-glue)

1. `_protoChainStructResolve(receiver, key, callbackState)` — bounded manual
   chain walk; at each `_isWasmStruct` hop resolves OWN members through the
   exact direct-receiver machinery (`_resolveHostField`: accessors → sidecar
   → `__sget_<key>` → vivified fnctor prototype), honoring the delete
   tombstone per hop (a deleted own member continues the walk up, per
   §10.1.8.1 OrdinaryGet). Plain-object hops are not re-checked (the callers'
   native walk already consulted them). Values return RAW (closures as raw
   structs) — identical representation to direct-receiver reads.
2. `__extern_get` (both name-based and intent-based): the non-null-proto
   bail now walks before conceding undefined.
3. `__extern_has`: `in` walks struct hops via the tombstone-aware
   `_wasmStructHasOwn` oracle (key-based, value-independent — §7.3.12).
4. `__extern_method_call`: a last-chance inherited arm before the
   "is not a function" throw — resolves via the walk, wraps through
   `_maybeWrapCallableUnknownArity`, dispatches with the ORIGINAL receiver
   as `this` (the method-arity bridge threads it as `__current_this`).
5. `typeof_check` intent (`targetType === "function"` only): the fused
   `typeof x === "function"` compare now recognizes raw closure structs via
   `__is_closure` — mirroring `__typeof` (#1594A) and the standalone
   `__typeof_function` (#1896), which were both taught this lesson while the
   host-intent twin was not. Without this, probe F printed "function" via
   `console.log(typeof p.greet)` but the guarded call still took the else
   branch.

### Boundary — what is NOT fixed (split to #3129)

A method call whose NAME matches a compiled CLASS method (`o.getX()` on
`o = Object.create(new Base())`) never reaches the host: calls.ts's
"scan all known classes" fallback statically binds the call to
`$Base_getX` and null-coerces foreign receivers (`ref.test → else
ref.null`), trapping in-wasm (`dereferencing a null pointer`). That is a
CODEGEN change with emission-wide byte-diff — filed as #3129 with the full
WAT-level mechanism and fix direction. The true substrate limit underneath:
compiled method bodies are shape-specialized, so an own-property SHADOW on
the Object.create receiver (`o.x = 99; o.getX()`) can never be honored by a
struct-`this` dispatch.

Also pre-existing, noted not chased: our struct-proto chains terminate at
the struct (no `%Object.prototype%` link), so `p.hasOwnProperty(...)` on
such receivers resolves only through the `_OBJECT_PROTO_KEYS` special-cases,
not a real chain hop.

### Latent main-side failures found during validation (NOT from this PR)

Both fail identically on pristine origin/main (42c8ab99ae696) and are
OUTSIDE CI's executed set (equivalence shards run only `tests/equivalence/`;
`quality` runs lint/typecheck + named files):

- `tests/check-regressions.test.ts` › "Object.create with inherited writable
  descriptor" — afterWrite=false in the non-deferred lane.
- `tests/issue-1528-closure-construct.test.ts` › "does NOT route a
  generator-method value through the construct bridge" — the
  `__construct_closure` import IS emitted again for `{ *m(){} }.m`.
