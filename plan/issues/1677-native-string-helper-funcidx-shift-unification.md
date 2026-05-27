---
id: 1677
title: "Signature A: native string helper func-index shift unification (__str_flatten/__str_to_extern call[k] type mismatch under --target wasi)"
status: ready
created: 2026-05-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, import-bookkeeping
language_feature: classes, closures, number-formatting, typed-arrays, template-literals
goal: standalone-mode
sprint: Backlog
owner: senior-developer
parent: 1666
related: [1666, 1664, 1665, 1335, 1470]
note: "Carved out of #1666. Signature B (unbound late global) re-landed safely via PR #684; Signature A is the genuine #618 shift-regime hazard and needs an architect-level fix."
---
# #1677 — Native string helper func-index shift unification (Signature A of #1666)

> Carved out of #1666. **Signature B** (unbound late global `0xffffffff` in
> Number.prototype formatters) was re-landed safely via PR #684 with a
> mode-agnostic `stringConstantExternrefInstrs` fix that touches no func-index
> bookkeeping. **Signature A** — the native string helper `call[k] expected
> <T>` type mismatch — is the genuine #618 shift-regime hazard and is the
> subject of this issue.

## Problem

Under `--target wasi` (auto `nativeStrings`), several constructs emit a
`.wasm` that **fails `WebAssembly.compile` validation** because the native
string helpers `__str_flatten` / `__str_to_extern` are called with arguments
of the wrong Wasm type:

```
Compiling function #N:"__str_flatten"  failed: call[k] expected type <T>, found <U>
Compiling function #N:"__str_to_extern" failed: call[0] expected type f64, found local.get
```

Reproducers (probes live in `.tmp/probes-1666/`):

| Probe | Error |
|---|---|
| `array-map` (`.map().filter().reduce()`) | `__str_flatten` call[0] expected i32, found local.get |
| `class` (`extends`/`super`) | `__str_flatten` call[1] expected externref, found i31 |
| `closure` (captured local) | `__str_flatten` call[0] expected i32, found local.get |
| `str-replace-re` | `__str_flatten` call[1] mismatch |
| `str-template` (`` `${x}` ``) | `__str_to_extern` call[0] expected f64, found local |
| `generator` | `__str_flatten` type error |

## Root cause (confirmed during #1666 investigation)

There are **two independent func-index shift regimes** that are not reconciled
with each other:

1. **Finalize-phase eager helper emission.** Native string helpers
   (`__str_flatten`, `__str_to_extern`, etc.) are emitted as DEFINED functions
   during the import-collection finalize phase
   (`finalizeUnifiedCollector` → `ensureNativeStringHelpers`). Later finalize
   blocks call raw `addImport`, which bumps `numImportFuncs` **without**
   shifting the already-emitted helper bodies' internal `call`/`ref.func`
   targets — so those targets become stale and resolve to wrong-signature
   functions.

2. **Compilation-phase late-import shift.** The lazy `__str_to_extern` bridge
   (`ensureNativeStringExternBridge`, emitted during function COMPILATION via
   `ensureLateImport` / `flushLateImportShifts`) operates under a *second*
   shift regime that overlaps with the first.

An incremental, finalize-scoped `addImport` shift (gated on a pinned helper
base so the default GC path is never touched) fixes ~6/8 probes (array-map,
class, closure, generator, numstr, uint8) **but** the
compilation-phase `__str_to_extern` bridge overlaps with that second shift
regime — `str-template` still fails, and gating the finalize shift to the
finalize phase alone regresses class/uint8.

## The #618 hazard (why this is NOT a localized fix)

This is exactly the failure mode that forced the **#618 revert** of PR #608.
#608 added an eager `fixupModuleFuncIndices(ctx, threshold, 1)` inside
`addImport`, gated only by `pendingLateImportShift === null &&
!suppressFuncIndexFixup` — **not** by target or `nativeStrings`. So it fired
in the default JS-host GC path. When late imports are added one-by-one
(outside the batched `flushLateImportShifts` route), it re-shifted `call`
indices in **already-emitted** function bodies, shifting away the `call` that
pushes `Math.abs`'s argument and leaving `f64.abs` with an empty stack —
**−3,931 test262 (29,355 → 25,743 pass)**, virtually all `assert.sameValue`
calls in the harness.

Any fix for Signature A that introduces a func-index shift inside `addImport`
MUST NOT be able to fire on the default GC trampoline path. The naive
"shift on addImport" approach is precisely what regressed.

## What an architect-level fix looks like

The correct full fix **unifies the two shift regimes** so a helper emitted in
either phase (finalize-phase eager helper emission vs. compilation-phase
`flushLateImportShifts`) is reconciled consistently, without double-shift and
without ever re-shifting a body already emitted with final indices. Candidate
shapes to evaluate:

- **Single deferred-resolution pass.** Emit ALL helper `call`/`ref.func`
  targets as symbolic references (not concrete indices) during both phases,
  and resolve them in one final pass once `numImportFuncs` is frozen. This
  removes the "shift already-emitted bodies" problem entirely — nothing is
  shifted because nothing was concrete until the end.
- **Reserve a fixed helper import band.** Pre-allocate the native-string
  helper indices at a known base *before* any user function is compiled, so
  later `addImport` calls never push into the helper band. The finalize-phase
  helpers and the compilation-phase bridge would both target the reserved
  band; no shifting needed.
- **Pin + suppress on the default path.** Whatever shift exists must be hard-
  gated on `ctx.wasi || ctx.standalone` (or `ctx.nativeStrings`) AND on a
  pinned helper base, so it is provably inert on the default GC path. This is
  the minimum bar to avoid re-triggering #618.

Each option needs the architect to trace the exact ordering of
`finalizeUnifiedCollector`, `ensureNativeStringHelpers`,
`ensureNativeStringExternBridge`, `ensureLateImport`, `flushLateImportShifts`,
and `addImport` and choose the one that does not introduce a re-shift hazard.

## Investigation starting points

- `src/codegen/native-strings.ts` — `__str_flatten`, `__str_to_extern`
  emitters; `ensureNativeStringHelpers`, `ensureNativeStringExternBridge`.
- `src/codegen/registry/imports.ts` — `addImport`, `fixupModuleFuncIndices`
  (the #608 regression site).
- `src/codegen/expressions/late-imports.ts` — `ensureLateImport`,
  `flushLateImportShifts`, `shiftLateImportIndices`.
- `src/codegen/index.ts` — `finalizeUnifiedCollector`, `addUnionImports`
  (documents the "must also shift `ctx.currentFunc.body`" rule in CLAUDE.md).

## Acceptance criteria

1. All 6 Signature A probes (`array-map`, `class`, `closure`, `str-replace-re`,
   `str-template`, `generator`) compile to **valid**, instantiable modules
   under `--target wasi` and `--target standalone`.
2. **No regression on the default GC path** — the #618 `Math.abs` harness
   corruption MUST NOT recur. A default-mode `Math.abs` + string-concat
   snippet must validate, and CI test262 must hold the default-path pass
   count (the authoritative gate — the bisect that caught #608 was the
   merge-group test262 shards).
3. `tests/issue-1677.test.ts` covering each probe shape, both modes.
4. equivalence tests green in both modes.

## Out of scope

- Signature B (unbound late global) — already re-landed via PR #684 (#1666).
- Residual host-import leak elimination — #1664.
- Native generators shared `$Iterator` design — #1665.
- Pure-Wasm number→string lowering — #1335.
