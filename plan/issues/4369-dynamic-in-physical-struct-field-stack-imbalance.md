---
id: 4369
title: "Dynamic `in` over a class instance leaves compiler-only struct fields on the Wasm stack"
status: done
assignee: ttraenkler/codex
sprint: 78
created: 2026-08-11
updated: 2026-08-18
completed: 2026-08-11
priority: high
horizon: s
feasibility: easy
task_type: bugfix
area: codegen
language_feature: in-operator
goal: npm-library-support
related: [166, 722, 3715, 4368]
files:
  - src/codegen/binary-ops-in.ts
  - tests/issue-4369-dynamic-in-stack-balance.test.ts
origin: "marked@18.0.2 pinned dogfood bundle after the capture-cell repair tracked in plan issue 4368"
---

# #4369 — Dynamic `in` compares compiler-only physical fields

## Problem

Marked's extension registration loops dynamically check whether a `for...in`
key exists on its renderer, tokenizer, and hooks class instances:

```js
for (const key in extension.renderer) {
  if (!(key in renderer)) throw new Error("unknown renderer property");
}
```

The legacy backend builds a string-equality OR chain for a dynamic `key in
knownStruct`. It obtains candidate names from the physical Wasm struct, which
contains the compiler's hidden `__tag` slot before the public fields. The
string-import collector correctly registers only JavaScript-visible TypeScript
properties, so there is no string global for `__tag`.

The emitter nevertheless pushes the dynamic key before checking whether the
candidate has a string global. That first key remains on the operand stack and
the following public-field comparison feeds an `externref` to `i32.or`:

```wat
i32.const 0
local.get $key          ;; hidden __tag candidate, no comparison follows
local.get $key
global.get $options
call $string_equals
i32.or                  ;; expects i32, sees the stranded externref
```

The six-line minimized class repro and Marked's 4.1 MB bundle fail with the
same validator error. In Marked the first occurrence is function
`__closure_27` in `Marked.use()`.

## Root cause

`src/codegen/binary-ops-in.ts` and the import collector use different sources
of truth:

- the emitter walks every physical struct field, including hidden compiler
  representation;
- the collector walks `rightType.getProperties()`, the public TypeScript
  property surface;
- the emitter loads the key before discovering that a physical-only name has
  no registered string.

This is not caused by Marked's adjacent `Array.prototype.includes()` call. It
is a generic class-instance dynamic-`in` stack imbalance.

## Implementation direction

Filter physical struct candidates through the receiver's public TypeScript
property names, and emit each `key + field-name + equals + or` unit atomically:
do not push the key until the field-name string is available. This also keeps
the internal `__tag` slot from becoming observable as a JavaScript property.

## Acceptance criteria

- [x] A dynamic `key in new Class()` repro emits valid Wasm.
- [x] Public fields return `true`; a missing field returns `false`.
- [x] The compiler-only `__tag` field returns `false`, including when that
      spelling exists elsewhere as a real string literal.
- [x] A key produced by `for...in` takes the same valid, correct path.
- [x] The pinned Marked bundle advances past `__closure_27` after composing
      with the capture-cell fix.
- [x] Adjacent dynamic/static `in` operator suites remain green.

## Verification

- The focused regression and six adjacent `in`/closed-struct suites pass: 72
  tests total.
- TypeScript project type-checking and focused formatting checks pass.
- The exact pinned Marked compile, with the capture-cell repair from
  [PR #4382](https://github.com/loopdive/js2wasm/pull/4382) composed only for
  measurement, moves from function 510 `__closure_27`
  (`externref` under `i32.or`) to the later function 564 method-trampoline
  result mismatch. The emitted binary shrinks from 4,086,843 to 4,086,823
  bytes; no Marked source or compiler options changed.
