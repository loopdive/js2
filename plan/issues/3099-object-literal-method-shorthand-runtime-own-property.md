---
id: 3099
title: "any-context object-literal METHOD-SHORTHAND props are compile-time-only — never materialized as runtime own properties on `$Object` (silently drops every shorthand Proxy trap, iterator `next()`, Object.keys entry)"
status: done
sprint: Backlog
model: opus
created: 2026-07-09
completed: 2026-07-09
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone
language_feature: object-literals, proxy, iterators
goal: standalone-mode
related: [1355, 3031, 1100, 2358, 3023, 2964]
origin: "2026-07-09 fable-arch hard-problems audit (domain 4) — root-caused why standalone Proxy traps written in test262's dominant method-shorthand style silently forward to the target while arrow-property handlers fire"
---

# #3099 — method-shorthand props missing from the runtime `$Object`

## Problem (verified against origin/main @ 928c85179, 2026-07-09)

An object literal compiled on the **any-context `$Object` route** stores
`PropertyAssignment` props (including arrow-function values) as runtime own
properties via `__extern_set`, but **skips `MethodDeclaration` (method
shorthand) props entirely**. The skip is documented in the code:

> `src/codegen/literals.ts:322-326` (`compileObjectLiteralAsExternref`):
> "MethodDeclaration is not reached here for the any-context route — object
> literals with methods take compileObjectLiteralWithAccessors (accessors) or
> emitObjectMethodAsClosure on the struct path. A plain method in an
> any-context literal falls through (skipped) — covered by S2 follow-on."

**That "S2 follow-on" is tracked nowhere** (grep of `plan/issues/` finds no
owner). This issue is that follow-on.

Probes (standalone, `nativeStrings`):

```ts
const h: any = {
  m() {
    return 3;
  },
};
h.m(); // 3   — static access-site resolution works
const f: any = h.m;
f(); // 3   — static
const k: any = "m";
h[k]; // undefined — RUNTIME read misses
Object.keys(h).length; // 0   — not an own property at runtime
// arrow-property control:
const h2: any = { m: () => 3 };
const k2: any = "m";
h2[k2](); // 3 — arrow props ARE materialized
```

## Highest-leverage consequence: standalone Proxy traps silently no-op

`__proxy_create` (#1100) reads traps **at runtime** off the handler `$Object`
(`__extern_get(handler, "get")`, …). test262 writes handlers almost
exclusively in method-shorthand style — so the trap read misses and every
dispatch silently forwards to the target:

```ts
new Proxy(
  { a: 1 },
  {
    get(t, k) {
      return 42;
    },
  },
).a; // 1 (trap DROPPED)  ✗
new Proxy({ a: 1 }, { get: (t, k) => 42 }).a; // 42 (trap fires)   ✓
new Proxy(
  {},
  {
    has(t, k) {
      return true;
    },
  },
); // "z" in p → false  ✗
new Proxy({}, { has: (t, k) => true }); // "z" in p → true   ✓
```

The entire #1100/#1355 trap-dispatch substrate (12 wired traps) is therefore
**dark for the dominant test262 handler shape**. This single bug caps
standalone `built-ins/Proxy` regardless of how many traps are wired, and it
also hides shorthand-defined iterator protocols (`{ next() {…} }`,
`return()`/`throw()` on manual iterators), shorthand members in `with`
targets, spread/`Object.assign` copies, and for-in/`Object.keys` enumeration
of method-bearing literals.

## Root cause

Two divergent lowerings of the same literal:

- **Struct path / accessor path**: methods become closures
  (`emitObjectMethodAsClosure`, `literals.ts:640+` has a full
  MethodDeclaration arm that compiles the method as a callback closure and
  `__extern_set`s it, incl. well-known-Symbol computed names, #1433/#1695).
- **Any-context `$Object` route** (`compileObjectLiteralAsExternref`,
  `literals.ts:205+`): iterates props, handles `PropertyAssignment` +
  accessors, and **falls through on MethodDeclaration** — the method exists
  only in the compiler's static member-resolution tables, never in the
  runtime `$PropMap`.

Static call/value sites resolve through the compile-time table (why `h.m()`
works); every runtime-keyed consumer (`__extern_get`, `Object.keys`,
`__proxy_create`, spread, for-in) sees a hole.

## Fix

In `compileObjectLiteralAsExternref`, add the MethodDeclaration arm by
**reusing the existing closure-materialization used at `literals.ts:640+`**
(same helper, same `__extern_set` store, same well-known-Symbol handling via
`__box_symbol` for `[Symbol.iterator]() {}`-style names). Do not invent a
second lowering. Key requirements:

1. The stored value must be the SAME closure value the static access-site
   path resolves to (one closure per literal-evaluation, not per read) —
   otherwise `h.m === h.m` across a runtime and a static read diverges
   (identity: coordinate with #2963/#3037; storing the closure once at
   literal construction satisfies it).
2. Generator/async shorthand methods (`*gen() {}`, `async m() {}`) follow
   whatever the arrow-property lowering does for generator/async function
   expressions today; if unsupported, keep the current behavior for those
   two shapes and note it — do NOT block the plain-method fix on them.
3. `get`/`set` accessors are already handled (probe passes) — untouched.
4. gc/host lane: verify the host-lane any-context literal already stores
   shorthand methods (host object literal) — the fix is likely
   standalone-visible only, but apply it lane-agnostically at the `$Object`
   route so both stay symmetric.

## Acceptance criteria

1. All four probe divergences above flip (`h[k]` → callable, `Object.keys`
   → 1, both Proxy shorthand handlers fire).
2. `built-ins/Proxy` standalone: measurable pass-rate jump with ZERO trap
   changes (re-run the #1355 acceptance files — `get/return-trap-result.js`
   class).
3. A shorthand `{ next() {...} }` manual iterator drives `for-of` standalone.
4. Full merge_group + standalone floor green (object-literal lowering is
   broad-impact).

## Effort estimate

M, Opus-executable (the arm to copy exists 300 lines below the skip site).
Filed from the Fable audit because it is the **highest-leverage single fix in
the Proxy domain** — land it BEFORE any further trap/invariant work (#3031
P3–P5, K2), then re-measure the standalone Proxy baseline so those slices
are scoped against honest numbers.

## Resolution (2026-07-09, dev-proxy)

**Verify-first note (the spec was partly stale):** the "Fix" section assumed
every method-shorthand literal already reaches
`compileObjectLiteralAsExternref`. Empirically (DEBUG trace on current main),
only the **Proxy-handler** literal does — via the no-resolvable-struct
fallback (`compileObjectLiteral` line ~1296). A bare `const h: any = { m() {}
}` instead routes to the **struct path** (`compileObjectLiteralForStruct`,
anon-struct), because its inferred type maps to a struct even though the local
is `any`/externref. So the fix has **two** parts:

1. **The arm** (the keystone) — a `MethodDeclaration` arm in
   `compileObjectLiteralAsExternref` (`src/codegen/literals.ts`) that
   materializes a plain-named method (`identifier`/`string`/`numeric` key) as a
   runtime own-property closure via `emitObjectLiteralMethodFn` + `__extern_set`,
   mirroring the sibling arm in `compileObjectLiteralWithAccessors`. This alone
   fully unblocks the standalone **Proxy substrate** (handlers reach this route).
2. **The routing gate** — the standalone any-context divert gate now also accepts
   plain-named method shorthand (new `isPlainNamedMethodDeclaration` predicate),
   so `const h: any = { m() {} }` builds as an open `$Object` (fixing `h[k]` and
   `Object.keys`) instead of an anon struct. Gated exactly like the data-prop
   route (explicit any/unknown/object contextual type, standalone-only) — the
   no-contextual-type case stays on the struct path (the #1897 −45 / #1901 −116
   protection is preserved). Computed/well-known-symbol method keys are excluded
   (they still route upstream for Symbol-boxing).

**Re-measured Proxy trap delta (standalone, method-shorthand handlers):**

| | before (origin/main) | after |
| --- | --- | --- |
| method-shorthand handler traps firing | **0 / 12** | **11 / 12** |

The 11 that now fire: `get`, `set`, `has`, `deleteProperty`,
`getOwnPropertyDescriptor`, `ownKeys`, `defineProperty`, `getPrototypeOf`,
`setPrototypeOf`, `isExtensible`, `preventExtensions` — i.e. **full parity with
the arrow-property handler form**, which the #1355 suite already exercises.
The 12th, **`apply`**, remains dark for method-shorthand AND arrow handlers
alike (both emit invalid Wasm on the standalone dynamic-apply-of-externref-callee
path) — a **pre-existing** gap, not a handler-materialization issue. It is the
#3031 **K1/K2** (inbound marshalling + `__construct_dispatch`/dynamic-apply)
work; #3099 does not touch it.

**Scope handed to #3031:** P-slices should now be scoped against **11/12
shorthand-handler parity**, not "traps dark". The remaining standalone Proxy
pass-rate levers are: `apply`/`construct` dynamic dispatch (K1/K2), `Reflect.*`
wiring (S1), revocable synthesis (S0), and the §10.5 result-invariants (slice G)
— none blocked on handler shape any longer.

Regression validation: `tests/issue-3099.test.ts` (12 cases, standalone + host
compile), plus scoped suites all green — `object-literals`,
`object-literal-getters-setters`, `issue-1901`, `issue-1897`, `issue-1433`,
`issue-1695(+propkey)`, `issue-2126`, `accessor-side-effects`, the `issue-1355`
Proxy series (a–f), `iterators`, `issue-2162-iterators` (59 Proxy/iterator tests
pass). The two pre-existing red suites (`proxy-passthrough` — obsolete #498
tier-0 pass-through expectations; `issue-1897` — a diff-test262 tooling
meta-test) fail identically on base origin/main and are unrelated.
