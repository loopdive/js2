// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMultiSource } from "../src/compiler.js";
import {
  compilerPath,
  GRAPH_DYNAMIC_IMPORT_POLL_EXPORT,
  GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER,
  prepareManifestGraph,
  resolveManifestSpecifier,
} from "../examples/v8x-js2wasm-spike/compile-graph.js";

describe("v8x closed-manifest graph compiler", () => {
  it("maps every Deno URL scheme to a distinct virtual script filename", () => {
    const specifiers = [
      "ext:cli/main.js",
      "mod:cli/main.js",
      "custom:lazy_a",
      "https://example.com/v1/main.js",
      "ext:///main_module.js",
      "file:///main_module.js",
      "ext:a/b.js",
      "ext:a:b.js",
    ];
    const paths = specifiers.map(compilerPath);

    expect(new Set(paths).size).toBe(specifiers.length);
    expect(paths.every((path) => path.startsWith("__v8x_graph/"))).toBe(true);
    expect(paths.every((path) => /\.[cm]?[jt]sx?$/.test(path))).toBe(true);
  });

  it("retains original requests while resolving hierarchical, opaque, and aliased edges", () => {
    const modules = new Map<string, string>([
      [
        "ext:cli/main.js",
        `
          import "./dep.js";
          import "custom:aliased";
          import "https://example.com/v1/remote.js";
          import "ext:///root.js";
        `,
      ],
      ["ext:cli/dep.js", `export {};`],
      ["custom:aliased", `export {};`],
      ["https://example.com/v1/remote.js", `export {};`],
      ["ext:///root.js", `export {};`],
    ]);
    const graph = prepareManifestGraph(modules, "ext:cli/main.js");

    expect(graph.projectResolutions[graph.entry]).toEqual({
      "./dep.js": compilerPath("ext:cli/dep.js"),
      "custom:aliased": compilerPath("custom:aliased"),
      "https://example.com/v1/remote.js": compilerPath("https://example.com/v1/remote.js"),
      "ext:///root.js": compilerPath("ext:///root.js"),
    });
    expect(resolveManifestSpecifier("./remote.js", "https://example.com/v1/main.js", new Set(modules.keys()))).toBe(
      "https://example.com/v1/remote.js",
    );
  });

  it("statically supplies import.meta url, main, and URL-resolvable resolve calls", async () => {
    const graph = prepareManifestGraph(
      new Map([
        [
          "file:///main.js",
          `
            export const url = import.meta.url;
            export const main = import.meta.main;
            export const child = import.meta.resolve("./child.js");
          `,
        ],
        ["file:///dep.js", `export const main = import.meta.main;`],
      ]),
      "file:///main.js",
    );

    expect(graph.files[compilerPath("file:///main.js")]).toContain('const url = "file:///main.js"');
    expect(graph.files[compilerPath("file:///main.js")]).toContain("const main = true");
    expect(graph.files[compilerPath("file:///main.js")]).toContain('const child = "file:///child.js"');
    expect(graph.files[compilerPath("file:///dep.js")]).toContain("const main = false");

    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      { target: "standalone", platform: "deno", allowJs: true, skipSemanticDiagnostics: true },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.some((entry) => entry.name === "__get_import_meta_url")).toBe(false);
  });

  it("lowers a known awaited dynamic import to one stable native namespace", async () => {
    const graph = prepareManifestGraph(
      new Map([
        [
          "ext:cli/main.js",
          `
            const first = await import("./dep.js");
            const second = await import("./dep.js");
            export function answer() { return first === second ? first.default.value : -1; }
          `,
        ],
        ["ext:cli/dep.js", `const value = 42; export default { value };`],
      ]),
      "ext:cli/main.js",
    );

    expect(graph.dynamicImportsLowered).toBe(2);
    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      { target: "standalone", platform: "deno", allowJs: true, skipSemanticDiagnostics: true },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.some((entry) => entry.name === "__dynamic_import")).toBe(false);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.answer as () => number)()).toBe(42);
  });

  it("closes Deno's concurrent Promise.all dynamic-import shape without TLA", async () => {
    const graph = prepareManifestGraph(
      new Map([
        [
          "file:///lazy_loaded_concurrent_main.js",
          `
            const [a, b] = await Promise.all([
              import("./lazy_loaded_concurrent_a.js"),
              import("./lazy_loaded_concurrent_b.js"),
            ]);
            export function answer() { return a.a + b.b; }
          `,
        ],
        ["file:///lazy_loaded_concurrent_a.js", `export const a = 21;`],
        ["file:///lazy_loaded_concurrent_b.js", `export const b = 21;`],
      ]),
      "file:///lazy_loaded_concurrent_main.js",
    );

    expect(graph.dynamicImportsLowered).toBe(2);
    expect(graph.files[graph.entry]).not.toContain("await");
    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      { target: "standalone", platform: "deno", allowJs: true, skipSemanticDiagnostics: true },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.answer as () => number)()).toBe(42);
  });

  it("routes a runtime-only dynamic target through the Deno loader bridge", async () => {
    const graph = prepareManifestGraph(
      new Map([
        [
          "file:///runtime-main.js",
          `
            const first = await import("./loaded-only-at-runtime.js", {
              with: { type: "json" },
            });
            const second = await import("./loaded-only-at-runtime.js");
            let rejection = 0;
            try {
              await import("./rejected-at-runtime.js");
            } catch (error) {
              rejection = error instanceof TypeError &&
                error.name === "TypeError" &&
                error.message === "loader boom"
                ? 1
                : -1;
            }
            export function probe() {
              if (typeof first !== "object") return 1;
              if (typeof first.add !== "function") return 2;
              if (first !== second) return 3;
              if (first.add !== second.add) return 4;
              return 5;
            }
            export function answer() {
              return first === second ? Number(first.add(1, 1)) : -1;
            }
            export function rejectionProbe() { return rejection; }
          `,
        ],
      ]),
      "file:///runtime-main.js",
    );

    expect(graph.dynamicImportsLowered).toBe(0);
    expect(graph.runtimeDynamicImportsLowered).toBe(3);
    expect(graph.files[compilerPath(GRAPH_DYNAMIC_IMPORT_RUNTIME_SPECIFIER)]).toContain("__v8x_dynamic_import_begin");
    expect(graph.files[graph.entry]).not.toContain('import("./loaded-only-at-runtime.js"');

    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
        hostBridge: "always",
        externImportModule: "v8x:deno",
      },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.name)).toContain(
      "__v8x_dynamic_import_begin",
    );

    let pendingRequest = "";
    let requestUnits: number[] = [];
    let nextRequestId = 1;
    let settled = false;
    let resultPacket = "";
    let callUnits: number[] = [];
    let disposed = 0;
    const requests: unknown[] = [];
    const calls: unknown[] = [];
    const namespacePacket = JSON.stringify(["n", 41, ["o", [["add", ["h", "function", 42]]]]]);
    const host = {
      __v8x_dynamic_import_begin(length: number) {
        requestUnits = new Array(length).fill(0);
      },
      __v8x_dynamic_import_code_unit(index: number, value: number) {
        requestUnits[index] = value;
      },
      __v8x_dynamic_import_end() {
        pendingRequest = String.fromCharCode(...requestUnits);
        requests.push(JSON.parse(pendingRequest));
        return nextRequestId++;
      },
      __v8x_dynamic_import_state(requestId: number) {
        return !settled ? 0 : requestId === 3 ? 2 : 1;
      },
      __v8x_dynamic_import_result_kind() {
        return 1;
      },
      __v8x_dynamic_import_result_utf16_length(_requestId: number, field: number) {
        return ["TypeError", "loader boom", "TypeError: loader boom\n    at file:///loader.js:1:2"][field]!.length;
      },
      __v8x_dynamic_import_result_utf16_code_unit(_requestId: number, field: number, index: number) {
        return ["TypeError", "loader boom", "TypeError: loader boom\n    at file:///loader.js:1:2"][field]!.charCodeAt(
          index,
        );
      },
      __v8x_dynamic_import_dispose() {
        disposed++;
      },
      __v8x_deno_error_kind() {
        return 0;
      },
      __v8x_deno_error_utf16_length() {
        return 0;
      },
      __v8x_deno_error_utf16_code_unit() {
        return 0;
      },
      __v8x_graph_dynamic_import_result_prepare() {
        resultPacket = namespacePacket;
        return resultPacket.length;
      },
      __v8x_graph_dynamic_import_result_code_unit(index: number) {
        return resultPacket.charCodeAt(index);
      },
      __v8x_graph_app_call_begin(length: number) {
        callUnits = new Array(length).fill(0);
      },
      __v8x_graph_app_call_code_unit(index: number, value: number) {
        callUnits[index] = value;
      },
      __v8x_graph_app_call_end() {
        calls.push(JSON.parse(String.fromCharCode(...callUnits)));
        resultPacket = '["r",["d",42]]';
        return resultPacket.length;
      },
    };
    const { instance } = await WebAssembly.instantiate(result.binary, {
      "v8x:deno": host,
    });
    const exports = instance.exports as WebAssembly.Exports & {
      __module_init: () => void;
      __v8x_graph_eval_state: () => number;
      __v8x_graph_eval_drain: () => void;
      __v8x_poll_graph_dynamic_imports: () => void;
      answer: () => number;
      probe: () => number;
      rejectionProbe: () => number;
      __exn_tag: WebAssembly.Tag;
      __exn_render_prepare: (value: unknown) => number;
      __exn_render_char: (index: number) => number;
    };
    const invoke = <T>(name: string, callable: () => T): T => {
      try {
        return callable();
      } catch (error) {
        if (error instanceof WebAssembly.Exception && error.is(exports.__exn_tag)) {
          const value = error.getArg(exports.__exn_tag, 0);
          const length = exports.__exn_render_prepare(value);
          let rendered = "";
          for (let index = 0; index < length; index++) {
            rendered += String.fromCharCode(exports.__exn_render_char(index));
          }
          throw new Error(`${name}: ${rendered}; calls=${JSON.stringify(calls)}`);
        }
        throw error;
      }
    };
    expect(exports[GRAPH_DYNAMIC_IMPORT_POLL_EXPORT]).toBeTypeOf("function");
    invoke("module init", exports.__module_init);
    expect(invoke("initial eval state", exports.__v8x_graph_eval_state)).toBe(0);
    expect(requests).toEqual([["./loaded-only-at-runtime.js", "file:///runtime-main.js", 0, [["type", "json"]]]]);

    settled = true;
    for (
      let checkpoint = 0;
      checkpoint < 8 && invoke("loop eval state", exports.__v8x_graph_eval_state) === 0;
      checkpoint++
    ) {
      invoke("dynamic import poll", exports.__v8x_poll_graph_dynamic_imports);
      invoke("graph eval drain", exports.__v8x_graph_eval_drain);
    }
    expect(invoke("terminal eval state", exports.__v8x_graph_eval_state)).toBe(1);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(["./loaded-only-at-runtime.js", "file:///runtime-main.js", 0, []]);
    expect(requests[2]).toEqual(["./rejected-at-runtime.js", "file:///runtime-main.js", 0, []]);
    expect(invoke("probe", exports.probe)).toBe(5);
    expect(invoke("rejection probe", exports.rejectionProbe)).toBe(1);
    expect(invoke("answer", exports.answer)).toBe(42);
    expect(calls).toEqual([
      [
        42,
        ["h", "object", 41],
        [
          "a",
          [
            ["d", 1],
            ["d", 1],
          ],
        ],
      ],
    ]);
    expect(disposed).toBe(3);
  });

  it("publishes the exception renderer required by the v8x graph host", async () => {
    const graph = prepareManifestGraph(
      new Map([
        [
          "file:///main.js",
          `
            export function fail() { throw new Error("graph failure"); }
            fail();
          `,
        ],
      ]),
      "file:///main.js",
    );
    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
        hostBridge: "always",
      },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const exports = WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).map((entry) => entry.name);
    expect(exports).toContain("__module_init");
    expect(exports).toContain("__exn_tag");
    expect(exports).toContain("__exn_render_prepare");
    expect(exports).toContain("__exn_render_char");
  });

  it("evaluates Deno synthetic JSON, text, and bytes modules against a shared classic-script global", async () => {
    const context = await compileMultiSource(
      {
        "/context.ts": `
          const realm: any = globalThis as any;
          realm.assert = (condition: any): void => {
            if (!condition) throw new Error("assert");
          };
          export function __v8x_context_global_this(): any { return realm; }
          export function __v8x_context_call(callable: any, receiver: any, args: any): any {
            if (args.length === 0) return callable.call(receiver);
            if (args.length === 1) return callable.call(receiver, args[0]);
            throw new RangeError("test context call supports at most one argument");
          }
        `,
      },
      "/context.ts",
      { target: "standalone", allowJs: true, skipSemanticDiagnostics: true, hostBridge: "always" },
    );
    expect(context.success, context.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance: contextInstance } = await WebAssembly.instantiate(context.binary, {});

    const graph = prepareManifestGraph(
      new Map([
        [
          "file:///b.js",
          `
            import jsonData from "./c.json" with { type: "json" };
            assert(jsonData.a === "b");
            assert(jsonData.c.d === 10);
            import text from "./d.txt" with { type: "text" };
            assert(text === "hello there");
            import bytes from "./e.bin" with { type: "bytes" };
            assert(bytes.length === 3);
            assert(bytes[0] === 1 && bytes[1] === 2 && bytes[2] === 3);
          `,
        ],
        [
          "file:///c.json",
          `const __v8x_synthetic_default_json = { a: "b", c: { d: 10 } }; export default __v8x_synthetic_default_json;`,
        ],
        [
          "file:///d.txt",
          `const __v8x_synthetic_default_text = "hello there"; export default __v8x_synthetic_default_text;`,
        ],
        [
          "file:///e.bin",
          `const __v8x_synthetic_default_bytes = new Uint8Array([1, 2, 3]); export default __v8x_synthetic_default_bytes;`,
        ],
      ]),
      "file:///b.js",
    );
    const result = await compileMultiSource(
      graph.files,
      graph.entry,
      {
        target: "standalone",
        platform: "deno",
        allowJs: true,
        skipSemanticDiagnostics: true,
        hostBridge: "always",
        deferTopLevelInit: true,
        standaloneGlobalThisImport: {
          module: "v8x:context",
          name: "__v8x_context_global_this",
          call: "__v8x_context_call",
        },
        link: ["v8x:context"],
      },
      undefined,
      graph.projectResolutions,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = {
      "v8x:context": {
        __v8x_context_global_this: contextInstance.exports.__v8x_context_global_this,
        __v8x_context_call: contextInstance.exports.__v8x_context_call,
      },
    } as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    try {
      (instance.exports.__module_init as () => void)();
    } catch (error) {
      const exports = instance.exports as Record<string, WebAssembly.ExportValue>;
      const tag = exports.__exn_tag as WebAssembly.Tag;
      const payload = (error as WebAssembly.Exception).getArg(tag, 0);
      const prepare = exports.__exn_render_prepare as (value: unknown) => number;
      const character = exports.__exn_render_char as (index: number) => number;
      const length = prepare(payload);
      let rendered = "";
      for (let index = 0; index < length; index++) rendered += String.fromCharCode(character(index));
      throw new Error(rendered);
    }
  });
});
