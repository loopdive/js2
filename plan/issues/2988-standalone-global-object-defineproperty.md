---
id: 2988
title: "Standalone defineProperty on the global object (~10, needs global-object own-property MOP)"
status: ready
sprint: current
priority: low
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
depends_on: []
related: [2965, 2907, 2984]
origin: "#2965 descriptor-cluster triage — follow-up class 5 (global-object receivers)"
---

# #2988 — standalone defineProperty on the global object

## Problem

Follow-up from #2965. ~10 tests do `defineProperty` on the global object
(top-level `this`) and fail on standalone.

## Status (corrected 2026-07-02)

**#2907 has landed** (upstream/main commit `fc61cf7d8`, PR #2406) — the
formal `depends_on: [2907]` blocker is cleared. But re-verification found
the underlying capability still doesn't exist: #2907 delivers well-known-global
**bare-value carriers** (read access to `globalThis`-scoped bindings), not a
**global-object own-property table**. Probing
`Object.defineProperty(globalThis, k, desc)` under `--target wasi` +
`strictNoHostImports` still compiles but leaks `env.__get_globalThis` +
`env.__extern_get` (+ box/unbox) — there is no reified global object with
own-property slots to define onto.

This is the **same substrate family as #2984** (standalone gOPD-on-builtin):
both need a real object-shaped MOP for a receiver that today is only
ad-hoc host-backed (builtin methods/constructors for #2984; the global
object for #2988). Read #2984's spec-seed (PR #2523) before scoping this —
the reification design there likely generalizes to the global object as a
degenerate case (one singleton receiver instead of N builtin receivers).

Re-scoped `ready` / `horizon: l` (was `blocked` / `m`) to reflect the real
remaining work. `depends_on` cleared since #2907 is not the active blocker.

## Acceptance

- `Object.defineProperty(globalThis, k, desc)` at top level defines a
  global own property observable by later reads / gOPD; measured flip count with
  zero regressions; gc/host byte-inert; zero `env::` leaks in standalone.
