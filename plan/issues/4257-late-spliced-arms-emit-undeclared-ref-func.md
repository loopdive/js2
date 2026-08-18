---
id: 4257
title: "Late-spliced `__extern_get` arms emit `ref.func` after the declaration scan — `undeclared reference to function #N`"
status: done
completed: 2026-08-09
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
goal: es5
related: [4248, 4256, 2963, 2175, 1916, 2043]
loc-budget-allow:
  # +5 lines at each of the two module drivers: the additive re-declaration
  # call plus the comment saying why it must sit after the last body FILL and
  # before dead-elim. The scan itself is the pre-existing function.
  - src/codegen/index.ts
  # The `additive` option on `collectDeclaredFuncRefs` (one parameter, one Set
  # seed) plus the doc comment recording why a union — never a replace — is
  # required: two callers hand-push indices this scan cannot see.
  - src/codegen/class-bodies.ts
func-budget-allow:
  # The re-declaration call is wired into BOTH module drivers.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4257 — a body-only `ref.func` is a validation error, and finalize creates them

**Symptom.** The runtime-eval provider build (462k chars of TS, `--target
standalone`) refused to instantiate:

```
CompileError: WebAssembly.Module(): Compiling function #395:"__extern_get"
failed: undeclared reference to function #580 @+1803994
```

Deterministic, not flaky. It parked PR #4258.

## Root cause

Not an index shift — a missing **declaration**. WasmGC §3.4.1 validates
`ref.func x` only when `x ∈ C.refs`, the set of function indices named from
**outside** any function body (element segments, global initialisers, exports).
js2wasm satisfies that with a declarative element segment built from
`mod.declaredFuncRefs`, which `collectDeclaredFuncRefs` (class-bodies.ts) fills
by scanning every function body.

That scan runs **once**, mid-finalize — `index.ts` line ~4107 / ~6655. Every
`__extern_get` / dispatcher body **FILL** runs ~400 lines later. So any
`ref.func` whose only occurrence is inside a late-spliced arm is emitted into a
body the scan already walked, and is never declared.

The offender here is #4248 RC3 (`native-proto-instance-method-read.ts`), whose
`memberLadder` answers the identity-stable singleton via
`pushBuiltinFnSingletonValueInstrs` → `pushBuiltinFnClosureValueInstrs` →
`{ op: "ref.func", funcIdx: closure.funcIdx }`. Instrumenting the finalize
sequence named it exactly once in the whole provider module:

```
[late-funcref] handle=2097714 abs=588 name=__proto_method_-1073741806_toString
```

`-1073741806` is `BUILTIN_BRAND_BASE + 18` — **`Object.prototype.toString`**.
(`abs=588` pre-dead-elim; the engine reports `#580` after the import-removal
remap.)

### Why it was latent, and why it surfaced on #4258 specifically

The arm's `ref.func` is normally covered **by accident**: on most programs the
same closure is also `ref.func`ed by a site the mid-finalize scan *does* see
(the static `Number.prototype.toString` read), so the declaration is already
present and the arm's copy validates. The bug only bites when the arm's copy is
the *only* one.

That is what the #4256 merge changed. Its `computeClosureWrapperSig`
syntactic-signature path for never-bound eval-spliced declarations altered which
closures get their wrapper emitted before the scan, and on this specific module
it removed the earlier `ref.func $__proto_method_Object_toString`. Neither PR is
wrong on its own — which is exactly why the branch built fine *without* the
#4256 merge and main was fine *without* wave 4, and why only the `merge_group`
re-validation on the merged state caught it.

### This is the third instance of one class

Two earlier arms hit the identical error and were hand-patched by pushing their
own index into `declaredFuncRefs`:

- #2963 — `member-get-dispatch.ts:441`, whose comment already spells out the
  mechanism verbatim ("`collectDeclaredFuncRefs` REBUILT the declared-elem set
  by scanning bodies BEFORE this fill ran … → 'undeclared reference to
  function' validation error");
- #2175 — `runtime-eval-callable.ts:445/478/504`.

Per-arm patching does not scale: it is invisible to the next arm's author, and
the failure it prevents is size-dependent, so a new arm's unit tests pass for
the wrong reason.

## Fix

`collectDeclaredFuncRefs(ctx, { additive: true })`, called once at the end of
each driver's fill sequence — immediately before
`eliminateDeadLayoutAndPlanProgramAbi`.

- **Additive, never replacing.** The union seeds from the existing
  `declaredFuncRefs`, so the two hand-pushed populations above (and anything
  declared for a `ref.func` this body scan cannot see) survive untouched.
- **Before dead-elim** — the same window the hand-patches target — so the
  authoritative `fR` remap carries the new entries, and a late import add still
  routes through `shiftLateImportIndices`' `declaredFuncRefs` remap.
- **Shift-safe by construction.** Nothing captures an index early: the scan
  reads whatever `funcIdx` the emitted instruction actually holds, at the last
  moment before layout freezes.

### Blast radius

- A module whose late arms were already covered by accident: **byte-identical**
  (the union adds nothing). Only a module that would otherwise have been
  *rejected by the engine* gains elem-segment entries.
- **Dead-elim**: none. `eliminateDeadImports` already marks every local
  function reachable (`usedF.add(numImpF + i)` for all `mod.functions`), so
  extra declared entries for local functions cannot change what is pruned; an
  entry naming an import would have been kept alive by the body scan anyway.
- **Emitted order**: `binary.ts` re-sorts `resolvedDeclaredRefs` ascending
  before writing, so the union cannot permute the segment.

## Verification

- `pnpm run build:compiler-bundle && node scripts/build-runtime-eval-provider.mjs`
  — fails on the parent commit with the CompileError above; **built +
  canary-verified, 4,318,537 bytes** with the fix.
- `tests/issue-4257-late-funcref-declaration.test.ts` — pins the invariant
  (no function body may hold a `ref.func` absent from the spec's `C.refs`)
  rather than a narrow repro, because a small repro passes for the wrong
  reason. Includes a not-vacuous check: a hand-planted body-only `ref.func`
  must be reported.

## Deliberately not done

`validateModuleIndices` (the always-on serializer guard, #2043) still checks
only index RANGE, not declaredness — so a future late `ref.func` that this
additive scan somehow misses would again surface as a V8 `CompileError` rather
than a named codegen error. Extending it means teaching the emitter the full
`C.refs` union (elements + globals + exports), which is a wider change than
this park warranted.
