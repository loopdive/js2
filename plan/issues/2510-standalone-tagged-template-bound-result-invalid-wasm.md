---
id: 2510
title: "standalone: tagged template with a bound result emits invalid Wasm (array.new_fixed externref vs struct.new $NativeString)"
status: done
assignee: ttraenkler/sdev-protoglue
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: easy
reasoning_effort: high
task_type: conformance
area: codegen
language_feature: template-literals, strings
goal: standalone-mode
related: [2190, 35, 1470]
origin: "2026-06-19 — non-array invalid-Wasm harvest (task #74): tagged-template strings array mistypes native-string elements"
---

## Problem

In `--target standalone` (native strings), a tagged template whose result is
**bound** to a variable emits an **invalid Wasm module**:

```ts
function t(s: any, ...v: any[]) { return s[0]; }
const r = t`a${1}b`;   // INVALID
```

```
array.new_fixed[0] expected type externref, found struct.new of (ref $NativeString)
```

(The discarded expression-statement form `t\`a${1}b\`;` happened to dodge it; the
bound / returned form surfaces it.)

## Root cause

`compileTaggedTemplateExpression` (`string-ops.ts`) builds the template object's
cooked + raw strings arrays as **`externref`-element** vecs (`elemKind =
"externref"`). It fills them by calling `compileStringLiteral` for each part. In
native-strings mode `compileStringLiteral` materializes a `(ref $NativeString)`
GC struct (`struct.new`), **not** an externref — so pushing that struct straight
into the externref-typed `array.new_fixed` mistypes element 0 and the module
fails validation.

## Fix (contained — one element-type bridge)

Bridge each native-string literal to externref before `array.new_fixed`, gated
on native-strings mode (host-string mode already yields externref, so it's a
no-op there):

```ts
const pushStringElem = (text: string): void => {
  compileStringLiteral(ctx, fctx, text, expr);
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }
};
```

Applied to both the raw and cooked array-build loops. `extern.convert_any`
(per the project's ref→externref coercion convention) lifts the `(ref
$NativeString)` to the array's `externref` element type.

## Measured (standalone, upstream/main 73d6c037d)

- `const r = t\`a${1}b\`;` (bound), `t\`a${1}b${2}c\``, no-substitution
  `w\`one\``: all now emit VALID, JS-host-free modules (were invalid).
- Structurally observable shape is correct: `strings.length` = 3 cooked parts,
  rest-substitutions = 2, no-substitution = 1 part.
- **GC target unaffected** (change gated on `nativeStrings`): gc tagged
  templates still valid + correct (partsCount=3, subsCount=1).
- Coercion-sites gate OK (`extern.convert_any` is not a tracked coercion
  token); typecheck + prettier clean.

## Out of scope (separate, pre-existing)

Reading an element's string **content** back (`strings[0].length` →
`strings[0]` recovered as empty) is the externref-boundary `$Array`/`$ObjVec`
introspection gap (**#2190 / #35** family) — it returns `0` on the **gc target
too**, so it is NOT a standalone regression and NOT this fix's concern. This
fix only removes the hard invalid-Wasm wall, bringing standalone tagged
templates to parity with gc.

## Test

`tests/issue-2510-tagged-template-standalone.test.ts` — 3 cases: multi-
substitution parts-count, no-substitution single-part, and the headline bound-
result shape; each asserts a valid, host-free, instantiable module.
