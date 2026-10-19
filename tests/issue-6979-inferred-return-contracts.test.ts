// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { sourceInput } from "./helpers/typed-program-fixtures.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import { deriveNativeObjectConstructionRequirements } from "../src/ir/program/native-object-construction-requirements.js";
import { constructionRuntime } from "./helpers/native-construction-fixture.js";

const policy = { backend: "wasmgc", target: "standalone" } as const;
function prepare(text: string, selected = policy as { backend: "wasmgc" | "linear"; target: "standalone" | "wasi" }) {
  return prepareWholeIrProgram({
    ...sourceInput({ "./entry.ts": text }),
    policy: selected,
    runtimePolicies: [selected],
    objectReferenceProjection: "live",
  });
}
function requireProgram(text: string) {
  const result = prepare(text);
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error(result.detail);
  return result.program;
}
function instructions(program: ReturnType<typeof requireProgram>) {
  const rows: IrInstr[] = [];
  for (const fn of program.ir.functions)
    for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (row) => rows.push(row));
  return rows;
}

describe("inferred source return is not a null-lattice void fallback", () => {
  for (const selected of [policy, { backend: "linear", target: "wasi" } as const])
    it(`executes inferred scalar/direct-call results on ${selected.backend}/${selected.target}`, () => {
      const result = prepare(
        "function add(n:number){return n+1;} export function run(n:number){return add(n);}",
        selected,
      );
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw Error(result.detail);
      expect(result.program.ir.functions.find((fn) => fn.name === "run")!.resultTypes).toEqual([
        { kind: "val", val: { kind: "f64" } },
      ]);
      const accepted = acceptPreparedIrProgram(result.program, selected);
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(accepted.detail);
      const emitted = emitAcceptedIrProgram(accepted);
      const module = new WebAssembly.Module(emitBinary(emitted.module) as BufferSource);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const run = new WebAssembly.Instance(module).exports.run as (n: number) => number;
      expect(run(41)).toBe(42);
      expect(run(6)).toBe(7);
    });

  for (const [text, keys] of [
    ["export function make(n:number){return {z:n,a:true};}", ["z", "a"]],
    ["export function make(){return {};}", []],
    ["export function make(n:number){return {z:{inner:{deep:{value:n}}},a:false};}", ["z", "a"]],
  ] as const)
    it(`preserves the actual returned record allocation ${text}`, () => {
      const program = requireProgram(text);
      const fn = program.ir.functions.find((row) => row.name === "make")!;
      expect(fn.resultTypes).toHaveLength(1);
      expect(fn.resultTypes[0]!.kind).toBe("object");
      const allocations = instructions(program).filter((row) => row.kind === "object.new");
      expect(allocations.length).toBeGreaterThan(0);
      const access = deriveNativeObjectAccessRequirements(program, program.runtime[0]!);
      const requirements = deriveNativeObjectConstructionRequirements(access);
      expect(requirements.constructors.length).toBe(allocations.length);
      expect(requirements.constructors.some((row) => JSON.stringify(row.keys) === JSON.stringify(keys))).toBe(true);
      expect(requirements.gaps.every((row) => row.detail.includes("default prototype"))).toBe(true);
      const replay = decodePreparedIrProgram(encodePreparedIrProgram(program));
      expect(replay.ir.functions.find((row) => row.name === "make")!.resultTypes).toEqual(fn.resultTypes);
      expect(instructions(replay).filter((row) => row.kind === "object.new")).toHaveLength(allocations.length);
    });

  it("preserves an inferred callable contract and source closure instead of void", () => {
    const program = requireProgram("export function make(n:number){return function():number{return n;};}");
    expect(program.ir.functions.find((fn) => fn.name === "make")!.resultTypes[0]!.kind).toBe("callable");
    expect(instructions(program).filter((row) => row.kind === "closure.new")).toHaveLength(1);
    expect(
      instructions(program).filter((row) => row.kind === "coerce.to_externref" && row.resultType?.kind === "callable"),
    ).toHaveLength(1);
  });

  it("keeps Boolean result brands in inferred function and field contracts", () => {
    const program = requireProgram(
      "export function bool(n:number){return n>0;} export function record(n:number){return {value:n>0};}",
    );
    expect(program.ir.functions.find((fn) => fn.name === "bool")!.resultTypes).toEqual([
      { kind: "val", val: { kind: "i32", boolean: true } },
    ]);
    const record = program.ir.functions.find((fn) => fn.name === "record")!.resultTypes[0]!;
    expect(record).toEqual({
      kind: "object",
      shape: { fields: [{ name: "value", type: { kind: "val", val: { kind: "i32", boolean: true } } }] },
    });
  });

  it("executes an actually owned zero-field initializer without treating zero fields as absence", () => {
    const { f, exports: ex, imports } = constructionRuntime(true, true, "export function make(){return {};}");
    expect(imports).toEqual([]);
    expect(f.requirements.constructors).toHaveLength(1);
    expect(f.requirements.constructors[0]!.keys).toEqual([]);
    expect(f.requirements.gaps).toHaveLength(1);
    expect(f.requirements.gaps[0]!.detail).toContain("default prototype");
    const object = ex.initialize0!(null);
    expect(ex.count!(object)).toBe(0);
    expect(ex.prototype!(object)).toBeNull();
    const other = ex.initialize0!(object);
    expect(other === object).toBe(false);
    expect(ex.prototype!(other) === object).toBe(true);
    ex.defineData!(object, ex["key:z"]!(), ex.key!(), 191);
    expect(ex.has!(other, ex["key:z"]!())).toBe(1);
    expect(ex.count!(other)).toBe(0);
  });

  it("keeps genuine inferred void and explicitly declared void separate from unknown", () => {
    const program = requireProgram(
      "export function empty(){} export function bare(){return;} export function discard():void{const value={n:1};return;} ",
    );
    expect(program.ir.functions).toHaveLength(3);
    for (const fn of program.ir.functions) expect(fn.resultTypes).toEqual([]);
  });

  for (const selected of [policy, { backend: "linear", target: "wasi" } as const])
    it(`preserves a proven undefined return through the zero-result ABI (${selected.backend})`, () => {
      const result = prepare("export function run(){return undefined;}", selected);
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw Error(result.detail);
      expect(result.program.ir.functions[0]!.resultTypes).toEqual([]);
      const accepted = acceptPreparedIrProgram(result.program, selected);
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(accepted.detail);
      const module = new WebAssembly.Module(emitBinary(emitAcceptedIrProgram(accepted).module));
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      expect((new WebAssembly.Instance(module).exports.run as () => unknown)()).toBeUndefined();
    });

  for (const text of [
    "export function make(){return {method():number{return 1;}};}",
    "export function make(value:any){return value;}",
    "export function make(){return ({method():number{return 1;}} as unknown as undefined);}",
    "export function make(){return {};}",
  ])
    it(`never publishes an erased value return as an empty function: ${text}`, () => {
      const result = prepare(text);
      if (result.kind === "prepared") {
        const fn = result.program.ir.functions.find((row) => row.name === "make")!;
        expect(fn.resultTypes).toHaveLength(1);
        expect(
          fn.blocks.some((block) => block.terminator.kind === "return" && block.terminator.values.length === 1),
        ).toBe(true);
      } else {
        expect(result.kind).toBe("unsupported");
        expect(result.code).toBe("type-resolution-unsupported");
        expect(result.stage).toBe("build");
        expect(result.unitId).toBeTruthy();
        expect(result.sourceFile).toBe("entry.ts");
      }
    });
});
