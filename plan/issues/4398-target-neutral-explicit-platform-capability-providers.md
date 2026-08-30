---
id: 4398
title: "Target-neutral explicit platform capabilities with swappable providers"
status: done
created: 2026-08-13
updated: 2026-08-30
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

## 2026-08-30 follow-up lock — duplicate import authentication

This Sol-authored repair is based on refreshed exact `main`
`01fb67624e2f645b7e92dd9f8e47478e3face9ba` and belongs to #4398 rather than
the #3520 C36–C39 export-provenance stack. Implement it on
`codex/4398-capability-duplicate-auth`. The open-PR/worktree audit found no
owner for `src/capability-registry.ts` or the focused #4398 test; do not touch
the callable/publication, Program-ABI, `from-ast`, propagation, selection,
host-bridge, or C36–C39 files being changed by parallel sessions.

### Deterministic false-pass

The emit-time standalone/WASI leak backstop intentionally collapses duplicate
imports to one `(module,name)` diagnostic. Its timer, DOM, and DOM-interaction
exemptions then search the module for *any* same-named entry for which
`isValidatedPlatformCapabilityImport(...)` returns true. A finished module
containing one exact `env.__timer_set_timeout` import beside a malformed import
with the same module and name therefore produces one leak row, but the exact
sibling authenticates the row and removes it. The malformed duplicate reaches
the binary without a leak diagnostic. Direct mutation is in scope for this
backstop: it exists specifically to catch imports that bypass normal registry
insertion or retain stale bookkeeping.

Clock already closes this boundary by requiring exactly one `env.__date_now`
entry. Timer, DOM, and DOM-interaction imports must have the same exact
cardinality property without changing leak diagnostic deduplication.

### Authorized implementation

Own only:

- this issue record;
- `src/capability-registry.ts`; and
- `tests/issue-4398-capability-registry.test.ts`.

Strengthen `isValidatedPlatformCapabilityImport(...)` itself. Before accepting
the candidate import contract, require the module to contain exactly one import
whose module and name equal the selected entry, and require that sole occurrence
to be the entry at `importIndex`. Count every descriptor kind and signature in
that same-name census: one exact function plus one malformed function, global,
or other descriptor is ambiguous and must reject. Keep the existing provider,
environment, namespace, kind, parameter, and result validation byte-for-byte
after the uniqueness guard.

Do not scan only registry-matching entries, choose a preferred occurrence,
deduplicate before validation, repair or remove imports, add provenance, change
`scanForLeakedHostImports(...)`, or edit the `.some(...)` callers in
`src/codegen/index.ts`. Their existing search becomes safe because every
same-name candidate returns false when the census is not exactly one. Imports
with a different module or different name remain independent.

### Required focused matrix

Use real `WasmModule` import/type descriptors and the exported registry
validator. For the timer, one base DOM contract, and one DOM-interaction
contract, prove:

1. one exact import authenticates;
2. exact plus malformed same-name import authenticates neither occurrence;
3. two exact same-name imports authenticate neither occurrence; and
4. a malformed-only import remains rejected.

For at least the timer mutation, combine the existing leak scanner with the
same `.some(...)` predicate used by the production exemption: require the
deduplicated leak row to remain present because no occurrence authenticates.
Add a different-name sibling control proving uniqueness is scoped to the exact
`(module,name)` pair. Keep the #4577 unique/duplicate clock controls unchanged,
and preserve the existing compiled timer/provider/runtime tests in this file.
No synthetic success based only on counts is acceptance evidence: assert the
candidate indices, exact names, signatures, per-occurrence validator results,
and final leak row.

### Acceptance and workflow

Run the focused #4398 and #4577 suites, TypeScript 7 and 5, targeted
Prettier/Biome, `git diff --check`, host-import policy, issue integrity, and
applicable layering/oracle ratchets. Before every heavy command, require a
finite, non-negative one-minute load strictly below `logical cores - 2`.
Immediately before the signed commit run both LOC and function regrowth
ratchets, then run complete precommit and prepush hooks without bypass. No
baseline or hook exception is authorized.

A bounded implementation may be delegated only after this lock. Before the PR
is marked ready, a fresh independent Sol must review the exact pushed SHA for
the three capability families, the exact-cardinality boundary, non-vacuous leak
retention, different-name control, unchanged clock behavior, and non-overlap
with active migration lanes. Any later push invalidates that approval.
