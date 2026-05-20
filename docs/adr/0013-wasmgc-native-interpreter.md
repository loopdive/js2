# ADR-013 — WasmGC-native interpreter as an opt-in fallback for source-at-runtime features

**Status**: Proposed
**Date**: 2026-05-20

## Context

ADR-010 establishes that `eval()` and `new Function(...)` are handled in two
ways: literal sources are folded at compile time, and non-literal sources
route to a host import. The negative consequence is that in standalone /
WASI mode, where no JS-capable host is available, dynamic `eval` simply
does not work. The same gap covers `with` (sloppy mode), runtime-generated
template source, and any other source-at-runtime case where the input string
is not known to the compiler.

Three alternative paths to close this gap have been considered.

**Embed a JS interpreter in every output module.** Rejected by ADR-002 and
ADR-004: it imposes a runtime size and cold-start tax on every deployed
program, including the majority that never use dynamic features. This is
the architectural shape Static Hermes takes — every Wasm output ships its
interpreter — and it is the cost we explicitly opted out of.

**Statically link QuickJS (Javy-style).** Feasible (~600 KB always-on),
but contradicts the no-bundled-engine positioning and introduces a
WasmGC ↔ linear-memory bridge with significant intrinsic cost: handle
tables to keep refs alive across the boundary, two cooperating GCs,
duplicated builtin implementations (one in our compiler, one in QuickJS),
and conversion thunks on every cross-call. The bridge tax is structural,
not framing-dependent — static linking does not eliminate it.

**Recursive js2wasm compilation on each eval call (#1066).** Spec-correct
but slow on the first call to any new source and requires shipping the
compiler in the deployment. Fine for some workloads, painful for others.

The remaining option is a **small JS interpreter written in TypeScript,
compiled by js2wasm itself**, producing WasmGC code that shares the same
heap, GC, and builtin set as the compiled program. Because the interpreter
is WasmGC-native, no bridge exists: interpreter and compiled code pass
the same `ref` values, object identity is automatic, and the builtin set
is shared rather than duplicated. Packaged as a separate component chunk
and gated behind a build flag, the interpreter ships **only when the
program opts in** (or when the static analyzer detects features that
require it), preserving the size and cold-start properties of programs
that do not use dynamic source-at-runtime features.

## Decision

Adopt a **lazy-loaded, opt-in WasmGC-native interpreter** as the
standalone-mode provider for the source-at-runtime family of features
(`eval`, `new Function`, sloppy `with`). The interpreter is:

- Written in TypeScript and compiled by js2wasm itself.
- Distributed as a separate WasmGC module (component chunk), not bundled
  into every output.
- Linked only when a build flag opts in (`--standalone-eval=interp`) or
  when static analysis detects use of source-at-runtime features
  (`--auto-interp`).
- Resolves the same host-import interface ADR-010 defines, so the
  call-site contract is unchanged.

The interpreter does **not** cover `Proxy`, `Reflect`, or dynamic
`import()`. Those are object-model and host-integration features, not
source-at-runtime features, and are tracked separately.

The interpreter shares the compiled program's heap and builtin set.
WasmGC `ref` values flow across the interpreter ↔ compiled boundary
without conversion. The interpreter does not implement its own
`Array.prototype.push` — it calls the same lowered builtin the
compiler emits.

## Consequences

Positive: the standalone-mode eval gap (ADR-010's negative consequence)
closes without bundling a third-party engine, without paying a per-module
size tax on programs that don't use dynamic features, and without the
WasmGC ↔ linear-memory bridge tax that a QuickJS option would impose.
Object identity, exception propagation, and builtin behavior are
automatically consistent across the dynamic/static boundary because both
sides operate on the same WasmGC heap. The interpreter doubles as a
large integration test for the static compiler — anything the compiler
miscompiles in the interpreter source breaks loudly at build time.

Negative: a second implementation of JavaScript semantics now lives in
the codebase. Semantics bugs can diverge between compiler and interpreter;
mitigation is differential testing on the overlap subset. The interpreter
itself must be written in a static-compilable subset of TypeScript
(no `eval`, no `Proxy`, no `with`), enforced by a dedicated CI lane.
Spec maturity starts at zero — QuickJS has had a decade of input
hardening that we do not inherit. Performance through the interpreter is
~20–100× slower than compiled code; this is acceptable because the
interpreter is a correctness/coverage path, not a hot path. A bespoke
ES parser (~5–10 KLOC TypeScript) must be written and maintained
separately from the build-time TypeScript-compiler parser; scoping the
bespoke parser to ES-only (no TypeScript syntax) and a fixed edition
keeps that surface small.

Neutral: this decision does not change ADR-002 or ADR-004. The default
output continues to ship no embedded interpreter. The interpreter is
opt-in, lazy, and separately versioned.

## Alternatives rejected

- **Bundled interpreter in every module** — rejected on the same grounds
  as ADR-004: regresses size and cold-start for the majority case.
- **Statically linked QuickJS / Javy** — rejected because the
  WasmGC ↔ linear-memory bridge tax is structural, not avoidable by
  framing. The dual-builtin and two-GC costs are real and persistent.
- **Recursive js2wasm compilation only (#1066)** — not rejected; retained
  as a complementary path for workloads where steady-state speed matters
  more than first-call latency. The two providers can coexist behind the
  same host-import interface.

## Related

- ADR-001 (Hybrid static–dynamic compilation): this is a concrete
  implementation of the dynamic fallback principle.
- ADR-002 (AOT + WasmGC over embed-a-runtime): unchanged; this decision
  extends ADR-002 rather than relaxing it, because the interpreter is
  opt-in and lazy, not bundled by default.
- ADR-004 (AOT over JIT/interpreter): the interpreter is an opt-in
  fallback, not a tier of the default compilation pipeline.
- ADR-010 (Dynamic eval via host import): this ADR adds a new standalone
  provider that satisfies the same host-import contract.
- Issue #1520: implementation plan.
- Issue #1066: alternative standalone provider via recursive compilation.
- Issue #1102: original proposal that listed an embedded interpreter as
  an option; this ADR refines that option to be WasmGC-native, lazy,
  and opt-in.
