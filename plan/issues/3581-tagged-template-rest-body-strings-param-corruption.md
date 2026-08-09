---
id: 3581
title: "Tagged template to a nested rest function whose body uses the rest param as an array corrupts the `strings` param (renders `undefined`)"
status: ready
sprint: current
created: 2026-07-24
priority: medium
feasibility: hard
model: opus
horizon: m
reasoning_effort: high
task_type: bugfix
area: codegen, string-ops, tagged-templates, nested-declarations
language_feature: tagged-templates
goal: test262-conformance
related: [3576, 2008, 2510, 2029]
---

# #3581 — tagged-template `strings` param corrupted when a nested rest tag body uses the rest param as an array

## Summary

Carved out of #3576 (which fixed the `call_ref` arity VALIDATION error for
nested rest tag functions). This is a **runtime rendering** defect that is
independent of the arity fix and **pre-existing on `main`** (where it manifests
worse — `dereferencing a null pointer` — because on `main` the rest param is
also mis-lowered). It blocks the full runtime rendering of `deepEqual.js`'s
`format` (`format` validates after #3576 but renders `undefined` for the
`strings` parts of array/object/function values).

## Mechanism (measured)

When a tagged template `tag\`...\`` targets a nested function
`tag(strings, ...subs)` **and `tag`'s body uses the rest param as an ARRAY**
(`subs.map(...)` or `subs[i]`), the `strings` parameter — a tagged-template
**template-object struct** coerced to `externref` via `extern.convert_any` at
the call site — reads as `undefined` inside the body (`strings.join(...)` →
`"undefined"`).

Key isolation results (`.tmp` battery, wasm vs node):

| body uses `subs` via | call form | result |
| -------------------- | --------- | ------ |
| `subs.length` only | tagged template | strings correct ✓ (with #3576) |
| `subs.map(...)` / `subs[i]` | tagged template | **strings = `undefined`** ✗ |
| `subs.map(...)` / `subs[i]` | DIRECT call `tag(["A","B"], 1)` | correct ✓ |

The direct-call column passing (its first arg is a plain array literal, not a
template struct) narrows the defect to the **tagged-template `strings`
value** — a `templateVecTypeIdx` struct (cooked + raw fields) coerced to
`externref` — being consumed by a host array method (`.join`) **only when the
body also materialises the rest param as a data array**. The `subs.length`
path (reads vec field 0) does not trip it, so the trigger is the rest-array
materialisation shifting/late-importing something that the already-emitted
`strings.join` (`local.get; global.get; call; call`) then resolves against
stale indices — a late-import / detached-body fixup interaction in the
tagged-template lowering, OR the template-struct→externref host-method dispatch.
Needs a WAT + index-fixup trace (compare `global.get`/`call` targets between the
`subs.length` and `subs.map` variants).

## Repro

`.tmp/min-direct.mts` (in the #3576 branch) — the `tagged-map` / `tagged-index`
cells reproduce; `direct-map` is the passing control. Minimal:

```ts
function tag(strings, ...subs) {
  let j = subs.map(s => String(s)).join(",");
  return strings.join("|") + "[" + j + "]";
}
// tagged template -> strings renders "undefined"
let out = tag`A${1}B` + ";" + tag`A${1}B${2}C`;
// node: "A|B[1];A|B|C[1,2]"   wasm: "undefined[1];undefined[1,2]"
```

## Acceptance criteria

- A nested rest tag function whose body uses `subs.map(...)` / `subs[i]`,
  invoked as a tagged template, renders the `strings` parts correctly
  (byte-equal to node).
- `deepEqual.js` `format` renders array/object/function values correctly at
  runtime (`String(format([1,2,3]))` === `"[1, 2, 3]"`, etc.), closing the
  runtime half of the deepEqual.js harness (the validation half landed in
  #3576).
- No regression in the equivalence suite / tagged-template tests.
