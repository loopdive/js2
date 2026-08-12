---
id: 4301
title: "Hono router methods lose the private #routes brand at runtime"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, private-fields, modules
goal: npm-library-support
related: [1365, 4154, 4288, 4290, 4297, 4300]
---

# Hono router methods lose the private `#routes` brand at runtime

## Problem

The real Hono 4.12.16 workload now compiles to a 373,905-byte Wasm module and
the module validates. Construction and route registration advance through the
compiler gaps closed by #4288 through #4300, but the first router match fails:

```text
TypeError: Cannot read private member #routes from an object whose class did not declare it
```

Reproduce:

```bash
node tests/dogfood/hono-workload-harness.mjs
```

The measured compile took 19.445 seconds in the suspended worker checkout.

## Narrowed call path

```text
driver app.router.match(...)
Hono constructor
  this.router = new SmartRouter(...)
SmartRouter.match
  reads this.#routes immediately
  invokes RegExpRouter.add/match, which also read #routes
```

The failure is on the `SmartRouter` to `RegExpRouter` route, but the current
evidence does not yet prove which receiver performs the rejected brand check.
`src/codegen/property-access-dispatch.ts` reaches
`emitPrivateBrandPredicate`; the unresolved question is whether nested
`app.router.match(...)` threads the wrong receiver or a correctly selected
router instance carries the wrong class tag/struct representation.

## Suspended handoff (2026-08-09)

- Published handoff branch: `codex/npm-compat-handoff`.
- Last compiler commits on that branch: `3b995500757735` (conditional capture
  boxes) and `323a0689b0fded` (host array sort).
- Investigation worktree: `/private/tmp/js2-hono-private` on
  `codex/4301-hono-private-fields`, based at `7a50f7fd9a34fd`; it is clean and
  contains no uncommitted implementation or additional commit.
- Work was deliberately suspended before changing private-brand lowering.

Resume by reducing `App.router -> Router.match -> this.#routes`, then add one
nested `SmartRouter`/`RegExpRouter` case. Inspect the emitted method receiver
and runtime class tag before changing the brand predicate.

## Implementation checkpoint (2026-08-11)

The failure was receiver identity, not the private-brand predicate. A
variable-bound class expression has both a source-binding carrier and a
declaration-identity carrier. Structural method selection could choose the
former while the method body and its captured `this` expected the latter. A
private method was also allowed to enter inheritance/virtual-candidate lookup,
although private names are lexically bound and cannot be overridden.

Receiver resolution now canonicalizes public class-expression carriers, keeps
private methods tied to their lexical declaration, and selects a duplicate
captured-`this` alias only when both the receiver struct and method self ABI
match exactly. Ambiguous matches are rejected rather than guessed. Five focused
runtime cases cover anonymous-class fields, structural calls, private methods,
captured `this`, and same-spelled private methods in a subclass; the focused and
adjacent suites pass 30/30.

The unchanged Hono workload still compiles and validates, and it now advances
past the `#routes` TypeError. It reaches a distinct `illegal cast` in
`__closure_156` while evaluating the dynamic `r[method]` path inside
`#buildMatcher`. That next compiler defect is being tracked separately; this
issue remains open until the complete pinned route-matching differential can be
rerun.

## Acceptance criteria

- [ ] A reduced multi-module case identifies whether the receiver or its class
      representation loses the declaring class brand.
- [ ] The generic fix preserves the TypeError for genuinely foreign receivers.
- [ ] The pinned Hono workload completes route matching and agrees with Node.
- [ ] Existing private-field, imported-class and Hono regressions remain green.
