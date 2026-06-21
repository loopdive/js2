---
id: 2088
title: "per-builtin representation scaffold (element accessor + coercion), starting with fromCharCode + join"
status: done
assignee: ttraenkler/cs-2088
completed: 2026-06-17
sprint: 63
created: 2026-06-11
updated: 2026-06-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: core-semantics
related: [2122, 1968, 1998, 2074, 2075]
origin: "2026-06-11 analysis program (report 05 §2c); stub 08-A3"
---

# #2088 — every builtin re-derives element-load + ToString + null handling per representation

## Problem

Each builtin re-implements element access and coercion for each
representation (host vec / native string / standalone any). join alone
bred 4 issues (#1968, #1998, #2074, #2075); fromCharCode bred #2122 (ex-#1955) with
the single-arg bug copied independently into each of its 4 paths.

## Root cause

No shared scaffold parameterized by representation; builtin registration
is scattered across 3 scanner sites (declarations.ts:545/1164,
index.ts:1035/7258); registry/imports.ts is underused.

## Fix direction

A `defineBuiltin(name, {elementKinds, lower})` scaffold supplying the
element-load/ToString/null-handling matrix once; migrate join +
fromCharCode first (highest bred-bug density), then repeatable per
builtin. Full analysis: plan/log/analysis-2026-06/05-structure-review.md
§2c.

## Acceptance criteria

- join + fromCharCode served by one definition each across host/native/
  standalone; their 5 historical issue test suites green
- Adding a deliberate bug to the shared lowering fails all lanes

## Dupe check

The 5 symptom issues are filed/done; no issue owns the scaffold. New
(analysis program).

## Implementation (2026-06-17, cs-2088)

### What

New module `src/codegen/builtin-scaffold.ts` owns the shared
element→string concat machinery **once**, parameterized by a `StringRepr`
strategy:

- `StringRepr` — the minimal per-representation seam: `concat(a,b)`,
  `literal(value)`, `resultType`. Two concrete reprs:
  - `hostStringRepr` — `wasm:js-string` `concat` builtin + `string_constants`
    globals, result `externref`.
  - `nativeStringRepr` — pure-Wasm `__str_concat` + inline `$NativeString`
    literals, result `(ref $AnyString)`, **zero host imports**.
- `emitStringJoinFold(ctx, fctx, repr, locals, elemToStr)` — the canonical
  `i==0 ? elem : concat(concat(result,sep),elem)` loop, shared by the host
  and native `join` lanes.
- `emitVariadicStringConcat(repr, parts)` — left-to-right fold of N argument
  strings, shared by the host **and** native `fromCharCode`/`fromCodePoint`
  lanes.
- `allocJoinFoldLocals` — allocates the fold locals with `repr.resultType`.

Migrated call sites:
- `compileArrayJoin` (host, `array-methods.ts`) → `hostStringRepr` +
  `emitStringJoinFold`.
- `compileArrayJoinNative` (`array-methods.ts`) → `nativeStringRepr` +
  `emitStringJoinFold`.
- `String.fromCharCode` / `String.fromCodePoint`, all four arms
  (`expressions/calls.ts`) → one `compileFromCharCodeFamily` helper that
  builds one `part` per argument and folds via `emitVariadicStringConcat`.

`compileArrayJoinExtern` (`__array_join_any`) is **intentionally not**
routed through the scaffold: it is a single host delegation with no
per-element matrix, so it never bred a drift bug — nothing to drift.

### Why this satisfies "a bug in the shared lowering fails all lanes"

The element→string *matrix* (f64 sNaN sentinel → "", boolean → "true"/
"false", externref → `__extern_join_str`, native number → `number_toString`)
is genuinely element-type- and representation-specific, so it stays inline
as the caller-supplied `elemToStr` / `parts`. What every lane shares is the
**fold structure** (separator placement, empty-array fallback, left-to-right
concat order) — exactly the part that was copied and drifted (#1968 #1998
#2074 #2075 #2122 #1955). By making that structure the *only* implementation
both reprs call, a regression in it breaks every lane. Verified by injecting
two deliberate bugs:
- drop the last `part` in `emitVariadicStringConcat` → all 4 fromCharCode/
  fromCodePoint lanes (host+native × both fns) fail;
- drop the separator in `emitStringJoinFold` → both join lanes (host +
  standalone, string[]/number[]/default-sep) fail.

### Downstream-effect analysis (stack/index hazards considered)

- **Stack typing**: native `parts` leave `(ref $NativeString)`; `__str_concat`
  is typed over `$AnyString` and `$NativeString <: $AnyString`, so no explicit
  cast is needed (matches the pre-refactor inline code). `repr.resultType` for
  the native lane is `(ref $AnyString)`; a single-arg fromCharCode returns the
  raw `$NativeString` which is stack-valid as its supertype — unchanged from
  before.
- **Late-import index shift (#1384/#1984 class)**: `compileFromCharCodeFamily`
  compiles each argument into a buffer registered in `ctx.liveBodies` so a
  late import added while compiling a *later* argument still shifts indices
  baked into *earlier* buffers. After the parts are spliced into `fctx.body`
  (which every future `flushLateImportShifts` already walks), the buffers are
  **removed** from `liveBodies` — otherwise the same instruction *objects*
  would be shifted twice (the shift dedup keys on array identity, not
  instruction identity).
- **host fromCharCode multi-arg**: `addStringImports(ctx)` is still called
  before the fold so the `concat` import exists when `hostStringRepr` resolves
  it. The nativeStrings post-marshal (`__str_from_extern`) is preserved.

### Tests

`tests/issue-2088.test.ts` — 13 lane-coverage tests (host join, standalone
join, host fromCharCode/fromCodePoint, native fromCharCode/fromCodePoint,
multi-arg variadic). All 5 historical suites (#1998 #2074 #2122 + #1968/#1997
within them) stay green; broad join/string equivalence suites (119 tests
total across the affected suites) green. tsc + prettier clean. The array-
methods.test.ts / stdlib.test.ts `.at()`/`slice`/`splice` failures observed
during dev are pre-existing harness gaps (missing `__box/__unbox_number`
stubs) and reproduce identically on the branch base — not regressions.
