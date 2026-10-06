// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { irVal, forEachInstrDeep, type IrSiteId, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import type { IrSourceMapOrigin } from "../src/shared/contracts/ir-unit-inventory.js";
import { ts } from "../src/ts-api.js";
import { sourcePacket, sourceInput, typedOptions } from "./helpers/typed-program-fixtures.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { preparedIrDataMismatch, type PreparedIrBackendOptions } from "../src/ir/program.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";

// Manually supplied sites are builder DATA controls, not authentic frontend capture.
type CapturedSite = Extract<IrSiteId, { readonly origin: IrSourceMapOrigin }>;
const F64 = irVal({ kind: "f64" });
const SOURCE = "export function build(value:number):number { return value+2; }";
function fixture() {
  const files = { "./entry.ts": SOURCE };
  const source = sourcePacket(files),
    ast = sourceInput(files);
  const fn = source.packet.ir.functions[0]!;
  const unit = source.packet.inventory.allUnits.find((record) => record.id === fn.unitId)!;
  const sf = ast.entrySource;
  const declaration = sf.statements.find(ts.isFunctionDeclaration)!;
  let expression: ts.BinaryExpression | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) expression = node;
    ts.forEachChild(node, find);
  };
  find(declaration);
  if (!expression) throw new Error("actual numeric source expression absent");
  const site = (node: ts.Node): CapturedSite => {
    const start = node.getStart(sf),
      end = node.getEnd();
    const location = sf.getLineAndCharacterOfPosition(start);
    return {
      line: location.line + 1,
      column: location.character,
      origin: {
        kind: "source",
        point: {
          sourceId: unit.sourceId,
          donorUnitId: unit.id,
          analyzed: { start, end },
          original: { start, end },
          mapping: "exact",
        },
      },
    };
  };
  const outer = site(declaration),
    inner = site(expression),
    generated: CapturedSite = {
      origin: {
        kind: "generated",
        phase: "frontend",
        role: "implicit-return",
        ownerUnitId: unit.id,
        cause: inner.origin.kind === "source" ? inner.origin.point : undefined,
      },
    };
  return { ...source, id: { unitId: fn.unitId, name: fn.name }, outer, inner, generated };
}
function builder(
  f: ReturnType<typeof fixture>,
  selection: "omitted" | boolean = true,
  registry?: AllocSiteRegistry,
): IrFunctionBuilder {
  const args: unknown[] = [f.id, [F64], true, registry, undefined];
  if (selection !== "omitted") args.push(selection);
  return Reflect.construct(IrFunctionBuilder, args);
}
function scope<T>(b: IrFunctionBuilder, site: unknown, run: () => T): T {
  const method = Reflect.get(b, "withSourceSite");
  expect(typeof method, "actual requested builder scope API exists").toBe("function");
  return Reflect.apply(method, b, [site, run]);
}
function refusal(run: () => unknown, copy = false): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(
    copy
      ? /^(IrFunctionBuilder: requested source origin|invalid preparation data: accessor)/
      : /^IrFunctionBuilder: requested source origin/,
  );
}
function all(fn: IrFunction): IrInstr[] {
  const list: IrInstr[] = [];
  for (const block of fn.blocks) for (const instr of block.instrs) forEachInstrDeep(instr, (child) => list.push(child));
  return list;
}
function snap(value: unknown): string {
  return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, sorted: true });
}
function constant(b: IrFunctionBuilder, value = 2) {
  return b.emitConst({ kind: "f64", value }, F64);
}
function close(b: IrFunctionBuilder, value: ReturnType<typeof constant>, f: ReturnType<typeof fixture>) {
  scope(b, f.outer, () => b.terminate({ kind: "return", values: [value] }));
  return b.finish();
}
function valid(fn: IrFunction) {
  expect(verifyIrFunction(fn)).toEqual([]);
}

function allocationPayload() {
  const f = sourcePacket({
    "./entry.ts":
      "export function build(value:number):number { const object={value}; const adjust=(x:number):number=>x+1; return adjust(object.value); }",
  });
  const instructions = f.packet.ir.functions.flatMap(all);
  const object = instructions.find((instr) => instr.kind === "object.new"),
    closure = instructions.find((instr) => instr.kind === "closure.new");
  if (!object || object.kind !== "object.new" || !closure || closure.kind !== "closure.new")
    throw new Error("genuine allocation producer population absent");
  expect(object.shape.fields).toHaveLength(1);
  expect(closure.captureFieldTypes).toEqual([]);
  return { object, closure };
}

describe("requested lexical builder source-origin DATA scopes", () => {
  it("captures source→generated→source nesting and restores the exact parent site", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    scope(b, f.outer, () => {
      constant(b, 1);
      scope(b, f.generated, () => constant(b, 2));
      scope(b, f.inner, () => constant(b, 3));
      constant(b, 4);
    });
    refusal(() => constant(b, 5));
    const end = scope(b, f.outer, () => constant(b, 6));
    const fn = close(b, end, f);
    valid(fn);
    expect(all(fn).map((instr) => instr.site)).toEqual([f.outer, f.generated, f.inner, f.outer, f.outer]);
    expect(Object.hasOwn(all(fn)[1]!.site!, "line")).toBe(false);
    expect(Object.hasOwn(all(fn)[1]!.site!, "column")).toBe(false);
    expect(all(fn)[0]!.site).toBe(all(fn)[3]!.site);
    expect(all(fn)[0]!.site).not.toBe(f.outer);
  });
  it("preserves distinct child body origins without overwriting them from the enclosing statement", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    const cond = scope(b, f.outer, () =>
      b.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32", boolean: true })),
    );
    const then = scope(b, f.inner, () => b.collectBodyInstrs(() => constant(b, 3))),
      otherwise = scope(b, f.generated, () => b.collectBodyInstrs(() => constant(b, 4)));
    scope(b, f.outer, () => b.emitIfStmt({ cond, then, else: otherwise }));
    const end = scope(b, f.outer, () => constant(b));
    const fn = close(b, end, f);
    valid(fn);
    const statement = fn.blocks[0]!.instrs.find((instr) => instr.kind === "if.stmt");
    if (!statement || statement.kind !== "if.stmt") throw new Error("actual nested statement absent");
    expect(statement.site).toEqual(f.outer);
    expect(statement.then).toBe(then);
    expect(statement.else).toBe(otherwise);
    expect(statement.then[0]!.site).toEqual(f.inner);
    expect(statement.else[0]!.site).toEqual(f.generated);
  });
  it("restores both lexical and nested body buffers after an inner throw without rolling back prior emissions", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    const sentinel = Object.freeze({ marker: "inner" });
    let caught: unknown;
    const outer = scope(b, f.outer, () =>
      b.collectBodyInstrs(() => {
        constant(b, 1);
        try {
          scope(b, f.inner, () =>
            b.collectBodyInstrs(() => {
              constant(b, 99);
              throw sentinel;
            }),
          );
        } catch (error) {
          caught = error;
        }
        constant(b, 2);
      }),
    );
    expect(caught).toBe(sentinel);
    expect(outer).toHaveLength(2);
    expect(outer.map((instr) => instr.site)).toEqual([f.outer, f.outer]);
    const end = scope(b, f.outer, () => constant(b, 3));
    const fn = close(b, end, f);
    valid(fn);
    expect(fn.blocks[0]!.instrs).toHaveLength(1);
    expect(end).toBeGreaterThan(outer[1]!.result!);
    refusal(() => constant(b, 4));
  });
  it("does not roll back committed root instructions or registry entries after an arbitrary scope callback throws", () => {
    const f = fixture(),
      registry = new AllocSiteRegistry(),
      b = builder(f, true, registry);
    b.openBlock();
    const sentinel = { marker: "throw-after-string" };
    let caught: unknown;
    try {
      scope(b, f.inner, () => {
        b.emitStringConst("kept");
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    expect(registry.size).toBe(1);
    refusal(() => b.emitStringConst("unscoped"));
    expect(registry.size).toBe(1);
    const end = scope(b, f.outer, () => constant(b));
    const fn = close(b, end, f);
    expect(all(fn).filter((instr) => instr.kind === "string.const")).toHaveLength(1);
    expect(all(fn)[0]!.site).toEqual(f.inner);
  });
  it("captures actual return and branch terminators with valid CFG/SSA and their own active sites", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    const value = scope(b, f.outer, () => constant(b));
    const target = b.reserveBlockId();
    refusal(() => b.terminate({ kind: "br", branch: { target, args: [] } }));
    scope(b, f.generated, () => b.terminate({ kind: "br", branch: { target, args: [] } }));
    b.openReservedBlock(target);
    scope(b, f.inner, () => b.terminate({ kind: "return", values: [value] }));
    const fn = b.finish();
    valid(fn);
    expect(fn.blocks.map((block) => block.terminator.site)).toEqual([f.generated, f.inner]);
  });
  it.each(["string", "object", "closure", "refcell"])(
    "captures one %s allocation at creation with real registry kind/type/ID/order",
    (kind) => {
      const f = fixture(),
        registry = new AllocSiteRegistry(),
        b = builder(f, true, registry);
      const x = b.addParam("value", F64);
      b.openBlock();
      const payload = allocationPayload();
      scope(b, f.inner, () => {
        switch (kind) {
          case "string":
            b.emitStringConst("text");
            break;
          case "object":
            b.emitObjectNew(payload.object.shape, [x]);
            break;
          case "closure":
            b.emitClosureNew(payload.closure.liftedFunc, payload.closure.signature, [], []);
            break;
          case "refcell":
            b.emitRefCellNew(x, { kind: "f64" });
            break;
        }
      });
      const fn = close(b, x, f);
      valid(fn);
      const allocated = all(fn).filter((instr) => instr.alloc !== undefined);
      expect(allocated).toHaveLength(1);
      expect(registry.size).toBe(1);
      expect(allocated[0]!.alloc).toBe(0);
      const created = registry.resolve(allocated[0]!.alloc!);
      expect(created?.kind).toBe(kind);
      expect(created?.type).toBe(allocated[0]!.resultType);
      expect(created?.origin).toEqual(f.inner);
      expect(created?.origin).toBe(allocated[0]!.site);
      console.log(
        "BUILDER_ALLOCATION",
        JSON.stringify({ kind, valueCount: fn.valueCount, entry: registry.snapshot() }),
      );
    },
  );
  it("mints each actual allocation once in stable emission order", () => {
    const f = fixture(),
      registry = new AllocSiteRegistry(),
      b = builder(f, true, registry);
    const x = b.addParam("value", F64);
    b.openBlock();
    const p = allocationPayload();
    scope(b, f.outer, () => {
      b.emitStringConst("first");
      b.emitObjectNew(p.object.shape, [x]);
      b.emitClosureNew(p.closure.liftedFunc, p.closure.signature, [], []);
      b.emitRefCellNew(x, { kind: "f64" });
    });
    const fn = close(b, x, f);
    valid(fn);
    expect(
      all(fn)
        .filter((instr) => instr.alloc !== undefined)
        .map((instr) => instr.alloc),
    ).toEqual([0, 1, 2, 3]);
    expect(registry.liveSites().map((entry) => entry.kind)).toEqual(["string", "object", "closure", "refcell"]);
    expect(registry.size).toBe(4);
  });
  it.each([true, false])(
    "refuses requested unscoped allocation before fresh with registry=%s; later valid emission succeeds",
    (hasRegistry) => {
      const f = fixture(),
        registry = hasRegistry ? new AllocSiteRegistry() : undefined,
        b = builder(f, true, registry);
      b.openBlock();
      refusal(() => b.emitStringConst("bad"));
      expect(registry?.size ?? 0).toBe(0);
      const value = scope(b, f.outer, () => constant(b));
      scope(b, f.inner, () => b.emitStringConst("good"));
      const fn = close(b, value, f);
      valid(fn);
      expect(all(fn).filter((instr) => instr.kind === "string.const")).toHaveLength(1);
      expect(registry?.size ?? 0).toBe(hasRegistry ? 1 : 0);
      expect(fn.valueCount).toBeGreaterThan(2);
    },
  );
  it("retains an explicit richer origin and enriches matching diagnostic coordinates only", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    const value = scope(b, f.outer, () => constant(b));
    scope(b, f.outer, () => b.terminate({ kind: "return", values: [value], site: f.inner }));
    const fn = b.finish();
    expect(fn.blocks[0]!.terminator.site).toEqual(f.inner);
    expect(fn.blocks[0]!.terminator.site).not.toBe(f.inner);
    const second = builder(f);
    second.openBlock();
    const end = scope(second, f.inner, () => constant(second));
    scope(second, f.inner, () =>
      second.terminate({ kind: "return", values: [end], site: { line: f.inner.line!, column: f.inner.column! } }),
    );
    expect(second.finish().blocks[0]!.terminator.site).toEqual(f.inner);
  });
  it.each(["mismatch", "generated"])("refuses %s diagnostic enrichment before terminating the block", (kind) => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    const value = scope(b, f.outer, () => constant(b));
    const parent = kind === "generated" ? f.generated : f.outer;
    scope(b, parent, () =>
      refusal(() =>
        b.terminate({ kind: "return", values: [value], site: { line: f.inner.line!, column: f.inner.column! } }),
      ),
    );
    expect(() => b.finish()).toThrow(/still open/);
    valid(close(b, value, f));
  });
  it.each(["diagnostic", "line-zero", "column-negative", "fraction", "boxed", "generated-coordinates"])(
    "refuses %s scope DATA before callbacks or append and then permits healthy scope",
    (kind) => {
      const f = fixture(),
        b = builder(f);
      b.openBlock();
      let runs = 0;
      let site: unknown = f.outer;
      if (kind === "diagnostic") site = { line: 1, column: 0 };
      if (kind === "line-zero") site = { ...f.outer, line: 0 };
      if (kind === "column-negative") site = { ...f.outer, column: -1 };
      if (kind === "fraction") site = { ...f.outer, line: 1.5 };
      if (kind === "boxed") site = new String("site");
      if (kind === "generated-coordinates") site = { ...f.generated, line: 1, column: 0 };
      const attempt = () =>
        scope(b, site, () => {
          runs++;
          constant(b);
        });
      if (kind === "boxed") expect(attempt).toThrow(/^invalid preparation data: unsupported object instance$/);
      else refusal(attempt);
      expect(runs).toBe(0);
      const value = scope(b, f.outer, () => constant(b));
      const fn = close(b, value, f);
      valid(fn);
      expect(all(fn)).toHaveLength(1);
    },
  );
  it("rejects site/origin getters without invoking them, with a healthy scope before and after", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    scope(b, f.outer, () => constant(b));
    let getters = 0;
    const bad = {};
    Object.defineProperty(bad, "origin", {
      enumerable: true,
      get() {
        getters++;
        return f.outer.origin;
      },
    });
    refusal(() => scope(b, bad, () => constant(b)), true);
    expect(getters).toBe(0);
    const value = scope(b, f.outer, () => constant(b));
    valid(close(b, value, f));
  });
  it("detaches captured scope from later caller mutation", () => {
    const f = fixture(),
      b = builder(f),
      site = structuredClone(f.inner),
      expected = structuredClone(site);
    b.openBlock();
    scope(b, site, () => {
      constant(b, 1);
      Reflect.set(site, "line", 999);
      if (site.origin.kind !== "source") throw new Error("source fixture absent");
      Reflect.set(site.origin.point.original, "end", 0);
      constant(b, 2);
    });
    const end = scope(b, f.outer, () => constant(b));
    const fn = close(b, end, f);
    expect(
      all(fn)
        .slice(0, 2)
        .map((instr) => instr.site),
    ).toEqual([expected, expected]);
  });
  it("freezes exposed body origins so mutation cannot change later active-scope emissions", () => {
    const f = fixture(),
      b = builder(f);
    b.openBlock();
    let exposed: IrSiteId | undefined;
    scope(b, f.inner, () => {
      const body = b.collectBodyInstrs(() => constant(b, 1));
      exposed = body[0]!.site;
      expect(Object.isFrozen(exposed)).toBe(true);
      expect(Object.isFrozen(exposed!.origin)).toBe(true);
      expect(exposed!.origin?.kind).toBe("source");
      if (exposed!.origin?.kind !== "source") throw new Error("source exposure absent");
      expect(Object.isFrozen(exposed!.origin.point.original)).toBe(true);
      expect(Reflect.set(exposed!.origin.point.original, "end", 0)).toBe(false);
      constant(b, 2);
    });
    const end = scope(b, f.outer, () => constant(b));
    const fn = close(b, end, f);
    expect(all(fn)[0]!.site).toBe(exposed);
    expect(all(fn)[0]!.site).toEqual(f.inner);
  });
  it("freezes registry creation origin so public resolve/snapshot aliases cannot change current capture", () => {
    const f = fixture(),
      registry = new AllocSiteRegistry(),
      b = builder(f, true, registry);
    b.openBlock();
    scope(b, f.inner, () => {
      b.emitStringConst("first");
      const origin = registry.liveSites()[0]!.origin!;
      expect(Object.isFrozen(origin)).toBe(true);
      expect(origin.origin?.kind).toBe("source");
      if (origin.origin?.kind !== "source") throw new Error("source allocation origin absent");
      expect(Object.isFrozen(origin.origin.point.original)).toBe(true);
      expect(Reflect.set(origin.origin.point.original, "end", 0)).toBe(false);
      const snapshot = registry.snapshot();
      const entry = snapshot.entries[0]!;
      expect(entry.state).toBe("live");
      if (entry.state !== "live") throw new Error("live allocation snapshot absent");
      const snapshotOrigin = entry.site.origin!;
      expect(snapshotOrigin).toBe(origin);
      if (snapshotOrigin.origin?.kind !== "source") throw new Error("snapshot source origin absent");
      expect(Reflect.set(snapshotOrigin.origin.point.original, "end", 0)).toBe(false);
      b.emitStringConst("second");
    });
    const end = scope(b, f.outer, () => constant(b));
    const fn = close(b, end, f);
    expect(registry.size).toBe(2);
    expect(
      all(fn)
        .filter((instr) => instr.kind === "string.const")
        .map((instr) => instr.site),
    ).toEqual([f.inner, f.inner]);
  });
});

describe("unchanged default builder path and genuine no-map program controls", () => {
  it("omitted and false preserve prototype delegates, complete IR own fields and original undefined registry origin", () => {
    const f = fixture();
    const results = ["omitted", false].map((selection) => {
      const registry = new AllocSiteRegistry(),
        b = builder(f, selection as "omitted" | false, registry);
      expect(Object.hasOwn(b, "pushInstr")).toBe(false);
      expect(Object.hasOwn(b, "terminate")).toBe(false);
      expect(Object.hasOwn(b, "allocId")).toBe(false);
      const x = b.addParam("value", F64);
      b.openBlock();
      const c = constant(b);
      const sum = b.emitBinary("f64.add", x, c, F64);
      b.emitStringConst("allocation");
      b.terminate({ kind: "return", values: [sum] });
      const fn = b.finish();
      valid(fn);
      expect(registry.size).toBe(1);
      expect(Object.hasOwn(registry.liveSites()[0]!, "origin")).toBe(true);
      expect(registry.liveSites()[0]!.origin).toBeUndefined();
      expect(all(fn).every((instr) => !Object.hasOwn(instr, "site"))).toBe(true);
      expect(Object.hasOwn(fn.blocks[0]!.terminator, "site")).toBe(false);
      return { builderOwn: Reflect.ownKeys(b), fn, registry: registry.snapshot() };
    });
    expect(snap(results[0])).toBe(snap(results[1]));
  });
  it.each(["wasmgc", "linear"] as const)(
    "%s omitted/false genuine typed capture, canonical codec and numeric execution remain exact",
    async (backend) => {
      const f = fixture();
      const produced = [];
      for (const selected of ["omitted", false] as const) {
        const b = builder(f, selected);
        const x = b.addParam("value", F64);
        b.openBlock();
        const c = constant(b);
        const sum = b.emitBinary("f64.add", x, c, F64);
        b.terminate({ kind: "return", values: [sum] });
        const fn = b.finish();
        valid(fn);
        expect(preparedIrDataMismatch(f.packet.ir.functions[0], fn)).toBeUndefined();
        const result = prepareTypedIrProgram(
          { ...f.packet, ir: { ...f.packet.ir, functions: [fn] } },
          { ...typedOptions, policy: { backend, target: "host" }, runtimePolicies: [{ backend, target: "host" }] },
        );
        if (result.kind !== "prepared") throw new Error(`actual no-map producer refused ${JSON.stringify(result)}`);
        expect(Object.hasOwn(result.program, "sourceMap")).toBe(false);
        const wire = encodePreparedIrProgram(result.program);
        expect(encodePreparedIrProgram(decodePreparedIrProgram(wire))).toBe(wire);
        const accepted = acceptPreparedIrProgram(result.program, {
          backend,
          target: "host",
          sharedExceptionTag: false,
          utf8Storage: false,
          sourceMap: false,
          moduleName: "builder-no-map",
        } satisfies PreparedIrBackendOptions);
        if (accepted.kind !== "accepted") throw new Error(`actual consumer refused ${JSON.stringify(accepted)}`);
        const emitted = emitAcceptedIrProgram(accepted);
        expect(emitted.module.imports).toEqual([]);
        const binary = emitBinary(emitted.module);
        const { instance } = await WebAssembly.instantiate(new Uint8Array(binary));
        const call = instance.exports.build;
        if (typeof call !== "function") throw new Error("genuine builder export absent");
        const values = [3, -2, 0].map((value) => call(value));
        expect(values).toEqual([5, 0, 2]);
        produced.push({ wire, binary, values });
        console.log(
          "BUILDER_NO_MAP",
          JSON.stringify({
            backend,
            selection: selected,
            valueCount: fn.valueCount,
            values,
            wireBytes: Buffer.byteLength(wire),
            binaryBytes: binary.length,
          }),
        );
      }
      expect(produced[0]).toEqual(produced[1]);
    },
  );
  it("false compatibility scope call executes directly without reading hostile site data", () => {
    const f = fixture(),
      b = builder(f, false);
    let getters = 0,
      runs = 0;
    const bad = {
      get origin() {
        getters++;
        throw new Error("unrequested site read");
      },
    };
    const value = scope(b, bad, () => {
      runs++;
      return 7;
    });
    expect(value).toBe(7);
    expect(runs).toBe(1);
    expect(getters).toBe(0);
  });
});
