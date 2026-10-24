// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { emitBinary } from "../src/emit/binary.js";

const source = `export function make(): (value: any) => any { return (value: any): any => value; }
export function inferred() { return (value: any): any => value; }
export function makeBool(): () => boolean { return (): boolean => true; }
export function text(): string { return "native string"; }`;
interface Runtime {
  make(): unknown;
  makeBool(): unknown;
  inferred(): unknown;
  text(): unknown;
  apply(callee: unknown, receiver: unknown, args: unknown): unknown;
  newVector(): unknown;
  push(vector: unknown, value: unknown): void;
  boxNumber(value: number): unknown;
  undefinedValue(): unknown;
}
describe("generic source values through productive native Call", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`preserves runtime identity and omission, decoded=${decoded}, utf8=${utf8Storage}`, async () => {
        const program = prepareGetterProgram(source, decoded);
        const outcome = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome));
        const module = structuredClone(outcome.run.emitted.module);
        expect(module.imports).toEqual([]);
        for (const [name, actual] of Object.entries({
          apply: "__apply_closure_arguments",
          newVector: "__objvec_new",
          push: "__objvec_push",
          boxNumber: "__box_number",
          undefinedValue: "__closure_undefined",
        })) {
          const matches = module.functions.flatMap((fn, index) => (fn.name === actual ? [index] : []));
          expect(matches, actual).toHaveLength(1);
          module.exports.push({ name, desc: { kind: "func", index: matches[0]! } });
        }
        const r = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource))
          .exports as unknown as Runtime;
        const callback = r.make();
        const boolean = r.apply(r.makeBool(), null, r.newVector());
        const values = [
          null,
          r.undefinedValue(),
          r.boxNumber(0),
          r.boxNumber(-0),
          r.boxNumber(NaN),
          r.boxNumber(0.5),
          boolean,
          r.text(),
          callback,
          r.newVector(),
          { external: true },
          Symbol("opaque"),
        ];
        for (const value of values) {
          const args = r.newVector();
          r.push(args, value);
          expect(r.apply(callback, null, args)).toBe(value);
          expect(r.apply(r.inferred(), null, args)).toBe(value);
        }
        expect(r.apply(callback, null, r.newVector())).toBe(r.undefinedValue());
        const extras = r.newVector();
        r.push(extras, callback);
        r.push(extras, boolean);
        expect(r.apply(callback, null, extras)).toBe(callback);
      }, 120000);
});

describe("generic source closure admission", () => {
  for (const expression of ["value", "7"])
    it(`refuses value-bearing void return: ${expression}`, () => {
      expect(() =>
        prepareGetterProgram(`export function make(): (value: any) => void {
        return (value: any): void => { return ${expression}; };
      }`),
      ).toThrow(/void closure value-bearing return/);
    });
});

describe("generic source signature limits", () => {
  for (const [label, source, diagnostic] of [
    ["rest", "export function make() { return (...value: any[]): any => value; }", /exact required parameter/],
    ["optional", "export function make() { return (value?: any): any => value; }", /exact required parameter/],
    ["default", "export function make() { return (value: any = 7): any => value; }", /exact required parameter/],
    ["generic", "export function make() { return <T>(value: any): any => value; }", /generic\/this parameters/],
    [
      "this",
      "export function make() { return function(this: any, value: any): any { return value; }; }",
      /generic\/this parameters/,
    ],
    [
      "error-any",
      "export function make() { return (value: MissingType): any => value; }",
      /one non-constructing call signature/,
    ],
    [
      "Promise",
      "export function make() { return (value: any): Promise<any> => value; }",
      /one non-constructing call signature/,
    ],
  ] as const)
    it(`refuses unsupported ${label} semantics`, () => {
      expect(() => prepareGetterProgram(source)).toThrow(diagnostic);
    });
});

it("refuses dynamic arithmetic without its canonical runtime declaration", () => {
  expect(() =>
    prepareGetterProgram(`export function make(): (value: any) => any {
    return (value: any): any => value + value;
  }`),
  ).toThrow(/__ir_dyn_add has no canonical declaration/);
});
