// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

const MODES = ["single-source", "multi-source"] as const;
const OPTIONS = { target: "gc" as const, optimize: false };
const PREDICATE_BODY = "return value === 13;";
const PREDICATE_DEPENDENCY = "export function compare(value: number): boolean { " + PREDICATE_BODY + " }";

async function compileProgram(mode: (typeof MODES)[number], declarations: string): Promise<CompileResult> {
  if (mode === "single-source") {
    return compile(PREDICATE_DEPENDENCY.replace("export ", "") + "\n" + declarations, {
      ...OPTIONS,
      fileName: "ordinary-boolean-result.ts",
    });
  }
  return compileMulti(
    {
      "./predicate.ts": PREDICATE_DEPENDENCY,
      "./entry.ts": 'import { compare } from "./predicate";\n' + declarations,
    },
    "./entry.ts",
    OPTIONS,
  );
}

function instantiate(result: CompileResult) {
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  // The existing genuine-instance publication owner also installs its real exports.
  imports.setInstance?.(instance);
  const initialize = instance.exports.__module_init;
  if (typeof initialize === "function") initialize();
  return { instance, wrapped: wrapExports(instance, { signatures: result.exportSignatures }) };
}

const BOOLEAN_EXPORTS = `
export function ordinary(value: number): boolean { return compare(value); }
export function __publicBoolean(value: number): boolean { return compare(value); }
function localPredicate(value: number): boolean { return compare(value); }
export { localPredicate as ordinaryAlias, localPredicate as __prefixedAlias };
export function literalTrue(): true { return true; }
export function literalFalse(): false { return false; }
`;

const OTHER_EXPORTS = `
export function ordinaryNumber(value: number): number { return value + 17; }
export function booleanParameter(value: boolean): number { return value ? 1 : 0; }
export function promised(value: number): Promise<boolean> { return Promise.resolve(compare(value)); }
export function nullable(_value: number): boolean | null { return null; }
export function mixed(_value: number): boolean | number { return 7; }
`;

describe("ordinary source Boolean result boundary metadata", () => {
  for (const mode of MODES) {
    it(mode + " preserves ordinary, prefixed, alias and literal Boolean results against Node", async () => {
      const result = await compileProgram(mode, BOOLEAN_EXPORTS);
      const { instance, wrapped } = instantiate(result);
      // Genuine Node evaluates the exact predicate body used by the real source module.
      // The multi-source compiler must reach it through the actual imported dependency.
      const reference = new Function("value", PREDICATE_BODY);
      for (const name of ["ordinary", "__publicBoolean", "ordinaryAlias", "__prefixedAlias"]) {
        expect(result.exportSignatures?.[name]).toEqual({ params: ["other"], result: "boolean" });
        const raw = instance.exports[name];
        const publicCall = wrapped[name];
        if (typeof raw !== "function" || typeof publicCall !== "function")
          throw new Error("missing source callable " + name);
        for (const value of [13, 2]) {
          const expected = reference(value);
          expect(typeof expected).toBe("boolean");
          expect(raw(value)).toBe(expected ? 1 : 0);
          expect(publicCall(value)).toBe(expected);
        }
      }
      for (const [name, body] of [
        ["literalTrue", "return true;"],
        ["literalFalse", "return false;"],
      ] as const) {
        expect(result.exportSignatures?.[name]).toEqual({ params: [], result: "boolean" });
        const publicCall = wrapped[name];
        if (typeof publicCall !== "function") throw new Error("missing literal callable " + name);
        expect(publicCall()).toBe(new Function(body)());
      }
    });

    it(mode + " retains number, Promise and nullable classification and Boolean-parameter policy", async () => {
      const result = await compileProgram(mode, OTHER_EXPORTS);
      const { wrapped } = instantiate(result);
      expect(result.exportSignatures?.promised).toEqual({ params: ["other"], result: "promise" });
      for (const name of ["ordinaryNumber", "booleanParameter", "nullable", "mixed"]) {
        expect(result.exportSignatures?.[name]).toBeUndefined();
      }
      const numeric = wrapped.ordinaryNumber;
      const parameter = wrapped.booleanParameter;
      if (typeof numeric !== "function" || typeof parameter !== "function")
        throw new Error("missing unchanged callable");
      const numberReference = new Function("value", "return value + 17;");
      const parameterReference = new Function("value", "return value ? 1 : 0;");
      for (const value of [13, 2]) expect(numeric(value)).toBe(numberReference(value));
      for (const value of [true, false]) expect(parameter(value)).toBe(parameterReference(value));
      // Promise<boolean> and nullable/union slots are classification controls only.
      // This row makes no new settlement or nullable-return runtime-support claim.
    });
  }

  it("retains the raw private numeric helper ABI separately from source Boolean signatures", async () => {
    const result = await compile(
      `
export function schedule(value: number): any { return setTimeout(() => {}, value); }
export function scheduleInterval(value: number): any { return setInterval(() => {}, value); }
export function stopTimeout(value: number): void { clearTimeout(value); }
export function stopInterval(value: number): void { clearInterval(value); }
`,
      { ...OPTIONS, fileName: "private-timer-numeric-abi.ts" },
    );
    const { instance, wrapped } = instantiate(result);
    const box = instance.exports.__box_number;
    const probe = instance.exports.__typeof_number;
    const unbox = instance.exports.__unbox_number;
    if (typeof box !== "function" || typeof probe !== "function" || typeof unbox !== "function") {
      throw new Error("missing canonical private numeric ABI");
    }
    for (const name of ["__box_number", "__typeof_number", "__unbox_number"]) {
      expect(result.exportSignatures?.[name]).toBeUndefined();
      expect(wrapped[name]).toBe(instance.exports[name]);
    }
    const boxed = box(12.5);
    expect(probe(boxed)).toBe(1);
    expect(probe("not a number")).toBe(0);
    expect(unbox(boxed)).toBe(12.5);
    // Scheduling exports are never invoked, so this control creates no host timers.
  });
});
