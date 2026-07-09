---
id: 3114
title: "CodegenContext diet: 282 fields -> subsystem sub-contexts + one helper-memo registry for the 109 ensureXxx families"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: low
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1172, 3104, 3108]
---

# #3114 — CodegenContext diet

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`CodegenContext` (`src/codegen/context/types.ts`) now has **282 fields**
(#1172 counted 120 in April — **+135% in 10 weeks**); `FunctionContext` has 49. A large share of the growth is a repeating pattern: `src/codegen/` has
**109 distinct exported `ensureXxx` helper-emitter families**
(`ensureObjectRuntime`, `ensureNativeStringHelpers`, `ensureExnTag`,
`ensureAnyHelpers`, `ensureRegexRun`, `ensureWasi*`, …), and each one hand-
rolls the same memoization idiom — a nullable index/flag field (or several)
on `CodegenContext`:

```ts
if (ctx.objectRuntimeTypes) return ctx.objectRuntimeTypes;   // object-runtime.ts:177
if (ctx.nativeStrHelpersEmitted) …                            // native-strings
ctx.wasiFdWriteIdx / wasiProcExitIdx / wasiPathOpenIdx / …    // 6+ WASI fields
```

Every new helper adds 1–4 context fields; nothing distinguishes "core
compiler state" from "memo cell of one helper in one file". This is the god
object #1172 flagged (Slices F/G, unlanded), 2.4× worse now. 226 direct
`ctx.mod.*.push` sites also bypass any invariant point, but that
(ModuleBuilder) stays deferred — #2710's handle model is the real fix there.

## Fix (phased; design pass first — hence fable)

**Phase 1 — helper-memo registry (mechanical bulk win).** One field replaces
the long tail of memo cells:

```ts
// context/types.ts
helperMemo: Map<string, unknown>;   // key = "<module>:<helper>"
// helper side:
const memo = getHelperMemo<ObjectRuntimeTypes>(ctx, "object-runtime:types");
if (memo) return memo;
…
setHelperMemo(ctx, "object-runtime:types", result);
```

Migrate per helper family, ONLY the single-owner memo fields (a field read by
multiple modules is shared state, not a memo — leave it). Target: −80 to
−120 fields. Byte-identity: the memo value and check order are unchanged —
pure representation swap, provable per commit.

**Phase 2 — subsystem sub-contexts** (#1172 F/G re-grounded): group the
remaining coherent clusters behind nullable sub-objects — `ctx.wasi:
WasiCtx | null`, `ctx.nativeStr: NativeStringCtx | null`, `ctx.regex`,
`ctx.asyncSched` — with TS narrowing replacing scattered boolean flags.
One subsystem per PR, field-by-field within it.

**Phase 3 — write an ownership map** (doc in the issue/PR): every remaining
top-level field gets an owning module; fields with no identifiable owner are
flagged for #3110-style dead-code review. This map is the input for any
future context split and for FunctionContext (49 fields) if warranted.

## Safety story

Phase 1 is representation-only: same values, same check points, no emission
reorder — `prove-emit-identity check` IDENTICAL per family; `tsc --noEmit`
catches every missed read. Phase 2 is #1172's F/G recipe (narrowing improves
safety). The risk is subtle aliasing: a "memo" field that some OTHER module
mutates directly — the migration greps every field's write sites first, and
any multi-writer field is excluded (documented in the ownership map instead).

## Coordination

- #3108 (giant emitter decomposition) introduces per-subsystem emit-context
  objects — do Phase 2's clusters AFTER (or with) the corresponding #3108
  split so the boundaries agree.
- #2710 owns funcIdx representation — do not touch index-typed fields it is
  migrating (its handle types subsume several `*Idx` fields naturally).

## Estimated LOC delta

≈ −300 direct (field decls + scattered init), but the real deliverable is a
`CodegenContext` a reader can hold in their head: **< 120 top-level fields**
with named subsystems.

## Acceptance criteria

1. `CodegenContext` < 150 top-level fields after Phases 1–2 (stretch < 120).
2. IDENTICAL identity proof per migration commit.
3. Ownership map written (module → fields) for whatever remains.
4. No test262 regression.
