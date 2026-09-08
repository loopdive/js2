# Native string/value prepared-consumer implementation contract

Status: High-reviewed contract; implementation has not started. Grounded in
scanner checkpoint cf0026db2e926bf45c57204f6324fbae5fb168f7 (PR #5781).
This is a step toward public IR cutover, not a replacement for it.

## Required executable path

The source producer must lower a real source program equivalent to
`function parse(s: string): number { return +s; }` with exported `run`
calling `parse(" 42 ")`. The prepared consumer must execute its owned
unbox -> scanner dependency chain. Resource fixtures alone are insufficient.

An explicit standalone-native source selection enables statically string-typed
unary numeric conversion through existing externref coercion and provider-free
`js.number.unbox`. Absent selection preserves historical lowering. Reject
incompatible requested projections; do not fabricate dynamic-lowering hooks.

## Planning and ownership

Collect source-free demands across complete owner populations, semantic blocks,
async states and prepared runtime states. Retain occurrence, owner, allocation,
site, alias-resolved encoding and existing storage/materializer identities.
Preserve unknown metadata and missing versus present-undefined distinctions.

Extract layout-independent representation selection from the existing literal
planner. Preserve encoding-qualified interning, UTF8 byte versus UTF16 code-unit
thresholds, oversized materializers and internal chunks, lone surrogates, and
flatten's explicit UTF16 empty literal. Do not mutate sealed semantic IR or
runtime attachments. Acceptance owns per-use physical bindings.

Keep the exact issued NativeValueResourcePlan outside copied descriptive plan
data: freezePreparedIrValue does not preserve its authentication identity.

Split string types-first reservation from literal reservation, retaining the
existing combined API. Authenticate supplied type ownership and configuration
before mutation. In one transaction reserve types, imports, then literals,
flatten, scanner, values, remaining globals, program functions, vector helper
and startup. Freeze once, then fill and lower. Scanner and values must share
the exact issued plan and string pack.

Implement resolveString and closed-plan emitStringConst. Join supplemental
physical declarations to the same ProgramAbiMap before sealing, preserving
all semantic entries. Distinguish stable handles from final indices. Account
for exact owned function objects, not names. No-demand programs retain their
old allocation path, bytes and order.

Independent audit of the published checkpoint confirms two interface hazards:
`js.number.box` is host-only while native `js.number.unbox` and
`generator.number-box` have separate provider authorization; helper spelling
does not authorize admission. Also the literal pack's requested bindings omit
private oversized chunk globals. The materializer must expose an authenticated
complete internal function/global census, not derive ownership from requested
literals, names, aggregate counts, or successful ledger filling alone.

## Parallel lanes and live ownership gates

- Source admission: from-ast.ts, program-source.ts, program-preparation.ts and
  a dedicated source-admission test. The preparation file may overlap P;
  explicit ownership agreement is required before dispatch.
- Pure demand producer: new ir/program/native-string-value-demands.ts and
  dedicated tests. Exported interfaces must be frozen before implementation.
- Representation/materialization: string-literal-bodies.ts,
  native-string-literals.ts, new backend/wasmgc/program/native-string-values.ts
  and dedicated planning/materialization tests.
- Consumer integration: program-physical-plan.ts and program-consumer.ts,
  consumer execution and fresh-process replay tests, boundary activation.

C's existing prepared-async task owns dirty consumer/physical-plan changes in
the e042 worktree. No release has been received. Preserve that work; require
owner-executed reconciliation or an explicit scoped release. Do not overlay
the older host-only async implementation with the native implementation.

The isolated type-split worker is based on cf0026db, with verified upstream
claim `3518:native-string-types-split`. A dependency check found that this
scanner branch does not contain PhysicalModuleReservations.assertTypeReservation;
that method is present in sibling argument-vector checkpoint
e3beb06321582908aba303fbcdf236d4c7a468c2 (PR #5776). Resolve this dependency
explicitly before implementation; do not replace ledger authentication with a
name/descriptor heuristic or assume sibling commits are already ancestors.

## Completion evidence

Execute original and decoded prepared programs, with GVN and UTF modes,
aliases/startup, repeated execution, oversized literals and malformed exponent
semantics. Prove real program-body reachability into the owned native chain.
Add positive-first ownership, metadata, provider, missing-fill and extra-function
negatives; source-free fresh-process admission; unchanged synchronous parity;
and existing preservation denominators. Serialize heavy verification with the
active queue-regression diagnostic lane.

Public default cutover, full async-family materialization, general dynamic and
string operations, strict closure/direct retirement, and ABI30 planningSealed
getter witness remain required and unproven. This contract completes none of
those requirements by itself.
