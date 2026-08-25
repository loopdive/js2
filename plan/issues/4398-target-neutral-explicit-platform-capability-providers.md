---
id: 4398
title: "Target-neutral explicit platform capabilities with swappable providers"
status: done
created: 2026-08-13
updated: 2026-08-18
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop, linking, compiler, platform
language_feature: host-capabilities
goal: platform
sprint: 78
parent: 4395
depends_on: [4396]
required_by: [4399]
horizon: l
related: [1653, 1772, 2512, 2514, 2527, 2603, 2634, 2698, 2736, 2783, 3526, 4382]
---
# #4398 — Explicit platform capabilities with swappable providers

## Objective

Generalize the proven `node:fs` provider shape into a target-neutral capability
contract. Source code names standard APIs; compilation produces a typed
capability requirement; linking selects a JS adapter, WASI adapter, or another
Wasm provider without changing source semantics.

This issue is about platform authority, not ECMAScript semantic fallback.

## Design constraints

- Use standard source APIs (`process.*`, `node:*`, Worker messaging, Web APIs,
  and WIT interfaces), not js2wasm-only globals.
- Declare the real capability namespace/member and a versioned ABI.
- Separate source-level types from the flat boundary ABI and generate the
  translation adapter where necessary.
- A portable module may import capabilities; every import must be explicit,
  explainable, and satisfiable by the selected provider set.
- Capability availability must fail closed. A missing provider never becomes a
  null stub, empty result, or late instantiation surprise.

## Acceptance criteria

- [x] A registry maps typed #3526 host capabilities to namespaces, signatures,
      permissions, supported environments, and provider adapters.
- [x] `--link <namespace>` is generalized beyond its current WASI-only control
      without changing existing `node:fs` output.
- [x] One additional capability family has two interchangeable providers, at
      least one of which is not a JavaScript semantic fallback.
- [x] #4382 explains required capabilities and the selected/missing provider.
- [x] WIT projection is generated from the same capability record where the
      Component Model can represent the boundary.
- [x] Capability tests cover link failure, signature/version mismatch, and
      correct behavior through each provider.

## Out of scope

- Shared semantic-runtime packaging owned by #2514.
- Making DOM functionality available in a host that provides no DOM.
- Treating arbitrary ambient JS globals as declared capabilities.

## Implementation progress — 2026-08-13

- `src/capability-registry.ts` defines frozen, versioned contracts for clock,
  randomness, console, timers, and module loading. Clock and randomness each
  project onto both a JS-host provider and a WASI Preview 1 provider.
- Successful compiler results expose provider-neutral requirements including
  permission names, selected/compatible providers, concrete import namespaces,
  and signatures derived from the emitted Wasm types.
- The same registry validates ABI namespace/version, selected provider,
  execution environment, import namespace, and exact clock/randomness function
  signatures. Deterministic diagnostics make provider drift fail-loud in tests.
- Focused tests prove JS and WASI builds retain the same capability IDs/ABI
  versions while selecting different providers, and detect version, signature,
  and environment mismatches.
- `CompileResult.explanation` is a schema-versioned, deterministic projection of
  the frozen target profile, import-class totals, capability requirements and
  diagnostics, and export-boundary policies. `js2wasm explain <file> [--json]`
  consumes that exact record and writes no build artifacts.
- `link: [namespace]` / `--link <namespace>` now retains an explicitly provided
  namespace on every target. A standalone module can therefore declare a
  provider edge without it being mislabeled as an implicit JS-host leak. The
  special `node:fs` memory/std-IO rewrite remains gated to WASI, and its full
  regression suite remains byte/behavior compatible.
- WIT generation consumes the same frozen `PlatformCapabilityRequirement`
  records used by adapter validation and explain output. Representable function
  contracts are emitted with their ABI namespace/version, permissions, selected
  provider, concrete provider import, and signature; capability imports are not
  re-derived from a second registry or duplicated by the raw-import projection.
- End-to-end tests count the real JS-host clock/randomness calls, execute the
  same source through deterministic WASI `clock_time_get`/`random_get`
  providers, and prove that omitting the declared WASI provider fails during
  linking. Registry tests separately reject environment, namespace, ABI-version,
  and exact-signature drift.

Follow-up: source-site provenance and rewrite hints remain broader #4382
explanation work; they do not change the completed capability/provider ABI.
