---
id: 4567
title: "Make node:* builtin support member-explicit, provider-explicit, and fail-closed"
status: backlog
created: 2026-08-20
updated: 2026-08-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler, checker, runtime
language_feature: node-builtin-capabilities
goal: node-compatibility
sprint: Backlog
depends_on: [4419]
required_by: [4568, 4569, 4570, 4572]
horizon: m
es_edition: n/a
related: [1044, 2634, 4382, 4398]
origin: "2026-08-20 Node API compatibility and portability review"
---
# #4567 — Make `node:*` builtin support provider-explicit and fail-closed

## Objective

Replace the gap between “recognized Node module” and “runnable Node member”
with one compiler-owned registry. Every imported member must have an explicit
signature, semantic placement, target result, and runtime provider before
emission begins.

The registry describes the standard interface that the compiled module needs:
`node:fs::readSync`, `node:path::join`, and so on. It must not expose the name
or implementation details of a particular shim.

## Problem

`NODE_BUILTIN_MODULES`, typed function/class stubs, capability-map entries,
host adapters, and codegen registration currently describe overlapping but
different surfaces. Merely appearing in the recognized-module set does not
prove that a member has a faithful type, a provider for the selected target,
or any implementation at all.

Several generic paths still tolerate incomplete knowledge by producing an
opaque module object, returning `undefined`, or binding a null externref. That
turns an unsupported capability into a successful compile followed by a late
trap or wrong result. The compiler must be able to report `unknown`; inability
to classify a member is never evidence that it is supported.

## Registry contract

Each module/member entry records:

- canonical `node:` specifier and real Node export name;
- faithful TypeScript overloads and value/class/namespace shape;
- semantic placement: portable Wasm provider, declared host capability, linked
  runtime provider, unsupported, or unknown;
- providers available for JS-host WasmGC, standalone/WASI WasmGC, JS-host
  linear, and standalone/WASI linear;
- stable unsupported/unknown diagnostic code, explanation, and remediation;
- provenance linking the checker decision, prepared IR feature, emitted import,
  provider, and focused evidence.

The module list, checker declarations, import manifest, target legality gate,
and plan issue #4382, “Compiler-derived capability manifest and per-program
explain workflow,” must consume this record. They must not maintain independent
support tables.

## Import behavior

Apply the same decision to:

- named, default, and namespace ESM imports;
- `require("node:...")` and destructured CommonJS imports;
- `node:` and accepted bare-builtin spellings;
- single-source, multi-source, `compileFiles`, and `compileProject` entry points.

A dynamic module-object access whose member cannot be proven must remain
visible as `unknown` or require an explicitly selected dynamic provider. It
must not silently widen the whole module to a permissive externref surface.

## Acceptance criteria

- [ ] One registry owns every currently recognized Node module and the members
      js2wasm claims to type or execute; `NODE_BUILTIN_MODULES` is derived from
      it or removed.
- [ ] Every registered member has an explicit result for all four supported
      host/standalone and WasmGC/linear target lanes.
- [ ] Missing entries and indeterminate dynamic member reads produce a stable,
      source-located `unknown`/unsupported diagnostic before artifact emission.
- [ ] No registered import path can lower an unavailable member to `ref.null`,
      an empty object, `undefined`, or a generic no-op.
- [ ] Named, default, namespace, and CommonJS fixtures reach the same member
      decision through every compiler entry point.
- [ ] The emitted Wasm import uses the standard `node:<module>` interface and
      real member name; provider selection remains a link/runtime concern.
- [ ] The capability report in “Compiler-derived capability manifest and
      per-program explain workflow” (#4382) projects the same record without a
      second hand-maintained matrix.
- [ ] Negative tests contain positive controls proving that a supported member
      still links and executes in each applicable lane.

## Out of scope

- Implementing every Node builtin or export in this issue.
- Treating recognition, successful type checking, or successful emission as a
  compatibility result.
- Adding an implicit embedded JavaScript engine or dynamic compatibility
  fallback.
