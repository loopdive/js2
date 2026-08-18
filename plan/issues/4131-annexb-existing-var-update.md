---
id: 4131
title: "Annex B B.3.3.1 step 3 — a block/if/case-nested function must UPDATE an existing var binding"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
goal: core-semantics
assignee: ttraenkler/senior-dev
completed: 2026-08-03
---

## Problem

Annex B B.3.3.1 has two halves. The compiler implemented one.

- **Create** — a block-nested sloppy `function F` gets a *new* var-scoped binding in
  the enclosing function/global scope. Implemented: `annexBBlockNestedEligible` +
  `fctx.annexBOuterBindings` (#2200 Phase 2), with the cancellation cases in
  `src/codegen/annexb-cancel.ts` (#3980).
- **Update** — step 3.f, `fenvRec.SetMutableBinding(F, fobj, false)`: when the
  declaration is *evaluated*, the function object is written into the var-scoped
  binding **whether or not Annex B created it**. Not implemented at all. The
  create-half bails outright when the name already has a local:

  ```ts
  // statements/nested-declarations.ts
  // Skip if the name already has a function-local (e.g. a var/param) — that
  // binding wins, no Annex B var.
  if (!fctx.localMap.has(funcName)) { /* allocate + record */ }
  ```

  The comment is right about *allocation* and wrong about *assignment*.

Measured on `main` (312-file sweep of `annexB/language/{function,global}-code`):
all 6 `block-decl-*` / `switch-*-*-existing-var-update` files fail with
`Expected SameValue («"number"», «"function"»)` — the read sees the `var`'s own
value, never the function.

## Why the five `if-*` files "passed" — and why that was an accident

`if-decl-*-func-existing-var-update.js` (5 files) passed on `main`, but not
because step 3 worked. Their wrapper is an IIFE; `compileTailDispatch`'s inline
path did **not** hoist `var` declarations, so at `after = f` no local named `f`
existed yet and identifier resolution fell through to the cached function-closure
singleton (`emitCachedFuncClosureAccess`). Position-insensitive luck.

Any change that makes an inlined IIFE body hoist its vars — as a real
FunctionDeclarationInstantiation must — flips those five to a **null
dereference**. That is what the Codex eval-capture stack
(`codex/2929-annexb-init-update`) does: commit `0d14fa56d` adds
`hoistVarDeclarations` to both arms of the inlined-IIFE path in
`src/codegen/expressions/call-tail-dispatch.ts`, motivated by indirect eval
observing a nested local as a realm-global mutation. That change is correct on
its own terms; it merely removes the accident.

Emitted code for `after = f` under the hoist, from the WAT:

```wat
;; main                                    ;; with the var-hoist
global.get $__fn_closure_f                 local.get 0        ;; the f64 var slot, still 0
ref.is_null                                call $__box_number
(if (then ref.func $__fn_tramp_f_cached    global.set $__mod_after
          i32.const 0 struct.new …
          global.set $__fn_closure_f))
global.get $__fn_closure_f
… → global.set $__mod_after
```

`after` then holds a boxed `0`, and the call dispatch traps rather than throwing:
its guard throws TypeError only when the *raw* value is null, so a non-null
non-callable falls through to `struct.get` on a null cast result. (Read from the
emitted WAT; not separately minimised — see "Follow-ups".)

## Attribution (kill-switch removal)

`hoistVarDeclarations` in the two inlined-IIFE arms of `call-tail-dispatch.ts` was
replicated locally on `main` as the kill switch. Lane: JS-host (default target),
`runTest262File`, status only.

| build | 5 × `function-code/if-*-func-existing-var-update` |
| --- | --- |
| `main` (e5c7747c5) | `pass` ×5 |
| `main` + hoist replica, **no fix** | `null_deref` ×5 — same 5 files, same `dereferencing a null pointer in __module_init() at source L44` as the Codex stack |
| `main` + hoist replica + this fix | `pass` ×5 |
| `main` + this fix | `pass` ×5 |

`git bisect` over `main..codex/2929-annexb-init-update` (27 commits) names
`0d14fa56d` as the first bad commit; the trace
`allocLocal ← hoistVarDecl ← walkStmtForVars ← hoistVarDeclarations ←
compileTailDispatch` pins the line.

## Fix

Three sites, sharing one predicate.

1. `src/codegen/annexb-cancel.ts` — `annexBUpdatesExistingVarBinding(fd)` and the
   memoized `annexBExistingVarUpdateNames(scope)`. Reuses `annexBDeclaringRange`,
   so the Block / `if`-clause / `switch`-clause position set stays defined once.
   `annexBBlockNestedEligible` could not host this: it only recognises a direct
   `Block` parent.
2. `src/codegen/analysis/mixed-assignment-carrier.ts` — an Annex B declaration is
   a *hidden* cross-domain assignment: no `F = …` BinaryExpression exists for the
   existing walk to see, so `var f = 123` keeps an f64 slot and the write-back is
   unrepresentable. Widen the carrier to externref for those names only.
3. `src/codegen/statements.ts` — emit the store at the declaration's textual
   position, **after** whichever path defines the function.

## Measured effect

| population | before | after |
| --- | --- | --- |
| `annexB/language/{function,global}-code`, 312 files | 203 pass / 108 fail / 1 CE | **byte-identical** |
| `tests/issue-4131.test.ts` (4 cases, 2 semantic + 2 negative control) | 2 fail | 4 pass |
| `tests/issue-3980.test.ts` (annexb-cancel detector) | 18 pass | 18 pass |
| 5 `if-*` files under the Codex var-hoist | `null_deref` | `pass` |

On `main` alone the change is a **no-op across the whole annexB corpus** — every
test262 file in that family wraps its case in an IIFE, which `main` inlines
without hoisting, so the code path is unreachable there. Its measurable effect on
`main` is the named-wrapper shape in `tests/issue-4131.test.ts` (fail → pass); its
effect on the Codex stack is the 5-file regression removed. Both are stated rather
than averaged into one number on purpose.

## Explicitly NOT fixed

- **`block-decl` / `switch-*` positions** (6 files, already failing on `main`).
  Widening the *carrier* is not enough: the binding's **static type** stays
  `number`, so the assignment path emits `__unbox_number` → `__box_number` around
  the closure and `after` receives `NaN`. Verified in the WAT of a named-wrapper
  `block` case. Fixing these needs the binding's *type* to widen, not just its
  slot — a TypeMap/oracle change, not a codegen one.
- **Global scope.** A script-scope `var` is a module global, on a different
  representation path; an earlier cut that did not exclude `SourceFile` scopes
  produced `local.tee expected (ref null 25), found global.get of type f64` on the
  5 `global-code/if-*` files. The predicate now returns `false` for
  `SourceFile`/`ModuleBlock` scopes.
- The 16 `eval-code/{direct,indirect}/*-existing-var-update` twins — not measured.

## Approaches that failed (do not repeat)

1. **Return early from the new `statements.ts` branch** (mirroring the
   `annexBOuterBindings` branch, which ends in `return`). The `if`/`case`
   declaration positions are not always pre-compiled by the hoist pre-pass, so the
   early return dropped the function definition outright and the name read as
   null. Measured: 5 × `TypeError: Cannot access property on null or undefined`.
2. **Applying the carrier widening at script scope too** — invalid Wasm, above.
3. **Guarding the collection walk with `isVarScopeBoundary` before testing the
   node.** A `FunctionDeclaration` *is* a var-scope boundary, so the guard skipped
   the very declarations being collected and the set came back empty for every
   case — a silent no-op that looked like "the fix does not work".

## Follow-ups (not filed)

- The callable-dispatch guard throws TypeError only on a *null* raw value; a
  non-null non-callable externref (e.g. a host-owned boxed number) reaches
  `struct.get` on a null cast result and **traps**. This is what turned an honest
  `fail` into a `null_deref`. Observed in emitted WAT; worth its own issue.
