// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, type ImportDescriptor } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { buildCompiledImports, buildImports, wrapCompiledExports } from "../src/runtime.js";
import { classifyHostImport, isRetiredEcmaScriptExternClass } from "../src/host-import-policy.js";

const descriptor = (name: string, intent: ImportDescriptor["intent"]): ImportDescriptor => ({
  module: "env",
  name,
  kind: "func",
  intent,
});

describe("#6979 runtime binder has no compatibility semantic provider", () => {
  it("removes class-specific semantic providers but retains live boundary and accelerator adapters", () => {
    const file = ts.createSourceFile(
      "runtime.ts",
      readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const names = new Set<string>();
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) names.add(statement.name.text);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
    }
    for (const name of [
      "_convertIterableForHost",
      "_errorMessageToString",
      "_errorPrimitiveToString",
      "_structArgIdentityCtors",
      "_ITER_HELPER_NAMES",
      "_iteratorRecordForHost",
      "_setLikeRecordForHost",
    ])
      expect(names.has(name), name).toBe(false);
    for (const name of [
      "_wrapForHost",
      "_unwrapForHost",
      "_nativeDynamicFromHost",
      "_hostToPrimitive",
      "_materializeIterable",
      "_nativeSymbolToHost",
      "_createBoundaryObjectImport",
      "buildCompiledImports",
    ])
      expect(names.has(name), name).toBe(true);
  });
  for (const ambientCompatibility of [undefined, true, false]) {
    const options = ambientCompatibility === undefined ? {} : { ambientCompatibility };
    it(`rejects retired ECMAScript classes before reading dependencies — compatibility ${ambientCompatibility}`, () => {
      const deps = new Proxy(
        {},
        {
          get() {
            throw new Error("dependency must not be read");
          },
        },
      );
      for (const className of [
        "Object",
        "Function",
        "Array",
        "String",
        "Number",
        "Boolean",
        "Symbol",
        "BigInt",
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "WeakRef",
        "FinalizationRegistry",
        "Promise",
        "Error",
        "TypeError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "URIError",
        "EvalError",
        "AggregateError",
        "SuppressedError",
        "ArrayBuffer",
        "AsyncDisposableStack",
        "DataView",
        "DisposableStack",
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
      ]) {
        for (const action of ["new", "get", "set", "method"] as const) {
          const intent = { type: "extern_class", className, action, member: "x" } as const;
          expect(
            () => buildImports([descriptor("retired", intent)], deps, [], options),
            `${className}:${action}`,
          ).toThrow(/Native-first adapter cannot bind env::retired:.*host-semantic implementation was removed/);
        }
      }
    });

    it(`rejects unknown semantic builtins and host string providers — compatibility ${ambientCompatibility}`, () => {
      for (const intent of [
        { type: "builtin", name: "JSON_parse" },
        { type: "builtin", name: "__instanceof" },
        { type: "host_compare" },
        { type: "string_method", method: "trim" },
      ] as const) {
        expect(() => buildImports([descriptor("retired", intent)], undefined, [], options)).toThrow(
          /Native-first adapter cannot bind env::retired:.*host-semantic implementation was removed/,
        );
      }
    });

    it(`requires the matching named accelerator — compatibility ${ambientCompatibility}`, () => {
      for (const [className, family] of [
        ["RegExp", "regexp"],
        ["Date", "date"],
      ] as const) {
        const manifest = [descriptor(`${className}_new`, { type: "extern_class", className, action: "new" })];
        expect(() => buildImports(manifest, undefined, [], options)).toThrow(/cannot bind/);
        const bindings = buildImports(manifest, undefined, [], { ...options, hostAccelerators: [family] });
        const value = bindings.env[`${className}_new`](className === "Date" ? 0 : "x");
        expect(value instanceof (className === "Date" ? Date : RegExp)).toBe(true);
      }
    });
  }

  it("keeps declared external constructors, identity and receivers", () => {
    const token = {};
    class External {
      constructor(readonly value: object) {}
      echo() {
        return this.value;
      }
    }
    const bindings = buildImports(
      [
        descriptor("External_new", { type: "extern_class", className: "External", action: "new" }),
        descriptor("External_echo", { type: "extern_class", className: "External", action: "method", member: "echo" }),
      ],
      { External },
      [],
      { ambientCompatibility: false },
    );
    const instance = bindings.env.External_new(token);
    expect(instance).toBeInstanceOf(External);
    expect(bindings.env.External_echo(instance)).toBe(token);
  });

  it("validates the whole manifest before resolving an earlier allowed dependency", () => {
    const deps = new Proxy(
      {},
      {
        get() {
          throw new Error("dependency must not be read");
        },
      },
    );
    expect(() =>
      buildImports(
        [
          descriptor("External_new", { type: "extern_class", className: "External", action: "new" }),
          descriptor("Map_new", { type: "extern_class", className: "Map", action: "new" }),
        ],
        deps,
        [],
        { ambientCompatibility: false },
      ),
    ).toThrow(/cannot bind env::Map_new/);
  });

  it("keeps explicitly namespaced APIs distinct from identically named global builtins", () => {
    const token = {};
    class External {
      constructor(readonly value: object) {}
    }
    for (const className of [
      "Number",
      "Function",
      "String",
      "Boolean",
      "AggregateError",
      "AsyncDisposableStack",
      "Map",
      "Set",
      "Date",
      "RegExp",
      "SharedArrayBuffer",
    ]) {
      const entry = descriptor("qualified_new", {
        type: "extern_class",
        className,
        action: "new",
        namespacePath: ["api"],
      });
      expect(classifyHostImport(entry).classification).toBe("platform-capability");
      expect(classifyHostImport(entry, "javascript", ["date", "regexp"]).classification).toBe("platform-capability");
      expect(isRetiredEcmaScriptExternClass(className, undefined, ["api"])).toBe(false);
      const bindings = buildImports([entry], { api: { [className]: External } }, [], { ambientCompatibility: false });
      const instance = bindings.env.qualified_new(token);
      expect(instance).toBeInstanceOf(External);
      expect(instance.value).toBe(token);
    }
  });

  for (const className of ["Number", "Map"]) {
    it(`compiles an explicitly namespaced ${className} API without selecting the intrinsic`, async () => {
      const result = await compile(
        `
        declare namespace api { class ${className} { constructor(value: number); value: number; } }
        export function run(n: number): number { var value = new api.${className}(n); return value.value; }
      `,
        { skipSemanticDiagnostics: true },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildCompiledImports(result, {
        api: {
          [className]: class {
            constructor(readonly value: number) {}
          },
        },
      });
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      const exp = wrapCompiledExports(result, instance) as { run(n: number): number };
      expect(exp.run(42)).toBe(42);
      expect(exp.run(7)).toBe(7);
    });
  }
});
