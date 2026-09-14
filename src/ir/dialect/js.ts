// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The **JavaScript dialect** of the IR instruction set (#3954 phase 2, first
// slice; scheduled ahead of the `ir-full-coverage` push per the cost-of-delay
// measurement in #4551 — phase 2 is O(kinds), and kinds grew 51 -> 78 in the
// three months to 2026-08-01).
//
// Every instruction declared here encodes an **ECMAScript** protocol: the
// abstract operations behind `dyn.*` (ToBoolean / ToNumber / abstract equality
// / property lookup), the iterator protocol, generator objects, `await`, the
// JS-host extern surface including RegExp, and — since slice A — the two
// total-function string indexing operations plus the inlined string-iterator
// statement form. None of them means anything to a source language that is not
// JavaScript.
//
// The neutral core stays in `../nodes.ts`: control flow, calls, closures,
// refcells, slots, arithmetic, try/throw.
//
// **Placement here is argued, never guessed.** The first slice moved only the
// uncontested members; `scripts/check-ir-kind-neutrality.mjs` (#4551) then
// produced a per-kind verdict with cited evidence, and slice A moved the three
// kinds it judged `js` while still in core — `string.char_at`,
// `string.char_code_at`, `string.repeat`, `forof.string`. The families that came back **neutral**
// stay in core and are not candidates: `vec.*`, `class.*`, `object.*`,
// `box`/`unbox`/`tag.test`, `forof.vec`, `coerce.to_externref`, and the
// encoding-parameterized `string.const`/`string.concat`/`string.eq`. An
// `unresolved` kind (`string.len`, and the payload-vocabulary leak in
// `binary`/`intrinsic`) also stays in core — the gate's R3 rule turns a
// premature move into a build failure rather than a silent mistake.
//
// **Structure:** declaration moves and re-exports only. `nodes.ts` re-exports
// every name below, so all 54 importers are unchanged and no behaviour moves.
// The `IrInstr` union is still assembled in `nodes.ts` — that is the one
// sanctioned core->dialect edge, and `scripts/check-ir-dialect.mjs` enforces
// that it is the only one.
//
// The imports below are `import type` only: interfaces are erased, so the
// core<->dialect cycle has no runtime edge.

export type {
  IrInstrAwait,
  IrInstrAsyncReturn,
  IrInstrAsyncThrow,
  IrInstrDynTruthy,
  IrInstrDynToNumber,
  IrInstrDynEq,
  IrInstrDynMemberGet,
  IrInstrDynMemberSet,
  IrInstrGenPush,
  IrInstrIterNew,
  IrInstrIterNext,
  IrInstrIterDone,
  IrInstrIterValue,
  IrInstrIterReturn,
  IrInstrForOfIter,
  IrInstrGenEpilogue,
  IrInstrGenYieldStar,
  IrInstrGenSetReturn,
  IrInstrExternNew,
  IrInstrExternCall,
  IrInstrExternProp,
  IrInstrExternPropSet,
  IrInstrRegExpLiteral,
  IrInstrStringRepeat,
  IrInstrStringCharAt,
  IrInstrStringCharCodeAt,
  IrInstrForOfString,
} from "../core/dialect/js.js";
