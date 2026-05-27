---
id: 1605
title: "codegen: class computed-property-name / setter param-scope emits invalid wasm (local.tee externref mismatch)"
status: in-review
created: 2026-05-24
updated: 2026-05-27
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 6
related: [1522]
---
# #1605 — Class computed-name / setter scope local.tee type mismatch

## Problem

6 test262 tests fail with `invalid Wasm binary`:

```
local.tee[N] expected type externref, found ... (or vice versa)
```

All 6 are in `language/statements/class` and `language/expressions/class`,
specifically:
- computed-property-name accessors built from `null`
  (`cpn-class-decl-accessors-computed-property-name-from-null`)
- setter param-body var-close scope tests
  (`scope-setter-paramsbody-var-close`, `scope-static-setter-paramsbody-var-close`)

The failing function is `test`. A `local.tee` writes/reads a local declared
with a type that doesn't match the value being tee'd — an externref value into
a non-externref local, or the reverse — in the class member scope-setup code.

## Failing test examples

- `test/language/statements/class/cpn-class-decl-accessors-computed-property-name-from-null.js`
- `test/language/statements/class/scope-setter-paramsbody-var-close.js`
- `test/language/statements/class/scope-static-setter-paramsbody-var-close.js`

## Root-cause hypothesis

The class-member lowering (`src/codegen/` class/accessor codegen) allocates a
local for a computed property key or a setter parameter with one declared type
but tees a value of a different type into it. For the computed-name-from-null
case the key is null/externref while the local is typed for the resolved key;
for the setter param-scope cases the var-close scope copy mismatches. Audit the
local-type declaration vs. the tee'd value type in computed-key evaluation and
setter parameter scope copy-out.

## Acceptance criteria

- The three example tests compile to valid Wasm.
- All 6 tests move off `compile_error`.

<<<<<<< HEAD
## Root cause

`compilePropertyAssignment` / `compileElementAssignment` routed
`C.prototype.<setter> = v` and `C.<static setter> = v` through the regular
setter-call path, which compiles the receiver with the setter's struct `this`
type hint. But the receiver of a prototype/class-object write is an **externref**
(the lazy prototype/class-object singleton), not a struct instance. Coercing
that externref to the struct `this` param produced an invalid `local.tee`
(externref temp fed a struct `ref.null`).

## Fix

In `src/codegen/expressions/assignment.ts` (`compilePropertyAssignment` setter
branch): when the assignment target's receiver is `<X>.prototype` or a bare
class identifier, route through `emitSetterCallWithDummy` — the same dummy-struct
path already used for `C.prototype[key] = v` element-access setters. The setter
gets a throwaway struct receiver and the value flows through unchanged.

## Test Results

- `scope-setter-paramsbody-var-close` → **valid wasm** (fixed)
- `scope-setter-paramsbody-var-open` → **valid wasm** (fixed)
- `scope-static-setter-paramsbody-var-close` → **valid wasm** (fixed)
- `scope-static-setter-paramsbody-var-open` → **valid wasm** (fixed)
- `cpn-class-decl-accessors-...-from-null` → still INVALID (see below)
- `cpn-class-expr-accessors-...-from-null` → still INVALID (see below)

New unit test: `tests/issue-1605.test.ts` (3 cases, all pass).

## Remaining (deferred — separate bug)

The two `cpn-...-from-null` cases (`c[null] = null` element-write where the class
has BOTH a computed `get [null]` and `set [null]`) hit a **distinct** defect: the
top-level wrapper's `let c = new C()` is allocated TWICE — once by the let/const
TDZ hoist pass and once by `compileVariableStatement` (the hoisted slot is not
reused; `fctx.localMap` no longer resolves the name at statement time when
computed-name accessors are present). The resulting dead duplicate local shifts
binaryen's local typing so the (internally-correct) `ref.null.extern` tee is
misvalidated against the struct local. This is a variable-hoisting / slot-reuse
bug, not a setter-coercion bug, and warrants its own issue.
=======
## Sub-cluster CPN — FIXED (2026-05-27)

Root cause was **not** in class/accessor codegen — the setter call was lowered
correctly (`local.get self`, `ref.null.extern` value, `local.tee` temp,
`call C_set_null`). The bug was in the **call-arg fixup** in
`src/codegen/fixups.ts` (the "ref.null extern where (ref null N) is expected"
pass, ~line 878). It walks backwards from a `call` mapping params to preceding
instructions, skipping multi-consuming producers (`struct.new`,
`array.new_fixed`, nested `call`). It did **not** account for `local.tee`,
which is stack-neutral (pops 1, pushes 1) and therefore transparent — not an
arg producer. With a value `ref.null.extern` tee'd into a temp before the
`call`, the walk treated the `local.tee` as the param-1 producer, then
mis-mapped the underlying `ref.null.extern` to param 0 (the struct receiver
`(ref null N)`), rewriting it to `ref.null <struct>`. That mismatched the
externref temp the value was tee'd into → `local.tee[N] expected externref,
found ref.null of <struct>`.

Fix: in the backward arg-walk, treat `local.tee` as transparent — skip it
without advancing the param index so the real producer beneath maps to the
current param.

**File**: `src/codegen/fixups.ts`. Test: `tests/issue-1605-cpn.test.ts`.

**test262 results (verified via `runTest262File`)**:
- `cpn-class-decl-accessors-computed-property-name-from-null.js` — **pass** (was compile_error)
- `scope-setter-paramsbody-var-close.js` — compile_error → **fail** (now valid wasm; remaining `returned 2` is a separate setter param/body var-close scope-semantics bug, NOT invalid-wasm)
- `scope-static-setter-paramsbody-var-close.js` — compile_error → **fail** (same; off compile_error)

All three are off `compile_error`. The two `scope-*-var-close` runtime
semantics failures are a distinct sub-cluster left to the broader #1605 work.
A 100-file slice of `language/statements/class` shows identical status counts
to clean main (82 pass / 13 fail / 5 ce) — no regression from the fixup change.
>>>>>>> origin/main
