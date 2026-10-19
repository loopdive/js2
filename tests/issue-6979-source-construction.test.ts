// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/frontend/typescript.js";
import { emitSourceObjectNew } from "../src/frontend/object-construction.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, type IrType } from "../src/ir/core/types.js";
import { SOURCE_OBJECT_CONSTRUCTION } from "../src/ir/runtime/object-construction.js";
import { forkAllocInInstr } from "../src/ir/passes/alloc-discipline.js";
import { inlineSmall } from "../src/ir/passes/inline-small.js";
import { monomorphize } from "../src/ir/passes/monomorphize.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program-allocations.js";

const identities = createTestIrFunctionIdentityFactory("6979-source-construction");
const number = irVal({ kind: "f64" });
const object: IrType = {
  kind: "object",
  shape: {
    fields: [
      { name: "a", type: number },
      { name: "z", type: number },
    ],
  },
};

function fixture(text = "({z:1,a:2})") {
  const registry = new AllocSiteRegistry();
  const builder = new IrFunctionBuilder(identities.next("make"), [object], false, registry);
  builder.addParam("unused", number);
  builder.openBlock();
  const z = builder.emitConst(1, number),
    a = builder.emitConst(2, number);
  const file = ts.createSourceFile("input.ts", text, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0] as ts.ExpressionStatement;
  const source = (statement.expression as ts.ParenthesizedExpression).expression as ts.ObjectLiteralExpression;
  const result = emitSourceObjectNew(
    builder,
    [
      { name: "z", type: number, value: z },
      { name: "a", type: number, value: a },
    ],
    source,
  );
  builder.terminate({ kind: "return", values: [result] });
  const fn = builder.finish();
  const instruction = fn.blocks[0]!.instrs.find((row) => row.kind === "object.new")!;
  return { registry, fn, instruction, z, a };
}

describe("source construction facts (not construction admission)", () => {
  it("keeps source order separate from canonical storage operands and detaches facts", () => {
    const { registry, instruction, z, a } = fixture();
    expect(instruction.kind).toBe("object.new");
    if (instruction.kind !== "object.new") throw Error("missing positive construction control");
    expect(instruction.shape.fields.map((row) => row.name)).toEqual(["a", "z"]);
    expect(instruction.values).toEqual([a, z]);
    expect(registry.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION)).toEqual({
      schema: "source-object-construction-v1",
      kind: "data",
      keys: ["z", "a"],
    });
    const replay = AllocSiteRegistry.fromSnapshot(registry.captureSnapshot());
    expect(replay.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION)).toEqual(
      registry.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION),
    );
    expect(replay.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION)).not.toBe(
      registry.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION),
    );
  });

  for (const [text, kind] of [
    ["({__proto__:null})", "prototype-setter"],
    ['({"__proto__":null})', "prototype-setter"],
    ['({["__proto__"]:1})', "data"],
    ["({__proto__})", "data"],
    ["({method(){return 1}})", "method"],
  ])
    it(`classifies ${text} without granting prototype or method ownership`, () => {
      const { registry, instruction } = fixture(text);
      expect(registry.read<{ kind: string }>(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION)?.kind).toBe(kind);
    });

  it("forks only detached source facts, never analysis evidence", () => {
    const { registry, instruction } = fixture();
    registry.annotate(instruction.alloc!, "escape", { value: 17 });
    const fork = forkAllocInInstr(instruction, registry);
    expect(fork.alloc).not.toBe(instruction.alloc);
    expect(registry.read(fork.alloc!, SOURCE_OBJECT_CONSTRUCTION)).toEqual(
      registry.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION),
    );
    expect(registry.read(fork.alloc!, SOURCE_OBJECT_CONSTRUCTION)).not.toBe(
      registry.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION),
    );
    expect(registry.read(fork.alloc!, "escape")).toBeUndefined();
  });

  it("rejects malformed, duplicate and foreign-key source facts", () => {
    const { registry, fn, instruction } = fixture();
    for (const facts of [
      undefined,
      {},
      { schema: "source-object-construction-v1", kind: "data", keys: ["a", "a"] },
      { schema: "source-object-construction-v1", kind: "data", keys: ["a", "foreign"] },
    ]) {
      registry.annotate(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION, facts);
      expect(() =>
        assertPreparedIrProgramAllocations({ ir: { functions: [fn] }, allocations: registry.snapshot() }),
      ).toThrow(/malformed source construction facts/);
    }
  });

  it("preserves facts through actual inline and specialization allocation forks", () => {
    for (const pass of ["inline", "specialize"]) {
      const { registry, fn, instruction } = fixture();
      const callers = [number, irVal({ kind: "externref" })].map((type, i) => {
        const builder = new IrFunctionBuilder(identities.next(`caller${i}`), [object], true, registry);
        const param = builder.addParam("value", type);
        builder.openBlock();
        for (let i = 0; i < 4; i++) builder.emitConst(i, number);
        const result = builder.emitCall(irUnitFuncRef(fn), [param], object)!;
        builder.terminate({ kind: "return", values: [result] });
        return builder.finish();
      });
      const input = { functions: [fn, ...callers] };
      const output = pass === "inline" ? inlineSmall(input, registry) : monomorphize(input, registry).module;
      const forks = output.functions
        .flatMap((row) => row.blocks.flatMap((block) => block.instrs))
        .filter((row) => row.kind === "object.new" && row.alloc !== instruction.alloc);
      expect(forks.length, pass).toBeGreaterThan(0);
      for (const fork of forks)
        expect(registry.read(fork.alloc!, SOURCE_OBJECT_CONSTRUCTION)).toEqual(
          registry.read(instruction.alloc!, SOURCE_OBJECT_CONSTRUCTION),
        );
    }
  });

  it("retains source facts through whole preparation and codec replay", () => {
    const graph = analyzeMultiSource(
      { "./entry.ts": "export function make(n:number):{a:number,z:number}{return {z:n,a:n+1};}" },
      "./entry.ts",
    );
    const result = prepareWholeIrProgram({
      sourceFiles: graph.sourceFiles,
      entrySource: graph.entryFile,
      checker: graph.checker,
      deferTopLevelInit: false,
      policy: { backend: "wasmgc", target: "standalone" },
      objectReferenceProjection: "live",
    });
    expect(result.kind, JSON.stringify(result)).toBe("prepared");
    if (result.kind !== "prepared") throw Error("source construction preparation failed");
    const replay = decodePreparedIrProgram(encodePreparedIrProgram(result.program));
    const rows = replay.allocations.metadata
      .flatMap((row) => row.entries)
      .filter(([name]) => name === SOURCE_OBJECT_CONSTRUCTION);
    expect(rows.length).toBeGreaterThan(0);
    for (const [, facts] of rows)
      expect(facts).toEqual({ schema: "source-object-construction-v1", kind: "data", keys: ["z", "a"] });
  });
});
