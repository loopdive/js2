---
id: 3106
title: "Central host-import signature registry: kill 514 inline ensureLateImport signature re-declarations"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: medium
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
depends_on: [2710]
related: [3104, 1839]
---

# #3106 — Host-import signature registry

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`ensureLateImport(ctx, name, params, results)` has **514 call sites** across
`src/codegen/` (calls.ts 134, property-access.ts 52, new-super.ts 34,
array-methods.ts 32, assignment.ts 29, index.ts 27, object-ops.ts 22, …).
Each site re-declares the import's Wasm signature inline:

```ts
const externGetIdx = ensureLateImport(
  ctx,
  "__extern_get",
  [{ kind: "externref" }, { kind: "externref" }],
  [{ kind: "externref" }],
);
flushLateImportShifts(ctx, fctx);
```

There are **1,463 `__extern_*` textual references** across 51 files for ~20
distinct import names (`__extern_get` 481, `__extern_set` 218,
`__extern_get_idx` 140, `__extern_length` 113, `__extern_is_undefined` 109,
`__extern_method_call` 69, `__extern_has` 59, …). Consequences:

1. **Signature drift is unchecked** — two sites can (and historically did)
   declare different signatures for the same import name; whichever runs first
   wins, the second gets a mismatched funcIdx. Nothing diffs them.
2. ~5 lines of boilerplate × 514 sites ≈ 2,500 LOC of pure re-declaration.
3. The paired `flushLateImportShifts` call is easy to forget (a known bug
   pattern in the late-import family, see #1839 and the #2710 catalogue).

## Fix

Single typed table + thin wrapper in `src/codegen/registry/imports.ts` (the
registry module already exists — 417 LOC):

```ts
export const HOST_IMPORT_SIGS = {
  __extern_get: { params: [EXTERNREF, EXTERNREF], results: [EXTERNREF] },
  __extern_set: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [] },
  __extern_length: { params: [EXTERNREF], results: [F64] },
  // … every recurring name, harvested mechanically from the 514 sites
} as const satisfies Record<string, HostImportSig>;

export function ensureKnownImport(
  ctx: CodegenContext,
  fctx: FunctionContext | null,
  name: keyof typeof HOST_IMPORT_SIGS,
): number | undefined {
  const s = HOST_IMPORT_SIGS[name];
  const idx = ensureLateImport(ctx, name, s.params, s.results);
  if (fctx !== undefined) flushLateImportShifts(ctx, fctx); // preserve today's pairing
  return idx;
}
```

Migration: mechanical, per-file — each
`ensureLateImport(ctx, "<known name>", […], […])` + adjacent
`flushLateImportShifts` pair becomes one `ensureKnownImport` call.
**Harvest step first**: script-extract all 514 (name, params, results)
triples; any name with >1 distinct signature is a **finding** (latent bug) —
report it, do not silently unify (behavior-preservation rule).
One-off names with a single site can stay on raw `ensureLateImport`.

## Safety story

Byte-identity provable: the wrapper performs the identical
`ensureLateImport` + `flushLateImportShifts` sequence with identical
arguments, so import order and indices are unchanged.
`scripts/prove-emit-identity.mjs` baseline → migrate one file → `check`
IDENTICAL → next file. Sites where today's code does NOT call
`flushLateImportShifts` after `ensureLateImport` must use a no-flush variant
(`ensureKnownImportNoFlush`) — do NOT add flush behavior during migration
(that changes shift timing and can move indices).

## Dependencies

**Hard dependency on #2710 sequencing**: #2710 (in-progress) is re-plumbing
late-import index resolution (`late-imports.ts`, `registry/imports.ts`).
Land this AFTER #2710's producer slices to avoid double-churn in the same
files — the registry table is then also the natural single place for #2710's
handle-based resolution to hook into.

## Estimated LOC delta

≈ **−1,800 to −2,200** (4–5 lines saved × ~450 migratable sites), plus the
type-checked `keyof` closing the signature-drift bug class.

## Acceptance criteria

1. Harvest report: every recurring import name has exactly ONE signature (or
   discrepancies filed as separate bugs).
2. `prove-emit-identity check` IDENTICAL per migrated file.
3. ≥ 400 of the 514 sites migrated; remaining raw sites are single-use names.
4. No test262 regression.
