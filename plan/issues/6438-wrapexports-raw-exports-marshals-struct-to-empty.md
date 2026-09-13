---
id: 6438
title: "wrapExports(instance.exports) silently marshals a returned struct to `{}` — only the Instance overload can decode"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
task_type: bug
area: runtime
goal: correctness
---

## Problem

Found while fixing
[#6419](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6419-three-closure-area-tests-red-on-main).

`wrapExports` documents two inputs: the genuine `WebAssembly.Instance`
("preferred") and the raw exports record ("retains the historical API"). The
two do not agree. A compiled function that returns an object marshals
correctly through the first and to an **empty object** through the second — no
error, no warning.

Measured 2026-09-13 on `upstream/main` e0023dbbe6, one module, one call:

```
wrapExports(instance,         { signatures }).parse("x")  →  { type: "Program" }
wrapExports(instance.exports, { signatures }).parse("x")  →  {}
```

The struct itself is perfectly well-formed at that moment —
`__struct_field_names(raw)` answers `"type"` and `__sget_type(raw)` answers
`"Program"` off the same instance's raw exports.

## Mechanism (as far as it was traced)

`wrapExports` builds `exportsForMarshal` from
`_hostBridgeExportView(rawExports, { mayEstablishDataStructAuthority: brandedExports !== undefined, … })`.
`_brandedInstanceExports` answers `undefined` for a bare exports record, so the
raw-exports overload may never ESTABLISH the data-struct authority — it can
only consume a globally established one. Without it,
`_structFieldNamesRaw(value, exportsForMarshal)` returns `null`,
`looksMarshalable` still answers `true` through its `hasVecLen` tail, and
`_wasmToPlain` finds no fields and produces `{}`.

The bad outcome is the *silence*: `{}` is indistinguishable from a genuinely
field-less object, so a caller on the historical API reads a wrong answer with
nothing to look at.

## Why it matters more than the call site

`tests/issue-1712-capture-closure-dispatch.test.ts` was red on main for exactly
this reason and read as a closure-dispatch defect. It has been pointed at the
Instance overload (#6419), which is correct for that file — but every other
embedder on the documented historical API has the same silent failure.

## Acceptance criteria

1. Decide the contract: either the raw-exports overload decodes structs as well
   as the Instance overload, or it refuses loudly (a thrown `TypeError` naming
   the missing authority) instead of answering `{}`.
2. Whatever is decided, a returned struct never marshals to `{}` unless the
   struct really has no fields.
3. A regression test covering both overloads on the same module, with the
   field-less-struct control that distinguishes "empty" from "undecodable".
4. The #3520 protection stays: a user-declared `__struct_field_names` must not
   become the decoder.
