// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Six portable donor regressions. Each actual authority is named; no whole prepared/native claim.
import { describe, expect, it } from "vitest";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import { allocationEvidenceEffect } from "../src/ir/analysis/allocation-evidence/effect-rules.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import { assertFinalAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrInvariantError } from "../src/shared/contracts/ir-preparation-errors.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import {
  asAllocSiteId,
  asBlockId,
  asValueId,
  type IrFunction,
  type IrInstr,
  type IrModule,
} from "../src/ir/core/nodes.js";
import { irVal, irVec, type IrType, type IrObjectShape } from "../src/ir/core/types.js";
import { irImportFuncRef } from "../src/ir/core/callable-bindings.js";
import { irBindingKey } from "../src/ir/core/declared-types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false),
  STR: IrType = { kind: "string" };
const shape: IrObjectShape = { fields: [{ name: "x", type: F64 }] },
  OBJ: IrType = { kind: "object", shape };
const ids = createTestIrFunctionIdentityFactory("issue-6920-ae28-rule-regressions");
const a = asAllocSiteId,
  v = asValueId;
type Declarations = Parameters<typeof verifyIrFunction>[2];
type Mode = "encoding-only" | "ownership-only" | "escape-only" | "ownership-and-escape";
interface Fixture {
  fn: IrFunction;
  reg: AllocSiteRegistry;
}
function builder(result: readonly IrType[] = [F64], reg = new AllocSiteRegistry()) {
  const b = new IrFunctionBuilder(ids.next("rule"), result, false, reg);
  b.openBlock();
  return { b, reg };
}
function observe(f: Fixture, mode: Mode = "ownership-and-escape") {
  const original = structuredClone(f.fn);
  analyzeEncoding(f.fn, f.reg);
  const ownership = analyzeOwnership(
    f.fn,
    mode === "ownership-only" || mode === "ownership-and-escape" ? f.reg : undefined,
  );
  const escapeResult = analyzeEscape(
    f.fn,
    mode === "escape-only" || mode === "ownership-and-escape" ? f.reg : undefined,
    ownership,
  );
  expect(f.fn).toEqual(original);
  return { ownership, escape: escapeResult };
}
function validate(f: Fixture, declarations?: Declarations) {
  const snapshot = f.reg.captureSnapshot(),
    original = structuredClone({ fn: f.fn, snapshot });
  expect(verifyIrFunction(f.fn, undefined, declarations)).toEqual([]);
  expect(() => assertFinalAllocProvenance(f.fn, f.reg)).not.toThrow();
  expect(() =>
    assertPreparedIrProgramAllocations({ ir: { functions: [f.fn] }, allocations: snapshot, runtimeSupport: undefined }),
  ).not.toThrow();
  expect({ fn: f.fn, snapshot }).toEqual(original);
}
function opaqueStore(store: boolean) {
  const { b, reg } = builder();
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const initial = b.emitObjectNew(shape, [zero]),
    inner = b.emitObjectNew(shape, [zero]);
  const array = b.emitVecNewFixed([initial], OBJ, irVec(OBJ, false)),
    index = b.emitConst({ kind: "i32", value: 0 }, I32);
  if (store) b.emitVecSet(array, index, inner);
  b.terminate({ kind: "return", values: [zero] });
  return { fn: b.finish(), reg, inner, array };
}
function numeric(op: "read" | "write" | "unused", reg = new AllocSiteRegistry()): Fixture {
  const { b } = builder([F64], reg);
  const value = b.emitConst({ kind: "f64", value: 1.5 }, F64);
  const index = b.emitConst({ kind: "i32", value: 0 }, I32),
    array = b.emitVecNewFixed([value], F64, VEC);
  if (op === "read") b.emitVecGet(array, index, F64);
  else if (op === "write") b.emitVecSet(array, index, value);
  b.terminate({ kind: "return", values: [value] });
  return { fn: b.finish(), reg };
}
function core(instrs: readonly IrInstr[], count: number): IrFunction {
  return {
    ...ids.next("tagged-core"),
    params: [],
    resultTypes: [F64],
    exported: false,
    valueCount: count,
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [v(0)] } },
    ],
  };
}
const constant = (result: number, integer = false): IrInstr => ({
  kind: "const",
  result: v(result),
  resultType: integer ? I32 : F64,
  value: integer ? { kind: "i32", value: 0 } : { kind: "f64", value: 1.5 },
});
const array = (result: number, site = 0): IrInstr => ({
  kind: "vec.new_fixed",
  elements: [v(0)],
  elementType: F64,
  result: v(result),
  resultType: VEC,
  alloc: a(site),
});
function thrown(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw Error("negative control did not throw");
}

describe("issue-6920 canonical allocation rule regressions", () => {
  it("AR01 vector stores retain ownership escape and opaque backstop", () => {
    const local = opaqueStore(false),
      stored = opaqueStore(true);
    const before = observe(local);
    validate(local);
    expect(before.ownership.ownershipOf(local.inner)).toBe("owned");
    expect(before.ownership.accessOf(local.inner).toArray()).toEqual([]);
    expect(before.escape.of(local.inner)).toEqual({ classification: "local", stackAllocatable: true });
    const result = observe(stored);
    validate(stored);
    expect(result.ownership.ownershipOf(stored.inner)).toBe("escaped");
    expect(result.ownership.accessOf(stored.inner).toArray()).toEqual(["escape"]);
    expect(result.ownership.accessOf(stored.array).toArray()).toEqual(["write"]);
    expect(result.escape.of(stored.inner)).toEqual({ classification: "opaque", stackAllocatable: false });
    const store = stored.fn.blocks[0]!.instrs.find((i) => i.kind === "vec.set")!;
    expect(allocationEvidenceEffect(store)).toEqual({
      kind: "effects",
      ownership: [
        { value: stored.array, op: "write" },
        { value: stored.inner, op: "escape" },
      ],
      directEscape: [],
      encoding: "no-write",
    });
    expect(verifyAllocationEvidence({ functions: [stored.fn] }, stored.reg.captureSnapshot()).kind).toBe("not-covered");
    // Compatibility authority: real typed operations, fresh returned DATA at every nested level.
    const compatibility = builder(),
      cb = compatibility.b;
    const zero = cb.emitConst({ kind: "f64", value: 0 }, F64);
    const first = cb.emitObjectNew(shape, [zero]),
      second = cb.emitObjectNew(shape, [zero]);
    const left = cb.emitVecNewFixed([first], OBJ, irVec(OBJ, false));
    const right = cb.emitVecNewFixed([second], OBJ, irVec(OBJ, false));
    const index = cb.emitConst({ kind: "i32", value: 0 }, I32);
    cb.emitVecGet(left, index, OBJ);
    cb.emitVecLen(right);
    cb.emitVecSet(left, index, second);
    cb.emitVecSet(right, index, first);
    cb.terminate({ kind: "return", values: [zero] });
    const compatibilityFn = cb.finish();
    expect(verifyIrFunction(compatibilityFn)).toEqual([]);
    assertFinalAllocProvenance(compatibilityFn, compatibility.reg);
    const compatibilityOriginal = structuredClone(compatibilityFn);
    const instructions = compatibilityFn.blocks[0]!.instrs;
    const operations = instructions.filter((i) => i.kind === "vec.get" || i.kind === "vec.len" || i.kind === "vec.set");
    expect(operations).toHaveLength(4);
    const expectedEvents = [
      [{ value: left, op: "read" }],
      [{ value: right, op: "read" }],
      [
        { value: left, op: "write" },
        { value: second, op: "escape" },
      ],
      [
        { value: right, op: "write" },
        { value: first, op: "escape" },
      ],
    ];
    for (const [index, operation] of operations.entries()) {
      const firstResult = allocationEvidenceEffect(operation),
        secondResult = allocationEvidenceEffect(operation);
      expect(firstResult).toEqual({
        kind: "effects",
        ownership: expectedEvents[index],
        directEscape: [],
        encoding: "no-write",
      });
      expect(secondResult).toEqual(firstResult);
      expect(secondResult).not.toBe(firstResult);
      if (firstResult.kind !== "effects" || secondResult.kind !== "effects")
        throw Error("real compatibility vector unexpectedly unsupported");
      expect(secondResult.ownership).not.toBe(firstResult.ownership);
      expect(secondResult.directEscape).not.toBe(firstResult.directEscape);
      for (const [eventIndex, event] of firstResult.ownership.entries())
        expect(secondResult.ownership[eventIndex]).not.toBe(event);
    }
    const noOp = instructions[0]!;
    const firstNoOp = allocationEvidenceEffect(noOp),
      secondNoOp = allocationEvidenceEffect(noOp);
    expect(firstNoOp).toEqual({ kind: "effects", ownership: [], directEscape: [], encoding: "no-write" });
    expect(secondNoOp).toEqual(firstNoOp);
    expect(secondNoOp).not.toBe(firstNoOp);
    if (firstNoOp.kind !== "effects" || secondNoOp.kind !== "effects")
      throw Error("real compatibility constant unexpectedly unsupported");
    expect(secondNoOp.ownership).not.toBe(firstNoOp.ownership);
    expect(secondNoOp.directEscape).not.toBe(firstNoOp.directEscape);
    const unsupported = instructions.find((i) => i.kind === "object.new")!;
    const firstUnsupported = allocationEvidenceEffect(unsupported),
      secondUnsupported = allocationEvidenceEffect(unsupported);
    expect(firstUnsupported).toEqual({ kind: "unsupported" });
    expect(secondUnsupported).toEqual(firstUnsupported);
    expect(secondUnsupported).not.toBe(firstUnsupported);
    expect(compatibilityFn).toEqual(compatibilityOriginal);
  });
  it("AR02 reference aliases and nested effects retain original allocation escape", () => {
    const { b, reg } = builder([OBJ]);
    const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
    const left = b.emitObjectNew(shape, [zero]),
      right = b.emitObjectNew(shape, [zero]);
    const cond = b.emitConst({ kind: "i32", value: 1 }, I32),
      selected = b.emitSelect(cond, left, right, OBJ);
    b.terminate({ kind: "return", values: [selected] });
    const selectedFixture = { fn: b.finish(), reg };
    const selectedResult = observe(selectedFixture);
    validate(selectedFixture);
    for (const value of [left, right]) {
      expect(selectedResult.ownership.ownershipOf(value)).toBe("escaped");
      expect(selectedResult.ownership.accessOf(value).toArray()).toEqual(["escape"]);
      expect(selectedResult.escape.classOf(value)).toBe("opaque");
    }
    expect(verifyAllocationEvidence({ functions: [selectedFixture.fn] }, reg.captureSnapshot()).kind).toBe(
      "not-covered",
    );
    const nested = builder([OBJ]),
      nb = nested.b;
    const n = nb.emitConst({ kind: "f64", value: 0 }, F64),
      ix = nb.emitConst({ kind: "i32", value: 0 }, I32);
    const vec = nb.emitVecNewFixed([n], F64, VEC),
      condition = nb.emitConst({ kind: "i32", value: 0 }, I32);
    let thenValue: ReturnType<typeof nb.emitObjectNew> | undefined,
      elseValue: ReturnType<typeof nb.emitObjectNew> | undefined;
    const then = nb.collectBodyInstrs(() => {
      nb.emitVecSet(vec, ix, n);
      thenValue = nb.emitObjectNew(shape, [n]);
    });
    const otherwise = nb.collectBodyInstrs(() => {
      elseValue = nb.emitObjectNew(shape, [n]);
    });
    if (thenValue === undefined || elseValue === undefined) throw Error("real arm construction did not produce values");
    const result = nb.emitIfElse({ cond: condition, then, thenValue, else: otherwise, elseValue, resultType: OBJ });
    nb.terminate({ kind: "return", values: [result] });
    const nf = { fn: nb.finish(), reg: nested.reg };
    const nr = observe(nf);
    validate(nf);
    expect(nr.ownership.accessOf(vec).toArray()).toEqual(["write"]);
    for (const value of [thenValue, elseValue]) {
      expect(nr.ownership.ownershipOf(value)).toBe("escaped");
      expect(nr.escape.classOf(value)).toBe("opaque");
    }
    expect(verifyAllocationEvidence({ functions: [nf.fn] }, nf.reg.captureSnapshot()).kind).toBe("not-covered");
    const primitive = builder(),
      pb = primitive.b;
    const pv = pb.emitConst({ kind: "f64", value: 2 }, F64),
      pi = pb.emitConst({ kind: "i32", value: 0 }, I32);
    const pa = pb.emitVecNewFixed([pv], F64, VEC),
      pc = pb.emitConst({ kind: "i32", value: 0 }, I32);
    let tv: typeof pv | undefined, ev: typeof pv | undefined;
    const pt = pb.collectBodyInstrs(() => {
      pb.emitVecSet(pa, pi, pv);
      tv = pb.emitConst({ kind: "f64", value: 3 }, F64);
    });
    const pe = pb.collectBodyInstrs(() => {
      ev = pb.emitConst({ kind: "f64", value: NaN }, F64);
    });
    if (tv === undefined || ev === undefined) throw Error("primitive arms did not produce values");
    const pr = pb.emitIfElse({ cond: pc, then: pt, thenValue: tv, else: pe, elseValue: ev, resultType: F64 });
    pb.terminate({ kind: "return", values: [pr] });
    const pf = { fn: pb.finish(), reg: primitive.reg };
    expect(observe(pf).ownership.accessOf(pa).toArray()).toEqual(["write"]);
    validate(pf);
    expect(verifyAllocationEvidence({ functions: [pf.fn] }, pf.reg.captureSnapshot())).toMatchObject({
      kind: "verified",
      namespaces: "ownership-and-escape",
    });
  });
  it("AR03 identity comparisons and declared opaque calls preserve canonical effects", () => {
    for (const op of ["i32.eq", "i32.ne", "i32.lt_u"] as const) {
      const reg = new AllocSiteRegistry();
      reg.fresh("object", I32);
      reg.fresh("object", I32);
      const fn = core(
        [
          constant(0),
          { ...constant(1, true), alloc: a(0) },
          { ...constant(2, true), alloc: a(1) },
          { kind: "binary", op, lhs: v(1), rhs: v(2), result: v(3), resultType: I32 },
        ],
        4,
      );
      const f = { fn, reg },
        r = observe(f);
      validate(f);
      for (const value of [v(1), v(2)]) {
        expect(r.ownership.ownershipOf(value)).toBe("owned");
        expect(r.ownership.accessOf(value).toArray()).toEqual(op === "i32.lt_u" ? [] : ["identity"]);
        expect(r.escape.classOf(value)).toBe("local");
      }
      expect(verifyAllocationEvidence({ functions: [fn] }, reg.captureSnapshot()).kind).toBe("not-covered");
    }
    const sum = builder(),
      sb = sum.b,
      x = sb.emitConst({ kind: "f64", value: 1.5 }, F64);
    const arr = sb.emitVecNewFixed([x], F64, VEC),
      added = sb.emitBinary("f64.add", x, x, F64);
    sb.terminate({ kind: "return", values: [added] });
    const sf = { fn: sb.finish(), reg: sum.reg };
    expect(observe(sf).ownership.accessOf(arr).toArray()).toEqual([]);
    validate(sf);
    expect(verifyAllocationEvidence({ functions: [sf.fn] }, sf.reg.captureSnapshot()).kind).toBe("verified");
    for (const returned of [false, true]) {
      const f = builder(returned ? [OBJ] : [F64]),
        b = f.b;
      const zero = b.emitConst({ kind: "f64", value: 0 }, F64),
        object = b.emitObjectNew(shape, [zero]);
      const target = irImportFuncRef("@test/ae28", "sink"),
        key = irBindingKey(target.binding);
      if (!key) throw Error("actual import binding has no canonical key");
      if (!returned) b.emitCall(target, [object], null);
      b.terminate({ kind: "return", values: [returned ? object : zero] });
      const fixture = { fn: b.finish(), reg: f.reg };
      const declarations: Declarations = { declaredSignatures: new Map([[key, { params: [OBJ], result: null }]]) };
      const r = observe(fixture);
      validate(fixture, declarations);
      if (!returned)
        expect(
          verifyIrFunction(fixture.fn, undefined, {
            declaredSignatures: new Map([[key, { params: [], result: null }]]),
          }).length,
        ).toBeGreaterThan(0);
      expect(r.ownership.ownershipOf(object)).toBe("escaped");
      expect(r.ownership.accessOf(object).toArray()).toEqual(["escape"]);
      expect(r.escape.classOf(object)).toBe(returned ? "returned" : "opaque");
    }
  });
  it("AR04 nested string instructions retain encoding writes and presence", () => {
    const { b, reg } = builder([STR]),
      cond = b.emitConst({ kind: "i32", value: 1 }, I32);
    let tv: ReturnType<typeof b.emitStringConst> | undefined, ev: ReturnType<typeof b.emitStringConst> | undefined;
    const then = b.collectBodyInstrs(() => {
      const ascii = b.emitStringConst("x"),
        utf8 = b.emitStringConst("café");
      tv = b.emitStringConcat(ascii, utf8);
    });
    const otherwise = b.collectBodyInstrs(() => {
      ev = b.emitStringConst("a\ud800b");
    });
    if (tv === undefined || ev === undefined) throw Error("real string arms did not produce values");
    const chosen = b.emitIfElse({ cond, then, thenValue: tv, else: otherwise, elseValue: ev, resultType: STR });
    b.terminate({ kind: "return", values: [chosen] });
    const f = { fn: b.finish(), reg };
    observe(f);
    validate(f);
    expect(
      reg.captureSnapshot().metadata.map((row) => row.entries.find(([ns]) => ns === ALLOC_NAMESPACES.encoding)?.[1]),
    ).toEqual(["ascii", "utf8-guaranteed", "utf8-guaranteed", "wtf16"]);
    expect(verifyAllocationEvidence({ functions: [f.fn] }, reg.captureSnapshot()).kind).toBe("not-covered");
    const repeat = builder([STR]),
      rb = repeat.b;
    const fragment = rb.emitStringConst("x"),
      count = rb.emitConst({ kind: "f64", value: 2 }, F64);
    const repeated = rb.emitStringRepeat(fragment, count, "ascii");
    rb.terminate({ kind: "return", values: [repeated] });
    const rf = { fn: rb.finish(), reg: repeat.reg };
    observe(rf);
    validate(rf);
    const repeatInstr = rf.fn.blocks[0]!.instrs.find((i) => i.kind === "string.repeat");
    if (!repeatInstr || repeatInstr.alloc === undefined) throw Error("actual repeat lost its real allocation");
    expect(rf.reg.read(repeatInstr.alloc, ALLOC_NAMESPACES.encoding)).toBe("ascii");
    // Deliberately invalid raw evidence mutation: preserve the contextual failure and the solver's own-undefined write.
    const invalid = structuredClone(rf.fn),
      bad = invalid.blocks[0]!.instrs.find((i) => i.kind === "string.repeat")!;
    Reflect.set(bad, "encodingEvidence", undefined);
    expect(verifyIrFunction(invalid).map((e) => e.message)).toContain(
      "string.repeat has invalid encoding evidence undefined",
    );
    const original = structuredClone(invalid);
    analyzeEncoding(invalid, rf.reg);
    const row = rf.reg.captureSnapshot().metadata.find((r) => r.id === repeatInstr.alloc)!;
    const encoding = row.entries.find(([ns]) => ns === ALLOC_NAMESPACES.encoding)!;
    expect(encoding).toEqual([ALLOC_NAMESPACES.encoding, undefined]);
    expect(Object.hasOwn(encoding, 1)).toBe(true);
    expect(invalid).toEqual(original);
  });
  it("AR05 carriers and reused sites retain canonical ordered annotations", () => {
    const reg = new AllocSiteRegistry();
    reg.fresh("array", VEC);
    reg.fresh("object", F64);
    const fn = core([{ ...constant(0), alloc: a(1) }, array(1)], 2),
      f = { fn, reg };
    const r = observe(f);
    validate(f);
    expect(r.ownership.ownershipOf(v(0))).toBe("escaped");
    expect(r.ownership.accessOf(v(0)).toArray()).toEqual(["escape"]);
    expect(r.escape.classOf(v(0))).toBe("returned");
    expect(verifyAllocationEvidence({ functions: [fn] }, reg.captureSnapshot()).kind).toBe("not-covered");
    const complete = reg.captureSnapshot(),
      missing = { ...complete, metadata: complete.metadata.filter((row) => row.id !== a(1)) };
    const error = thrown(() =>
      assertPreparedIrProgramAllocations({ ir: { functions: [fn] }, allocations: missing, runtimeSupport: undefined }),
    );
    expect(error).toBeInstanceOf(PreparedIrProgramInvariantError);
    expect(error.message).toBe("program allocations: site 1 has missing or stale ownership evidence");
    expect(verifyAllocationEvidence({ functions: [fn] }, missing).kind).toBe("not-covered");
    for (const reversed of [false, true]) {
      const repeatedReg = new AllocSiteRegistry();
      repeatedReg.fresh("array", VEC);
      const definitions = reversed ? [array(3), array(2)] : [array(2), array(3)];
      const repeated = core(
        [
          constant(0),
          constant(1, true),
          ...definitions,
          { kind: "vec.get", vec: v(2), index: v(1), result: v(4), resultType: F64 },
          { kind: "vec.set", vec: v(3), index: v(1), newValue: v(0), result: null, resultType: null },
        ],
        5,
      );
      const fixture = { fn: repeated, reg: repeatedReg };
      observe(fixture);
      validate(fixture);
      expect(repeatedReg.read(a(0), ALLOC_NAMESPACES.ownership)).toEqual({
        state: "owned",
        ops: [reversed ? "read" : "write"],
      });
      expect(repeatedReg.read(a(0), ALLOC_NAMESPACES.escape)).toEqual({
        classification: "local",
        stackAllocatable: true,
      });
      expect(verifyAllocationEvidence({ functions: [repeated] }, repeatedReg.captureSnapshot())).toMatchObject({
        kind: "not-covered",
        reason: "allocation-site-reuse",
      });
    }
    for (const reversed of [false, true]) {
      const repeatedReg = new AllocSiteRegistry();
      repeatedReg.fresh("array", VEC);
      const read = core(
        [
          constant(0),
          constant(1, true),
          array(2),
          { kind: "vec.get", vec: v(2), index: v(1), result: v(3), resultType: F64 },
        ],
        4,
      );
      const write = core(
        [
          constant(0),
          constant(1, true),
          array(2),
          { kind: "vec.set", vec: v(2), index: v(1), newValue: v(0), result: null, resultType: null },
        ],
        3,
      );
      const functions = reversed ? [write, read] : [read, write];
      for (const owner of functions) {
        observe({ fn: owner, reg: repeatedReg });
        expect(verifyIrFunction(owner)).toEqual([]);
        assertFinalAllocProvenance(owner, repeatedReg);
      }
      const snapshot = repeatedReg.captureSnapshot();
      expect(snapshot.metadata[0]!.entries.find(([ns]) => ns === ALLOC_NAMESPACES.ownership)?.[1]).toEqual({
        state: "owned",
        ops: [reversed ? "read" : "write"],
      });
      expect(() =>
        assertPreparedIrProgramAllocations({ ir: { functions }, allocations: snapshot, runtimeSupport: undefined }),
      ).not.toThrow();
      expect(verifyAllocationEvidence({ functions }, snapshot)).toMatchObject({
        kind: "not-covered",
        reason: "allocation-site-reuse",
      });
    }
  });
  it("AR06 global namespaces and unused provenance retain exact metadata truth", () => {
    for (const mode of ["encoding-only", "ownership-only", "escape-only", "ownership-and-escape"] as const) {
      const reg = new AllocSiteRegistry(),
        read = numeric("read", reg),
        write = numeric("write", reg);
      const unused = reg.fresh("object", F64),
        retired = reg.fresh("object", F64),
        alias = reg.fresh("object", F64);
      reg.alias(alias, retired);
      reg.retire(retired);
      observe(read, mode);
      observe(write, mode);
      const snapshot = reg.captureSnapshot(),
        withEmpty = { ...snapshot, metadata: [...snapshot.metadata, { id: unused, entries: [] }] };
      const module: IrModule = { functions: [read.fn, write.fn] },
        original = structuredClone({ module, snapshot: withEmpty });
      for (const fn of module.functions) {
        expect(verifyIrFunction(fn)).toEqual([]);
        assertFinalAllocProvenance(fn, reg);
      }
      expect(() =>
        assertPreparedIrProgramAllocations({ ir: module, allocations: withEmpty, runtimeSupport: undefined }),
      ).not.toThrow();
      expect(reg.isKnown(alias)).toBe(true);
      expect(reg.resolve(alias)).toBeNull();
      expect(snapshot.entries[retired]).toEqual({ state: "retired" });
      expect(snapshot.entries[alias]).toEqual({ state: "aliased", to: retired });
      expect(verifyAllocationEvidence(module, withEmpty)).toEqual({
        kind: "verified",
        profile: "single-block-numeric-vector-if-v1",
        namespaces: mode,
        census: {
          functions: 2,
          buffers: 2,
          instructions: 8,
          allocations: 2,
          vectorReads: 1,
          vectorWrites: 1,
          registrySlots: 5,
        },
      });
      const permuted = {
        ...withEmpty,
        metadata: [...withEmpty.metadata].reverse().map((row) => ({ ...row, entries: [...row.entries].reverse() })),
      };
      expect(() =>
        assertPreparedIrProgramAllocations({ ir: module, allocations: permuted, runtimeSupport: undefined }),
      ).not.toThrow();
      expect(verifyAllocationEvidence(module, permuted)).toEqual(verifyAllocationEvidence(module, withEmpty));
      expect({ module, snapshot: withEmpty }).toEqual(original);
      if (mode !== "encoding-only") {
        const missing = { ...withEmpty, metadata: withEmpty.metadata.filter((row) => row.id !== a(1)) };
        expect(() =>
          assertPreparedIrProgramAllocations({ ir: module, allocations: missing, runtimeSupport: undefined }),
        ).toThrow(PreparedIrProgramInvariantError);
        expect(verifyAllocationEvidence(module, missing)).toMatchObject({
          kind: "invalid",
          code: "namespace-presence",
          at: { kind: "site", site: a(1) },
        });
      }
      const body = read.fn.blocks[0]!.instrs,
        usedAlias = {
          ...read.fn,
          blocks: [
            {
              ...read.fn.blocks[0]!,
              instrs: body.map((i) => (i.kind === "vec.new_fixed" ? { ...i, alloc: alias } : i)),
            },
          ],
        };
      expect(() => assertFinalAllocProvenance(usedAlias, reg)).toThrow(IrInvariantError);
      expect(() =>
        assertPreparedIrProgramAllocations({
          ir: { functions: [usedAlias] },
          allocations: withEmpty,
          runtimeSupport: undefined,
        }),
      ).toThrow(IrInvariantError);
    }
  });
});
