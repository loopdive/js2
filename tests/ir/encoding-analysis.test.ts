// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1588 — string encoding analysis unit tests.
//
// Covers:
//   - the lattice join (conservative least-upper-bound)
//   - the literal classifier (ascii / utf8 / wtf16, incl. surrogate cases)
//   - the pass annotating string.const + string.concat alloc sites
//   - conservative default (wtf16) for untracked operands
//   - the analysis leaves the IR unchanged (advisory only)

import { describe, expect, it } from "vitest";

import {
  ALLOC_NAMESPACES,
  AllocSiteRegistry,
  IrFunctionBuilder,
  analyzeEncoding,
  classifyLiteral,
  irImportFuncRef,
  irRuntimeFuncRef,
  irUnitFuncRef,
  joinEncoding,
  irVal,
  type Encoding,
  type IrType,
} from "../../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "../helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("ir/encoding-analysis");
const STR: IrType = { kind: "string" };
const NS = ALLOC_NAMESPACES.encoding;

function readEnc(
  reg: AllocSiteRegistry,
  value: string,
  kind: "string.const" | "string.concat",
  fn: ReturnType<IrFunctionBuilder["finish"]>,
): Encoding | undefined {
  const instr = fn.blocks[0]!.instrs.find(
    (i) => i.kind === kind && (kind !== "string.const" || (i as { value?: string }).value === value),
  )!;
  return reg.read<Encoding>(instr.alloc!, NS);
}

describe("#1588 — encoding lattice", () => {
  it("join is the conservative least upper bound", () => {
    expect(joinEncoding("ascii", "ascii")).toBe("ascii");
    expect(joinEncoding("ascii", "utf8-guaranteed")).toBe("utf8-guaranteed");
    expect(joinEncoding("utf8-guaranteed", "ascii")).toBe("utf8-guaranteed");
    expect(joinEncoding("utf8-guaranteed", "utf8-guaranteed")).toBe("utf8-guaranteed");
    expect(joinEncoding("ascii", "wtf16")).toBe("wtf16");
    expect(joinEncoding("wtf16", "utf8-guaranteed")).toBe("wtf16");
    expect(joinEncoding("wtf16", "wtf16")).toBe("wtf16");
  });
});

describe("#1588 — classifyLiteral", () => {
  it("all-ASCII literals are ascii", () => {
    expect(classifyLiteral("")).toBe("ascii");
    expect(classifyLiteral("hello")).toBe("ascii");
    expect(classifyLiteral("a1!~")).toBe("ascii");
    // 0x7F is the ASCII boundary (inclusive).
    expect(classifyLiteral("\x7f")).toBe("ascii");
  });

  it("non-ASCII but well-formed literals are utf8-guaranteed", () => {
    expect(classifyLiteral("café")).toBe("utf8-guaranteed");
    expect(classifyLiteral("")).toBe("utf8-guaranteed");
    expect(classifyLiteral("日本語")).toBe("utf8-guaranteed");
    // A well-formed surrogate pair (U+1F600) is valid UTF-8.
    expect(classifyLiteral("\u{1f600}")).toBe("utf8-guaranteed");
    expect(classifyLiteral("a\u{1f600}b")).toBe("utf8-guaranteed");
  });

  it("lone surrogates are wtf16 (cannot be valid UTF-8)", () => {
    expect(classifyLiteral("\uD800")).toBe("wtf16"); // lone high
    expect(classifyLiteral("\uDC00")).toBe("wtf16"); // lone low
    expect(classifyLiteral("a\uD800b")).toBe("wtf16"); // high not followed by low
    expect(classifyLiteral("\uDC00\uD800")).toBe("wtf16"); // reversed (low then high)
    expect(classifyLiteral("\uD800\uD800")).toBe("wtf16"); // high followed by high
  });
});

describe("#1588 — analyzeEncoding pass", () => {
  it("annotates a string literal's alloc site with its classification", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);

    expect(readEnc(reg, "hi", "string.const", fn)).toBe("ascii");
  });

  it("annotates a non-ASCII literal as utf8-guaranteed", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const s = b.emitStringConst("café");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);

    expect(readEnc(reg, "café", "string.const", fn)).toBe("utf8-guaranteed");
  });

  it("concat of two ASCII literals stays ascii", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const a = b.emitStringConst("foo");
    const c = b.emitStringConst("bar");
    const cat = b.emitStringConcat(a, c);
    b.terminate({ kind: "return", values: [cat] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);

    const catInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "string.concat")!;
    expect(reg.read<Encoding>(catInstr.alloc!, NS)).toBe("ascii");
  });

  it("concat of ascii + utf8 joins to utf8-guaranteed", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const a = b.emitStringConst("foo"); // ascii
    const c = b.emitStringConst("café"); // utf8
    const cat = b.emitStringConcat(a, c);
    b.terminate({ kind: "return", values: [cat] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);

    const catInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "string.concat")!;
    expect(reg.read<Encoding>(catInstr.alloc!, NS)).toBe("utf8-guaranteed");
  });

  it("concat with an untracked (param) operand is conservatively wtf16", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    const p = b.addParam("s", STR); // no origin rule → wtf16
    b.openBlock();
    const lit = b.emitStringConst("x"); // ascii
    const cat = b.emitStringConcat(p, lit);
    b.terminate({ kind: "return", values: [cat] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);

    const catInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "string.concat")!;
    expect(reg.read<Encoding>(catInstr.alloc!, NS)).toBe("wtf16");
  });

  it("is read-only — the IR function is structurally unchanged", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();
    const before = JSON.stringify(fn);

    analyzeEncoding(fn, reg);

    expect(JSON.stringify(fn)).toBe(before);
  });

  it("is idempotent — re-running yields the same annotation", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);
    const first = readEnc(reg, "hi", "string.const", fn);
    analyzeEncoding(fn, reg);
    const second = readEnc(reg, "hi", "string.const", fn);
    expect(second).toBe(first);
    expect(second).toBe("ascii");
  });
});

describe("#1588 Phase 2 — call-result origins + method propagation", () => {
  const callEnc = (reg: AllocSiteRegistry, fn: ReturnType<IrFunctionBuilder["finish"]>): Encoding | undefined => {
    const instr = fn.blocks[0]!.instrs.find((i) => i.kind === "call" && i.alloc !== undefined)!;
    return reg.read<Encoding>(instr.alloc!, NS);
  };

  it("JSON.parse / JSON.stringify results are utf8-guaranteed", () => {
    for (const fnName of ["JSON_parse", "JSON_stringify"]) {
      const reg = new AllocSiteRegistry();
      const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
      const arg = b.addParam("x", STR);
      b.openBlock();
      const r = b.emitCall(irImportFuncRef("env", fnName), [arg], STR)!;
      b.terminate({ kind: "return", values: [r] });
      const fn = b.finish();
      analyzeEncoding(fn, reg);
      expect(callEnc(reg, fn)).toBe("utf8-guaranteed");
    }
  });

  it("does not classify a source unit from a builtin-looking compatibility label", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("caller"), [STR], false, reg);
    const arg = b.addParam("x", STR);
    b.openBlock();
    const r = b.emitCall(irUnitFuncRef(identities.next("JSON_stringify")), [arg], STR)!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();

    analyzeEncoding(fn, reg);

    expect(callEnc(reg, fn)).toBe("wtf16");
  });

  it("encoding-preserving string methods propagate the receiver encoding", () => {
    // ASCII receiver → toUpperCase stays ascii.
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const recv = b.emitStringConst("hello"); // ascii
    const r = b.emitCall(irRuntimeFuncRef("string_toUpperCase"), [recv], STR)!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    analyzeEncoding(fn, reg);
    expect(callEnc(reg, fn)).toBe("ascii");
  });

  it("native-mode method prefix (__str_) also propagates", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const recv = b.emitStringConst("café"); // utf8-guaranteed
    const r = b.emitCall(irRuntimeFuncRef("__str_trim"), [recv], STR)!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    analyzeEncoding(fn, reg);
    expect(callEnc(reg, fn)).toBe("utf8-guaranteed");
  });

  it("slice is conservatively wtf16 (code-unit indices can split a pair)", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const recv = b.emitStringConst("hello"); // ascii receiver
    const r = b.emitCall(irRuntimeFuncRef("string_slice"), [recv], STR)!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    analyzeEncoding(fn, reg);
    expect(callEnc(reg, fn)).toBe("wtf16");
  });

  it("an unknown string-returning call is conservatively wtf16", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    b.openBlock();
    const r = b.emitCall(irUnitFuncRef(identities.next("someUserFunc")), [], STR)!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    analyzeEncoding(fn, reg);
    expect(callEnc(reg, fn)).toBe("wtf16");
  });

  it("a non-string-returning call gets no string alloc id / no annotation", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [irVal({ kind: "f64" })], false, reg);
    b.openBlock();
    const r = b.emitCall(irUnitFuncRef(identities.next("numFunc")), [], irVal({ kind: "f64" }))!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    analyzeEncoding(fn, reg);
    const call = fn.blocks[0]!.instrs.find((i) => i.kind === "call")!;
    expect(call.alloc).toBeUndefined();
  });

  it("TextDecoder.decode (extern.call) is utf8-guaranteed", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [STR], false, reg);
    const buf = b.addParam("buf", irVal({ kind: "externref" }));
    b.openBlock();
    const r = b.emitExternCall("TextDecoder", "decode", buf, [], STR)!;
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    analyzeEncoding(fn, reg);
    const ec = fn.blocks[0]!.instrs.find((i) => i.kind === "extern.call" && i.alloc !== undefined)!;
    expect(reg.read<Encoding>(ec.alloc!, NS)).toBe("utf8-guaranteed");
  });
});
