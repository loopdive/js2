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

## Fix and remaining cases (2026-11-19)

Fixed by PR #7333: a non-string GC ref RHS now goes through the runtime
ToString (`emitNonStringRefToAnyStr`, `src/codegen/native-string-slot-bridge.ts`).

The review found three more wrong answers in the same family. Each was
measured on gc, standalone and wasi, and is the same with or without #7333:

- **No `any`-typed function in the module.** The RHS is then already
  `externref`, so the module validates, but the number branch traps with
  `illegal cast`. Example:
  `var out = 'x'; var c: any = 0; out += c ? 'a' : 1;` (node: `"x1"`).
  The externref arm calls `__extern_toString` only when something else
  registered it. This is #7300 item 2.
- **An `undefined` branch** traps with a null dereference:
  `var out = 'x'; var c: any = 0; out += c ? 'a' : undefined;`
  (node: `"xundefined"`).
- **An element target on a `string[]`** gives the wrong value:
  `const o: string[] = ['x']; var c: any = 0; o[0] += c ? 'a' : 1;`
  leaves `o[0] !== 'x1'` (node: `"x1"`).
