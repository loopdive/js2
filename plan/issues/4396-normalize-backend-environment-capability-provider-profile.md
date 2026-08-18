---
id: 4396
title: "Normalize backend, environment, capability, provider, and value-interop policy"
status: done
created: 2026-08-13
updated: 2026-08-18
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, host-interop
language_feature: compiler-internals
goal: architecture
sprint: 78
parent: 4395
required_by: [4397, 4398]
horizon: m
related: [86, 1524, 1927, 2094, 2736, 2783, 2961, 3526, 3912, 4035, 4382]
files:
  - src/target-profile.ts
  - src/compiler.ts
  - src/codegen/context/create-context.ts
  - src/codegen/context/types.ts
  - src/ir/backend/legality.ts
  - tests/issue-4396-target-profile.test.ts
---
# #4396 — Normalize target policy into independent axes

## Problem

The compiler currently derives policy repeatedly from overlapping flags:
`target`, `platform`, `wasi`, `standalone`, `strictNoHostImports`,
`nativeStrings`, `link`, and `hostBridge`. Call sites frequently spell checks
such as `ctx.standalone || ctx.wasi || ctx.strictNoHostImports`, although those
conditions answer different questions:

- Which backend emits the module?
- Which execution environment will instantiate it?
- Are ambient JS imports permitted?
- Should semantics prefer a native or host-assisted provider?
- Does a JS caller need the value bridge?

Conflating them prevents using native semantics inside a JS environment and
makes removal of a semantic host import look like removal of JS interop.

## Scope

Introduce a single normalized, immutable target profile with explicit axes:

- `backend`: WasmGC or linear;
- `environment`: JavaScript, WASI, none, or honestly unknown for a legacy
  target whose host is not determined by the compiler;
- `capabilityPolicy`: ambient-JS permitted or explicit-only;
- `semanticProviders`: host-assisted permitted, native-first, or
  backend-defined during the compatibility phase;
- `hostValueInterop`: required, explicitly enabled, or off.

The first slice is behavior-neutral: legacy options normalize to their current
decisions, and existing booleans remain compatibility projections. Later
issues consume the typed axes rather than adding more compound predicates.

## Acceptance criteria

- [x] One pure resolver exhaustively maps every current target and strictness
      combination to a deeply immutable profile.
- [x] `gc`, `standalone`, `wasi`, and `linear` are represented without claiming
      knowledge the compiler does not have; unknown remains visible.
- [x] `buildCodegenOptions`, context creation, and IR target legality consume
      the profile or an exact projection of it.
- [x] Existing `CompileOptions` and CLI spellings remain source-compatible and
      generate byte-identical output for representative programs.
- [x] Tests prove that disabling semantic host assistance does not
      automatically disable the host value bridge.
- [x] New code has named predicates for the question it asks; it does not add
      another raw `standalone || wasi || strictNoHostImports` policy check.

## First landing

Start with the pure resolver, its truth-table tests, and behavior-neutral
integration into the shared compiler option resolver. Do not flip defaults in
this issue.

## Implementation progress — 2026-08-13

The first landing is implemented:

- `src/target-profile.ts` defines the frozen five-axis compatibility profile,
  preserves the exact WASI strict-gate escape hatch, and reports the legacy
  linear environment/provider policy as `unknown`/`backend-defined`.
- `src/compiler.ts` consumes the profile in the shared option resolver,
  target-capability validation, backend selection, and host-free preprocessing.
- `src/codegen/context/create-context.ts` consumes the same resolver for the
  strict import gate, native-string implication, linked namespaces, host bridge,
  standalone/WASI flags, and standalone RegExp setup.
- `tests/issue-4396-target-profile.test.ts` pins the truth table, internal/public
  projections, semantic-provider/value-interop independence, immutability, and
  byte-identical legacy defaults.

The typed profile now lives on `CodegenContext`. IR selection, preparation, and
integration project their capability facts through
`projectIrBackendTargetProfile` rather than reconstructing target/host policy
from compatibility booleans. The projection deliberately keeps JS value
interop independent from ambient host-import authority.

The follow-up native-first selector is also part of the normalized input. It
can choose native semantics in the JavaScript environment without changing
`capabilityPolicy` or `hostValueInterop`; the default remains byte-compatible.

The compatibility projection remains byte-for-byte covered. The broader
migration-focused verification now passes 67/67 tests across #4396-#4401 and
the legacy #1712 dynamic-dispatch suite. The completed normalization slice's
typecheck was recorded green when it landed.
