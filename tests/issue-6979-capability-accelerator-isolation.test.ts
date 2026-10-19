// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, type ImportDescriptor } from "../src/index.js";
import { buildCompiledImports, buildImports, wrapCompiledExports } from "../src/runtime.js";
import { classifyHostImport } from "../src/host-import-policy.js";
import { isIntlAcceleratedImport } from "../src/runtime/intl-host-accelerator.js";

const entry = (
  className: string,
  namespacePath: string[],
  action: "new" | "get" | "set" = "new",
): ImportDescriptor => ({
  module: "env",
  name: "capability",
  kind: "func",
  intent: {
    type: "extern_class",
    className,
    namespacePath,
    action,
    ...(action === "new" ? {} : { member: "lastIndex" }),
  },
});

describe("#6979 declared APIs do not inherit intrinsic adapters", () => {
  it("does not treat a declared class named Intl as the Intl namespace", () => {
    const descriptor = entry("Intl", []);
    expect(classifyHostImport(descriptor, "javascript", ["intl"]).classification).toBe("platform-capability");
    expect(isIntlAcceleratedImport(descriptor, ["intl"])).toBe(false);
    const token = {};
    class Provider {
      constructor(readonly value: unknown) {}
    }
    const imports = buildImports([descriptor], { Intl: Provider }, [], {
      ambientCompatibility: false,
      hostAccelerators: ["intl"],
    });
    expect((imports.env.capability!(token) as Provider).value).toBe(token);
  });
  for (const selected of [false, true])
    for (const className of ["External", "Date", "RegExp", "Test262Error"]) {
      it(`keeps api.${className} object arguments and identity — accelerators ${selected}`, async () => {
        const token = {};
        let received: unknown, made: Provider | undefined;
        class Provider {
          readonly value: number;
          constructor(value: { value: number }) {
            received = value;
            if (value.value < 0) throw token;
            this.value = value.value;
            made = this;
          }
        }
        const result = await compile(
          `
        declare namespace api { class ${className} { constructor(value:any); value:number; } }
        export function run(n:number):number { var bag={value:n}; var h=new api.${className}(bag); return h.value; }
        export function receive(value:any):any { return new api.${className}(value); }
      `,
          {
            skipSemanticDiagnostics: true,
            ...(selected ? { hostAccelerators: ["date", "regexp", "intl"] as const } : {}),
          },
        );
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        const imports = buildCompiledImports(result, { api: { [className]: Provider } });
        const { instance } = await WebAssembly.instantiate(result.binary, imports);
        imports.setInstance?.(instance);
        const exports = wrapCompiledExports(result, instance) as {
          run(n: number): number;
          receive(value: unknown): unknown;
        };
        expect(exports.run(42)).toBe(42);
        expect(exports.run(7)).toBe(7);
        const original = { value: 5 };
        expect(exports.receive(original)).toBe(made);
        expect(received).toBe(original);
        let thrown: unknown;
        try {
          exports.run(-1);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(token);
      });
    }

  for (const namespacePath of [["Intl", "custom"], ["Intl"], ["api"]]) {
    it(`never falls back from ${namespacePath.join(".")}.Date to the global Date`, () => {
      const manifest = [entry("Date", namespacePath)];
      const imports = buildImports(manifest, undefined, [], {
        ambientCompatibility: false,
        hostAccelerators: ["date", "intl"],
      });
      expect(() => imports.env.capability!()).toThrow('No dependency provided for extern class "Date"');
      expect(classifyHostImport(manifest[0]!, "javascript", ["date", "intl"]).classification).toBe(
        "platform-capability",
      );
      expect(isIntlAcceleratedImport(manifest[0]!, ["intl"])).toBe(false);
    });
  }

  it("does not marshal a nested Intl capability as the intrinsic Intl constructor", () => {
    const nested = entry("NumberFormat", ["Intl", "custom"]);
    expect(classifyHostImport(nested, "javascript", ["intl"]).classification).toBe("platform-capability");
    expect(isIntlAcceleratedImport(nested, ["intl"])).toBe(false);
    const missing = buildImports([nested], undefined, [], { ambientCompatibility: false, hostAccelerators: ["intl"] });
    expect(() => missing.env.capability!()).toThrow(/No dependency provided/);
    const token = {};
    class Provider {
      constructor(readonly value: unknown) {}
    }
    const found = buildImports([nested], { Intl: { custom: { NumberFormat: Provider } } }, [], {
      ambientCompatibility: false,
      hostAccelerators: ["intl"],
    });
    expect((found.env.capability!(token) as Provider).value).toBe(token);
    const intrinsic = entry("NumberFormat", ["Intl"]);
    expect(classifyHostImport(intrinsic, "javascript", ["intl"]).classification).toBe("host-accelerator");
    expect(isIntlAcceleratedImport(intrinsic, ["intl"])).toBe(true);
    const selected = buildImports([intrinsic], undefined, [], {
      ambientCompatibility: false,
      hostAccelerators: ["intl"],
    });
    expect(selected.env.capability!()).toBeInstanceOf(Intl.NumberFormat);
  });

  it("does not install a RegExp lastIndex coercion shim on a declared API object", async () => {
    const compiled = await compile("export function make(n:number):any { return {value:n}; }", {
      skipSemanticDiagnostics: true,
      hostBridge: "always",
    });
    expect(compiled.success).toBe(true);
    const makerImports = buildCompiledImports(compiled);
    const { instance } = await WebAssembly.instantiate(compiled.binary, makerImports);
    makerImports.setInstance?.(instance);
    const raw = (instance.exports.make as (n: number) => unknown)(42);
    expect(typeof raw).toBe("object");
    const setter = entry("RegExp", ["api"], "set"),
      getter = { ...entry("RegExp", ["api"], "get"), name: "read" };
    const controlSetter = { ...entry("External", ["api"], "set"), name: "control" };
    const imports = buildImports([setter, getter, controlSetter], undefined, [], {
      ambientCompatibility: false,
      hostAccelerators: ["regexp"],
    });
    const api: { lastIndex?: unknown } = {};
    const control: { lastIndex?: unknown } = {};
    imports.env.capability!(api, raw);
    imports.env.control!(control, raw);
    // Compare the ordinary capability contract, not a permanently raw-carrier
    // ABI: future improvements to generic facade marshalling apply to both.
    expect(api.lastIndex).toBe(control.lastIndex);
    expect(imports.env.read!(api)).toBe(control.lastIndex);
  });
});
