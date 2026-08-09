---
id: 3472
title: "Standalone: native-string-reassigned `any`/externref param that is then `+=` string-concatenated compiles to INVALID Wasm (__str_concat gets externref for arg0)"
status: done
assignee: ttraenkler/senior-dev
completed: 2026-07-19
sprint: 73
created: 2026-07-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
goal: standalone
related: [2860, 3468]
blocks: [3468]
loc-budget-allow: [src/codegen/expressions/operator-assignment.ts]
coercion-sites-allow:
  - src/codegen/expressions/operator-assignment.ts
---

## Problem

Under `--target standalone` (and WASI), a function whose unannotated
(`any`/externref) param is **reassigned to a native-string literal in one branch
and then string-concatenated** with `+=` compiled to an **invalid Wasm module**:

```ts
const f = function(msg){ if(msg===undefined){msg='';} else {msg+=' ';} msg+='x'; return msg; };
```

`WebAssembly.instantiate` failed with a `CompileError`:

```
call[0] expected type (ref null $AnyString), found local.get of type externref
```

i.e. `__str_concat` received an `externref` where its first operand must be
`(ref null $AnyString)`.

This is the message-building shape used by test262's
`assert.sameValue` / `assert.throws`, so it **BLOCKS #3468's routing** (making the
harness reach the assertion produced ~391 invalid-Wasm regressions). It is also a
general standalone soundness bug on its own. Folded under **#2860** (standalone
vs JS-host gap).

## VERIFY-first: the stated premise was overturned

The dispatch framed this as "function-EXPRESSION fails, function-DECLARATION is
valid." On current `origin/main` **that is inverted / incomplete**: BOTH forms
fail with the identical `CompileError`, because both route through the **same**
codegen site. The function-expression only "looked" valid in the original probe
because `const f = function(){…}` is never exported/called, so its body was
tree-shaken away; once `f` is actually exercised (export + call), the expression
form fails too. One root cause, one fix, covers both.

Minimal trigger (neither half alone triggers it):

| shape | result |
| --- | --- |
| `msg += 'x'` alone | OK (routes to `emitAnyAdd`, which coerces the externref) |
| `if(msg===undefined){msg='';}` alone | OK |
| `if(msg===undefined){msg='';} msg+='x';` | **INVALID Wasm** |
| `return msg + 'x'` | OK |
| annotated `msg: string` | OK (slot is already `ref $AnyString`) |

## Root cause

`compileNativeStringCompoundAssignment` in
`src/codegen/expressions/operator-assignment.ts` handles string `+=`. The routing
decision (`compileCompoundAssignment`) sends an `any`-typed binding here when
`hasStringAssignment(name, …)` finds a `name = "literal"` somewhere in scope
(the common `var x; x=""` test262 pattern). That function then loaded the
**current value** with a bare `local.get`/`global.get` under the comment "Load
current value as ref $AnyString" — but for an `any`/untyped binding the storage
slot is **externref**, not a native-string ref. The RHS operand was coerced to
`ref $AnyString` (lines ~1307-1338), the current-value load was not, so
`__str_concat`'s **arg0** was a raw externref → invalid module.

(The identifier read path was a red herring: `narrowTypeToUnbox` returns `null`
for a string-narrowed type — "string stays externref" — and the `+=` never went
through `compileStringBinaryOp`; it went through the compound-assignment path.)

## Fix

In `compileNativeStringCompoundAssignment`, after loading the current value,
inspect the actual **slot type** for each storage class (local / captured global
/ module global). When it is `externref` and we are in **no-JS-host mode**
(`ctx.standalone || ctx.wasi`), coerce the loaded externref to a native
`ref $AnyString` via **ToString** (`__extern_toString` + `any.convert_extern` +
`ref.cast $AnyString`) — the exact coercion `compileNativeConcatOperand` uses for
a dynamic externref `+` operand. This is spec-correct (§7.1.17): a runtime
`number`/`undefined`/object stringifies (`5 → "5 x"`) instead of trapping an
unconditional `ref.cast`, matching the general `+` operator lowering
(`emitAnyAdd`).

Index-shift safety: `__extern_toString` is a **native defined function** in
standalone/WASI (`OBJECT_RUNTIME_HELPER_NAMES`, registered by
`ensureObjectRuntime`), so `ensureLateImport` adds **no import** and shifts **no
function index** — `concatIdx` stays valid. In JS-host `nativeStrings` mode
`__extern_toString` is a host import (adding it mid-body would shift indices,
#1175), so the coercion is gated off there and that path is left byte-identical
(out of scope).

Statically-`string` bindings and `let s=""` builders have a native-string ref
slot, so the `externref` guard never fires → byte-identical, no regression.

## Adjacent, out-of-scope (noted, not chased)

The same site is also invalid Wasm when the slot is **f64/i32** (a param inferred
numeric that is *also* string-assigned — a contradictory shape;
`call[0] … found local.get of type f64`) or **`ref_null $AnyValue`** (unionAnyRep
carrier). Both are pre-existing (reproduce on `origin/main`, unchanged by this
fix) and are separate, narrower manifestations. A module-level `let acc: any = ''`
accumulator returns a wrong *result* (pre-existing, native-string-ref slot so this
fix does not touch it). Deferred.

## Test Results

`tests/issue-3472-standalone-fnexpr-strconcat-param.test.ts` (5 cases, all pass):
declaration form, function-expression/closure form (`f(undefined)→"x"`,
`f("a")→"a x"`), numeric-runtime-value ToString discriminator (`f(5)→"5 x"`),
statically-`string` param regression, `let s=""` builder regression.

Scoped regression suites green: `issue-1017-concat`, `issue-1470-*` (standalone
string coercion/imports), `issue-1210` (string builder), `issue-2058-any-plus-string`,
`issue-2176`/`template-literal-type-coercion`. `tsc --noEmit` clean.
