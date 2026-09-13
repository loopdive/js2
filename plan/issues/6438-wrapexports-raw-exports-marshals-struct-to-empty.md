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

## Implementation Plan

**Verified on this HEAD (upstream/main 54c36a9fe3, probe `.tmp/probe-6438.mjs`, same module + same call):** `__setExports(instance.exports)` then `wrapExports(instance.exports)` → `parse()` = `{}` while `__struct_field_names(raw)` = `"type"`; `wrapExports(instance)` → `{type:"Program"}`; `__setInstance(instance)` then `wrapExports(instance.exports)` → `{type:"Program"}`; and a raw-overload wrap made AFTER an Instance-overload wrap of the same module also decodes (authority is global per manifest). So the defect is exactly "raw overload with no established authority", and it is order-dependent.

**Responsible arm (not a hypothesis any more):** `_hostBridgeExportView` (src/runtime.ts ~L1573) — with `dataStructMetadata === undefined` the loop over `_DATA_STRUCT_HOST_BRIDGE_EXPORTS` (`__is_data_struct`, `__struct_field_names`) sets `overrides.set(logicalName, undefined)`, i.e. the view **masks the compiler's own decoder to `undefined`**. `wrapExports` (~L19415) passes `mayEstablishDataStructAuthority: brandedExports !== undefined`, so a bare record can only consume. Then `looksMarshalable` (~L19482) falls to `return hasVecLen` (true), and `_wasmToPlain` (~L4820) takes the "(#3637) neither named struct nor vec → `{}`" arm. Note `tests/issue-3520-data-struct-host-bridge-abi.test.ts:555-568` currently PINS `wrapped.makeBox()).toEqual({})` for this exact path ("data authority fails closed") — that assertion must move to `toThrow`.

**Contract decision — refuse loudly, never decode from a raw record.** Option "decode from raw" is ruled out by #3520's design (`_dataStructHostBridgeMetadata` comment: the mutable binding table cannot authenticate callable identity; a raw record may carry donor functions), so AC4 is satisfied by throwing, not by trusting. Consumption of an authority established by `__setInstance` / a prior Instance wrap keeps working unchanged (measured above).

**Change (all in `wrapExports`, src/runtime.ts; do NOT touch `_wasmToPlain`, `_hostBridgeExportView` or the lifecycle adapter — compiled-program JSON.stringify under legacy `__setExports` must keep its current semantics):**
1. At wrap time compute `const dataStructDecoderMasked = _hasOwn(rawExports, "__struct_field_names") && typeof exportsForMarshal.__struct_field_names !== "function";` (the module ships a decoder and the view masked it ⇒ no authority).
2. In `invoke`, keep the existing probe order (symbol → error/primitive/promise carriers → closure → `_structFieldNamesRaw` → `_isWasmVec` → `hasVecLen`). Add ONE arm after `marshalable` is known and only when `resultMarshal !== false` (`marshal:false` still hands back the raw handle): if `dataStructDecoderMasked && marshalable && !_isWasmVec(result, exportsForMarshal)` → `throw new TypeError('wrapExports: cannot decode a returned struct from a raw exports record — no data-struct authority is established for this module; pass the WebAssembly.Instance to wrapExports, or call importObject.__setInstance(instance) first')`. If `dataStructDecoderMasked` and the result IS a vec, scan its elements via `__vec_get`/`__vec_len` and throw the same error on the first element that is `_isWasmStruct` && not vec && not closure (vec-of-structs otherwise marshals to `[{}, {}]` just as silently). This is the rare legacy path, so the scan costs nothing on the documented path.
3. A genuine field-less struct on an authenticated view still has a callable `__struct_field_names` (returns `""` → null names) and still lands in the `{}` arm — that is the "empty vs undecodable" distinction AC3 asks for.
4. Docs: extend the `wrapExports` JSDoc (~L19296) and the `importObject` JSDoc in src/index.ts (~L365): raw-record overload decodes structs only after `__setInstance(instance)`; otherwise struct results throw.
5. Update `tests/issue-3520-data-struct-host-bridge-abi.test.ts:563` from `toEqual({})` to `toThrow(/data-struct authority/)`; keep `getAddTwo`/`getArray` (closure/vec) assertions as-is — they must still pass without authority. Then run the full `npm test` (~91 test sites use the raw overload; most return primitives, but any that return a class instance via `__setExports` only will now throw — fix those sites by calling `__setInstance(instance)` / passing the Instance, never by loosening the check).

**Probe to write first:** `.tmp/probe-6438.mjs` above already exists in this worktree's `.tmp/`; re-run it after the change — rows 1 must throw, rows 2–4 unchanged.

**Regression test:** `tests/issue-6438-raw-exports-struct-decode.test.ts` compiling untyped `tests/fixtures/issue-6438/parser.js` (`// @ts-nocheck`; `Node`/`Parser` fnctor shape from #1712 plus `class Empty { m(){} }` and `export function empty(){ return new Empty(); }`, `export function nodes(){ return [new Node("A")]; }`), one instantiate per case: (a) Instance overload → `{type:"Program"}`; (b) `__setExports(instance.exports)` + raw overload → `parse()` throws TypeError naming `__setInstance` (fails on parent: returns `{}`), `nodes()` throws too; (c) `__setInstance(instance)` + raw overload → `{type:"Program"}` (pins the consume path); (d) anti-vacuity control: Instance overload `empty()` → `{}` and does NOT throw; (e) `marshal:false` on the unauthenticated raw overload returns a raw `_isWasmStruct` handle without throwing; (f) #3520 control: second fixture file declaring its own `export function __struct_field_names(){ return "type"; }` — raw overload still throws, Instance overload still answers the compiler's names (user decoder never consulted).

**Expected movement:** dogfood anchors unchanged (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono ~261/324): every harness either passes the Instance or calls `__setInstance` before the raw overload (react/lit/react-dom verified at react-upstream-suite.mjs:362-364, lit-upstream-suite.mjs:546-548). Verify `tests/dogfood/eslint-upstream-suite.mjs:227` (raw overload, no visible `__setInstance`) reads only primitives; if it throws, add `__setInstance`. Standalone lane: `wrapExports` is JS-host only — no standalone-floor change expected. test262: none (harness uses the lifecycle path, not `wrapExports`).

## Dispatch

**opus** — bounded runtime change with a precise probe order to preserve, but the fallout is a suite-wide sweep of ~91 raw-overload call sites whose breakage must be resolved by re-wiring, not by weakening the fail-closed check.
