---
id: 3124
title: "Inherited member reads through host prototype chains OVER compiled structs (Object.create(struct) / getPrototypeOf round-trips) resolve undefined — struct-opacity substrate gap"
status: ready
sprint: Backlog
priority: medium
horizon: l
feasibility: hard
created: 2026-07-09
task_type: bugfix
area: runtime
language_feature: prototype-chain
goal: spec-completeness
related: [3049]
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
