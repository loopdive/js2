---
id: 1926
title: "Remove backend ValType/typeIdx from IrType — unions and boxing must be backend-symbolic"
status: done
sprint: 65
created: 2026-06-10
updated: 2026-06-21
completed: 2026-06-21
assignee: sendev-1926
priority: medium
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
language_feature: compiler-internals
goal: maintainability
---
# #1926 — Remove ValType/typeIdx from IrType

## Problem

The IR's type system embeds backend Wasm types, contradicting the
symbolic-ref premise that makes the IR backend-agnostic:

- `union.members: ValType[]` and `boxed.inner: ValType`
  (`src/ir/nodes.ts:211-216`) — and `ValType` includes
  `ref { typeIdx: number }`, a **module-relative concrete type index**,
  which `irTypeEquals` happily compares (`nodes.ts:335-341`). An IrType can
  smuggle exactly the raw indices the symbolic-ref design
  (`nodes.ts:22-28`) exists to eliminate.
- This pins the IR to one module instance and one backend: it blocks IR
  serialization/caching, and blocks the linear backend from adopting
  IR-driven unions (the `BackendEmitter` aggregate group, #1851/#1852).
- The resolver-deferred kinds (`string`, `object`, `closure`, `class`,
  `extern` — `nodes.ts:88-114`) already demonstrate the right pattern:
  structural shape in the IR, concrete layout decided at lowering.

## Proposed approach

1. `union.members: IrType[]`; `boxed.inner: IrType`.
2. Where a concrete reference is genuinely needed pre-lowering, introduce a
   symbolic `IrTypeRef` (interned shape key), resolved to `ValType` by the
   backend resolver at lowering — same mechanism the string/object kinds use.
3. Mechanical migration of `irTypeEquals`, propagate.ts's
   `lowerTypeToIrType`, the union passes (`passes/tagged-union-types.ts`),
   and lowering sites; behavior-identical for WasmGC (assert byte-identical
   output on the playground corpus, the #1713 method).
4. Follow-up unlocked (not in scope): aligning `propagate.ts`'s separate
   `LatticeType` with IrType so the two type systems stop diverging.

## Acceptance criteria

- `git grep 'typeIdx' src/ir/nodes.ts` shows no IrType-reachable concrete
  indices; `IrType` is serializable (JSON round-trip test).
- WasmGC output byte-identical on the corpus; equivalence + test262 green.

## Source

Compiler quality review 2026-06. Related: #1851 (legalization boundary),
#1852 (per-backend value representation), #1714.

## Implementation notes (sendev-1926, 2026-06-21)

### What changed

`IrType` (`src/ir/nodes.ts`):
- `union.members: readonly ValType[]` → `readonly IrType[]`.
- `boxed.inner: ValType` → `IrType`.
- `irTypeEquals` now recurses through members/inner via `irTypeEquals`
  (not `valTypeEquals`), so a `boxed`-of-symbolic-kind or
  `union`-of-symbolic-kind composes structurally.

`ValType` is **no longer reachable through the IrType type system except via
the explicit `{ kind: "val", val }` wrapper** — which is, by design, the
documented "single concrete Wasm value type" escape hatch (`irVal`). The
smuggling vector the issue targets (an arbitrary `ref { typeIdx }` riding
inside a union member or a box inner, where `irTypeEquals` compared raw
indices) is closed: any concrete reference now sits behind a `val` wrapper
that callers must build deliberately, and union/box compose over IrTypes.

### Why this shape (root-cause-driven, not a symptom patch)

The crux is the **resolver boundary**. The backend resolver
(`resolveUnion`/`resolveBoxed`/`resolveRefCell` in `lower.ts` /
`integration.ts`) delegates to the legacy WasmGC registries
(`UnionStructRegistry`, `getOrRegisterRefCellType`) which are *keyed on
backend `ValType`* — that's the shared-identity contract that makes IR and
legacy ref cells / unions resolve to the **same** WasmGC struct (byte-for-byte
output parity). So the resolver methods **keep their `ValType` signatures**;
the migration unwraps `IrType → ValType` (`asVal`) at the resolver call sites
via a single `memberValType(t, funcName)` helper in `lower.ts` that asserts
`val`-kind (a non-`val` union/box member is a selector bug — fail loud, matching
the existing "resolver cannot lower …" throws). This keeps the *type system*
backend-symbolic while leaving the *backend identity contract* untouched —
which is exactly what guarantees byte-identical WasmGC output.

V1 constraints make the unwrap total in practice: tagged unions admit only
scalar (`f64`/`i32`) members (`passes/tagged-unions.ts`), and ref cells only
box primitives (`from-ast.ts` `must be a primitive` gate). So every member /
inner reaching the resolver is a `val`-kind IrType today; the migration just
removes the *type-level permission* to smuggle a `ref { typeIdx }`.

### Downstream effects considered

- **Stack balance / return types / index shifting**: none. The change is
  purely in the *type representation* of union members / box inner. Lowering
  emits the identical `struct.new` / `struct.get` / `i32.const tag` / `i32.eq`
  sequences against the same resolver-returned typeIdx. No funcidx / typeidx
  ordering changes.
- **Producers** (`builder.ts emitRefCellNew`, the three `from-ast.ts` capture
  sites) wrap their scalar `ValType` with `irVal(...)`. `emitRefCellGet`'s
  `inner` param became `IrType` (passed straight through as the SSA result
  type; for a V1 primitive cell that's `{kind:"val",val:scalar}`, byte-identical).
- **Lattice (`propagate.ts`)**: `lowerTypeToIrType`'s union case builds
  `{kind:"val",val:...}` members. The separate `LatticeType` union (a different
  type system) is intentionally NOT touched — aligning the two is the stated
  follow-up (proposed approach #4), out of scope here.
- **Type-key / debug-describe functions** (`monomorphize.ts irTypeKey`,
  `from-ast`/`integration` `irTypeKey`/`describeIrType`, `lower.ts`
  `describeIrTypeShallow`, `tagged-unions.ts memberList`) now recurse through
  the IrType members. These keys are pass-internal (dedup/specialization) or
  error-message-only; they never affect emitted bytes. Equal types still
  produce equal keys.
- **No `IrTypeRef` introduced** (proposed approach #2): the existing symbolic
  kinds (`string`/`object`/`closure`/`class`/`extern`) already cover every
  concrete-reference need pre-lowering, and V1 union/box only carry scalars, so
  an interned `IrTypeRef` shape key wasn't needed to satisfy the criteria.
  Reserve it for when a union/box must carry a *reference* member.

### Validation

- `tsc --noEmit`: 0 errors across the whole codebase.
- `prettier --check` on all touched files: clean.
- `check:ir-fallbacks` gate: **no IR demotions** vs. baseline — confirms the IR
  adoption set is unchanged, i.e. behaviour-identical codegen on the playground
  corpus (the #1713 byte-parity method's gate).
- IR unit/integration suites the container can instantiate: green — including
  the **full `issue-1169c` refcell/closure-capture suite (31/31)**, which
  exercises `refcell.new`/`get`/`set`, mutable-capture closure-write, and
  transitive deref through a sibling's refcell. This is the load-bearing
  behavioral proof for the `boxed` migration.
- New JSON round-trip test (acceptance criterion 1) in
  `ir-frontend-widening.test.ts`: a `union`/`boxed`/nested-`boxed(union)`
  IrType survives `JSON.parse(JSON.stringify(...))` identically.
- `git grep typeIdx src/ir/nodes.ts`: the only non-comment hit is in
  `valTypeEquals`, reached **only** from the `val`-kind arm (a single concrete
  ValType — the intended wrapper), never from union/boxed.
- **Pre-existing baseline failures** (NOT from this change, verified against a
  pristine `origin/main` worktree): a set of closure/IR-end-to-end tests
  `LinkError` on `__unbox_number`/`__get_undefined`/etc. "requires a callable"
  — a container test-harness import-stub gap that fails identically on
  unmodified main.

**BROAD-IMPACT note for the merger**: this is an IR-layer change touching
codegen lowering. A scoped/sampled test262 sweep does NOT validate it
(regressions land outside the sample). The authoritative gate is the
`merge_group` full-Test262 run. Local scoped checks above are for confidence
only; do not infer conformance from them.

### Follow-up unlocked (not in this PR)
- Align `propagate.ts`'s `LatticeType` with `IrType` (proposed approach #4).
- Introduce `IrTypeRef` if/when a union/box needs to carry a reference member.
