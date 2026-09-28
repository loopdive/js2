// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceInput, sourcePacket, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { effectsOf } from "../src/ir/analysis/effects.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { RuntimeManifestBuilder } from "../src/ir/runtime/manifest.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/issue-3518-ordinary-getter-program.json", import.meta.url), "utf8"),
);
describe("ordinary getter source production", () => {
  it("preserves real getter identities, shared cells and effectful Number conversion on the original source", () => {
    const { source } = sourcePacket(fixture.files);
    const kinds = source.inventory.allUnits.map((unit) => unit.kind);
    expect(kinds.filter((kind) => kind === "object-getter")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "function-expression")).toHaveLength(1);
    expect(source.ir.functions).toHaveLength(4);
    const instructions = source.ir.functions.flatMap((fn) => fn.blocks.flatMap((block) => block.instrs));
    expect(instructions.filter((instruction) => instruction.kind === "refcell.new")).toHaveLength(1);
    expect(instructions.filter((instruction) => instruction.kind === "closure.new")).toHaveLength(3);
    const calls = instructions.filter((instruction) => instruction.kind === "call");
    const semantic = calls.filter((call) => call.target.binding.kind === "intrinsic");
    expect(semantic.map((call) => call.target.name)).toEqual([
      "js.object.create-default",
      "js.object.define-accessor",
      "js.object.define-accessor",
      "js.number.from-value",
    ]);
    for (const call of semantic) expect(effectsOf(call)).toMatchObject({ readsHeap: true, writesHeap: true });
  });

  it("produces an actual explicit Get with its original receiver and descriptor provenance", () => {
    const { source } = sourcePacket({
      "./entry.ts": "export function run() {const object = {get value() {return 7;}}; return object.value;}",
    });
    const run = source.ir.functions.find((fn) => fn.name === "run");
    expect(run).toBeDefined();
    const instructions = run!.blocks.flatMap((block) => block.instrs);
    const calls = instructions.filter((instruction) => instruction.kind === "call");
    expect(calls.map((call) => call.target.name)).toEqual([
      "js.object.create-default",
      "js.object.define-accessor",
      "js.object.get",
    ]);
    const get = calls[2]!;
    expect(get.args[0]).toBe(calls[0]!.result);
    expect(get.args[2]).toBe(get.args[0]);
    expect(calls[1]!.args[0]).toBe(get.args[0]);
    expect(instructions.some((instruction) => instruction.kind === "closure.new")).toBe(true);
    expect(effectsOf(get)).toMatchObject({ readsHeap: true, writesHeap: true });
  });

  it("keeps ignored argument effects before Number's getter conversion", () => {
    const { source } = sourcePacket({
      "./entry.ts": `function mark(): void {} export function run() {
      const object = { get valueOf() { return function () {return 7;}; } };
      return Number(object, mark());
    }`,
    });
    const run = source.ir.functions.find((fn) => fn.name === "run");
    expect(run).toBeDefined();
    const calls = run!.blocks.flatMap((block) => block.instrs).filter((instruction) => instruction.kind === "call");
    const mark = calls.findIndex((call) => call.target.name === "mark");
    const number = calls.findIndex((call) => call.target.name === "js.number.from-value");
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(number).toBeGreaterThan(mark);
  });

  it("does not mistake the full Number contract for unboxing or a physical provider", () => {
    const declaration = irRuntimeCallableDeclaration(irIntrinsicFuncRef("js.number.from-value"));
    expect(declaration).toMatchObject({
      feature: "js.number.from-value",
      params: [{ kind: "val", val: { kind: "externref" } }],
      results: [{ kind: "val", val: { kind: "f64" } }],
    });
    expect(irRuntimeCallableDeclaration(irRuntimeFuncRef("js.number.from-value"))).toBeUndefined();
    const builder = new RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
    builder.requestFeature("js.number.from-value");
    expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "missing-runtime-provider" }));
  });

  it.each([
    "export function run() {return Number();}",
    "export function run() {return Number(7);}",
    "export let value = Number(7); export function run() {return value;}",
    "function mark(): void {} export function run() {mark(); return Number(7);}",
  ])("executes the scalar control before and after codec transport: %s", async (source) => {
    const program = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
    const decoded = decodePreparedIrProgram(encodePreparedIrProgram(program));
    const expected = source.includes("Number(7)") ? 7 : 0;
    for (const candidate of [program, decoded]) {
      const outcome = await replayProgram(candidate, replayOptions("wasmgc", "standalone"));
      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome));
      expect(outcome.run.exports.run()).toBe(expected);
      expect(outcome.run.emitted.module.imports).toHaveLength(0);
    }
  });
});
