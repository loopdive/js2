---
id: 7389
title: "`s += c ? 'a' : 1` emits an invalid Wasm module (legacy string += passes a non-string ref to __str_concat)"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7300, 7388]
---

# #7389: string `+=` of a `string | number` conditional fails Wasm validation

## Problem

On main `89e47482`, this program produces a module that does not validate:

```js
var out = ""; var c = 1; out += c ? 'a' : 1;
```

- **Every lane fails: gc, standalone and wasi, with or without the IR.**
  With `experimentalIR: false` (legacy only) the result is the same, so this
  is a legacy bug. On the IR path `<module-init>` is legacy
  (`operand-coercion-unsupported`).
- **The error:** `compile()` returns `success: false` with `emitted
  WebAssembly failed validation`, and `WebAssembly.validate(binary)` is
  `false`:
  `Compiling function "__module_init" failed: call[1] expected type (ref null 6), found if of type (ref null 57)`.
- **Inside a function it is the same:**
  `function f(){ var out = ""; var c = 1; out += c ? 'a' : 1; return out; }`
  fails to validate on all three lanes. There the IR claims `f` and withdraws
  it (#7388's message) before legacy emits the bad body.
- **These forms are fine on every lane:** `out = out + (c ? 'a' : 1)`;
  `var t = c ? 'a' : 1; out += t`; and `"" + (c ? 'a' : 1)`.
- **Node gives** `out === "a"`.

**Likely cause:** `compileNativeStringCompoundAssignment`
(`src/codegen/expressions/operator-assignment.ts`, about line 1489) passes any
`ref`/`ref_null` RHS straight to `__str_concat`. The code assumes such a
value is "AnyString-compatible". A mixed conditional produces a different
ref type (the `if` block's union result), so `call __str_concat` gets the
wrong operand type.

## Direction

- **Option 1: check the type in that arm.** When the RHS ref is not
  `$AnyString`, route it through the same ToString path the `externref` arm
  uses: `extern.convert_any`, then `__extern_toString`, then a cast to
  `$AnyString`.
- **Option 2: compile the RHS with an `externref` hint** when its static
  type is not `string`. This reuses the existing externref arm.
- **Test:** pin `WebAssembly.validate` and the value `"a"` on gc, standalone
  and wasi.
- **Related:** #7300 item 2, where appending non-string primitives traps
  with `illegal cast`, is the same arm.
