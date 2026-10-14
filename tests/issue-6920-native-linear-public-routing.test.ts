// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { resolveCompileTargetProfile } from "../src/target-profile.js";
import * as legacyLinear from "../src/codegen-linear/index.js";
import * as legacyGc from "../src/codegen/index.js";

afterEach(() => vi.restoreAllMocks());

describe("6920 explicit native Linear public routing", () => {
  for (const backend of ["linear", "wasmgc"] as const) {
    for (const target of ["standalone", "wasi"] as const) {
      it(`${backend}/${target}: async scalar source executes without direct frontend generation`, async () => {
        const linear = vi.spyOn(legacyLinear, "generateLinearModule").mockImplementation(() => {
          throw new Error("forbidden direct Linear frontend");
        });
        const gc = vi.spyOn(legacyGc, "generateModule").mockImplementation(() => {
          throw new Error("forbidden direct GC frontend");
        });
        const pending = compile("export function run(a:number,b:number):number { return a+b; }", {
          target,
          backend,
          optimize: false,
          sourceMap: false,
        });
        expect(pending).toBeInstanceOf(Promise);
        const result = await pending;
        expect(result.errors).toEqual([]);
        expect(result.success).toBe(true);
        expect(result.targetProfile).toMatchObject({ target, backend, hostValueInterop: "off" });
        expect(linear).not.toHaveBeenCalled();
        expect(gc).not.toHaveBeenCalled();
        expect(WebAssembly.validate(new Uint8Array(result.binary))).toBe(true);
        const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
        expect(Reflect.apply(instance.exports.run as Function, undefined, [1.5, -2.25])).toBe(-0.75);
      });

      it(`${backend}/${target}: selected environment stays explicit when host imports are disabled`, () => {
        expect(resolveCompileTargetProfile({ target, backend: "linear", strictNoHostImports: false })).toMatchObject({
          backend: "linear",
          target,
          environment: target === "wasi" ? "wasi" : "none",
          capabilityPolicy: "explicit-only",
          semanticProviders: "native-first",
          hostValueInterop: "off",
        });
      });
    }
  }

  it("refuses an explicit Linear backend without a no-host target", () => {
    expect(() => resolveCompileTargetProfile({ target: "gc", backend: "linear" })).toThrow(/requires an explicit/);
  });
  it("refuses contradictory WasmGC backend and legacy Linear target", () => {
    expect(() => resolveCompileTargetProfile({ target: "linear", backend: "wasmgc" })).toThrow(/conflicts/);
  });
});

describe("6920 real native startup", () => {
  for (const target of ["standalone", "wasi"] as const) {
    for (const deferTopLevelInit of [false, true]) {
      it(`${target}: authentic startup with defer=${deferTopLevelInit}`, async () => {
        const result = await compile(
          "export var visits:number=1; visits=visits+2; export function run():number{return visits;}",
          {
            target,
            backend: "linear",
            deferTopLevelInit,
            optimize: false,
            sourceMap: false,
          },
        );
        expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
        const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
        if (target === "wasi") {
          expect(instance.exports._start).toBeTypeOf("function");
          Reflect.apply(instance.exports._start as Function, undefined, []);
        } else if (deferTopLevelInit) {
          expect(instance.exports.__module_init).toBeTypeOf("function");
          Reflect.apply(instance.exports.__module_init as Function, undefined, []);
        }
        expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(3);
      });
    }
  }
});

describe("6920 native deferred lexical initialization", () => {
  for (const target of ["standalone", "wasi"] as const) {
    it(`${target}: lexical read before startup throws and initialized read succeeds`, async () => {
      const result = await compile("export function run():number{return value;} const value:number=4;", {
        target,
        backend: "linear",
        deferTopLevelInit: true,
        optimize: false,
        sourceMap: false,
      });
      expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
      const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
      try {
        Reflect.apply(instance.exports.run as Function, undefined, []);
        throw new Error("lexical read did not throw before initialization");
      } catch (error) {
        expect(error).toBeInstanceOf(Reflect.get(WebAssembly, "Exception"));
      }
      const init = target === "wasi" ? instance.exports._start : instance.exports.__module_init;
      Reflect.apply(init as Function, undefined, []);
      expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(4);
    });
  }
});

it("WASI startup refuses an actual source _start collision", async () => {
  const result = await compile(
    "export var value:number=1; export function _start():void{} export function run():number{return value;}",
    {
      target: "wasi",
      backend: "linear",
      optimize: false,
      sourceMap: false,
    },
  );
  expect(result.success).toBe(false);
  expect(result.errors.map((row) => row.message).join("; ")).toMatch(/_start.*collid/);
});

it("WASI permits a genuine source _start without startup demand", async () => {
  const result = await compile("export function _start():number{return 7;}", {
    target: "wasi",
    backend: "linear",
    optimize: false,
    sourceMap: false,
  });
  expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
  expect(Reflect.apply(instance.exports._start as Function, undefined, [])).toBe(7);
});

describe("6920 public async multi-source native routing", () => {
  for (const backend of ["linear", "wasmgc"] as const) {
    for (const target of ["standalone", "wasi"] as const) {
      it(`${backend}/${target}: genuine imported source uses the prepared route`, async () => {
        const directLinear = vi.spyOn(legacyLinear, "generateLinearMultiModule").mockImplementation(() => {
          throw new Error("forbidden direct Linear multi frontend");
        });
        const directGc = vi.spyOn(legacyGc, "generateMultiModule").mockImplementation(() => {
          throw new Error("forbidden direct GC multi frontend");
        });
        const pending = compileMulti(
          {
            "entry.ts":
              'import { add } from "./math"; export function run(a:number,b:number):number{return add(a,b)+2;}',
            "math.ts": "export function add(a:number,b:number):number{return a+b;}",
          },
          "entry.ts",
          { target, backend, optimize: false, sourceMap: false },
        );
        expect(pending).toBeInstanceOf(Promise);
        const result = await pending;
        expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
        expect(directLinear).not.toHaveBeenCalled();
        expect(directGc).not.toHaveBeenCalled();
        const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
        expect(Reflect.apply(instance.exports.run as Function, undefined, [1.5, -2.25])).toBe(1.25);
      });
    }
  }
});
