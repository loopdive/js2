// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, compileMulti, type CompileOptions, type CompileResult, type ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const HOST_CALLBACK_SOURCE = `
export function install(target: EventTarget, sink: HTMLElement, value: number): void {
  target.addEventListener("tick", () => {
    sink.textContent = value.toString();
  });
}
`;

async function compileHostCallback(
  source: string = HOST_CALLBACK_SOURCE,
  options: CompileOptions = {},
): Promise<CompileResult> {
  return compile(source, {
    fileName: "issue-3214-b2.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
}

function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

function wasmFunctionImportIndex(binary: Uint8Array, name: string): number {
  let functionIndex = 0;
  for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    if (entry.kind !== "function") continue;
    if (entry.name === name) return functionIndex;
    functionIndex++;
  }
  return -1;
}

describe("#3214 B2 — ambient void host callbacks", () => {
  it("distinguishes reusable and one-shot nonconstructible void wrappers", () => {
    const manifest: ImportDescriptor[] = [
      {
        module: "env",
        name: "__make_callback",
        kind: "func",
        intent: { type: "callback_maker" },
      },
    ];
    const imports = buildImports(manifest);
    let dispatches = 0;
    const closure = (): number => ++dispatches;
    const otherClosure = (): number => 0;

    const callback = imports.env.__make_callback(-1, closure);
    expect(callback).toBe(imports.env.__make_callback(-1, closure));
    expect(callback).not.toBe(imports.env.__make_callback(-1, otherClosure));
    expect(callback.length).toBe(0);
    expect(callback({ type: "tick" })).toBeUndefined();
    expect(callback()).toBeUndefined();
    expect(dispatches).toBe(2);
    expect(() => Reflect.construct(callback, [])).toThrow(TypeError);

    const oneShot = imports.env.__make_callback(-2, closure);
    expect(oneShot).not.toBe(imports.env.__make_callback(-2, closure));
    expect(oneShot()).toBeUndefined();
    expect(dispatches).toBe(3);
    expect(() => Reflect.construct(oneShot, [])).toThrow(TypeError);

    const legacyCapture = { value: 20 };
    const legacyCallback = imports.env.__make_callback(7, legacyCapture);
    imports.setExports?.({
      __cb_7: (capture: typeof legacyCapture, add: number): number => capture.value + add,
    });
    expect(legacyCallback(22)).toBe(42);
  });

  it.each([false, true])("dispatches the IR callback twice (optimize=%s)", async (optimize) => {
    const result = await compileHostCallback(HOST_CALLBACK_SOURCE, { optimize });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const installBody = watFunctionBody(result.wat, "install");
    expect(installBody).toContain("i32.const -2");
    const callbackMakerIndex = wasmFunctionImportIndex(result.binary, "__make_callback");
    expect(callbackMakerIndex).toBeGreaterThanOrEqual(0);
    expect(installBody).toContain(`call ${callbackMakerIndex}`);
    expect(result.wat).toContain("(func $install__closure_0");
    const voidWrapperType = result.wat
      .split("\n")
      .find((line) => /\$__fn_wrap_\d+_type \(func/.test(line) && !line.includes("(result "));
    expect(voidWrapperType, "missing canonical zero-result closure type").toBeDefined();

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);

    const bridgeExports = Object.keys(instance.exports);
    expect(bridgeExports).toContain("__call_fn_0");
    expect(bridgeExports).not.toEqual(
      expect.arrayContaining([
        "__call_fn_1",
        "__call_fn_method_0",
        "__closure_arity",
        "__is_closure",
        "__closure_has_rest",
      ]),
    );

    const listeners: Function[] = [];
    const target = {
      addEventListener(_type: string, listener: Function): void {
        listeners.push(listener);
      },
    };
    const sink = { textContent: "" };
    (instance.exports.install as (target: object, sink: object, value: number) => void)(target, sink, 42);

    expect(listeners).toHaveLength(1);
    const listener = listeners[0]!;
    expect(listener({ type: "tick" })).toBeUndefined();
    expect(sink.textContent).toBe("42");
    sink.textContent = "";
    expect(listener({ type: "tick" })).toBeUndefined();
    expect(sink.textContent).toBe("42");
    expect(() => Reflect.construct(listener, [])).toThrow(TypeError);
  });

  it("restores generic closure bridges when the same wrapper has an ordinary allocation", async () => {
    const result = await compileHostCallback(`
      export function install(target: EventTarget, sink: HTMLElement): void {
        target.addEventListener("tick", () => { sink.textContent = "exact"; });
      }
      export function getOrdinary(): any {
        return (): void => {};
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const bridgeExports = Object.keys(instance.exports);
    expect(bridgeExports).toEqual(
      expect.arrayContaining(["__call_fn_0", "__call_fn_1", "__call_fn_method_0", "__closure_arity", "__is_closure"]),
    );

    const ordinary = (instance.exports.getOrdinary as () => unknown)();
    expect((instance.exports.__is_closure as (value: unknown) => number)(ordinary)).toBe(1);
    expect((instance.exports.__call_fn_0 as (value: unknown) => unknown)(ordinary)).toBeNull();
  });

  it("keeps multiple certified callback sites distinct in source order", async () => {
    const result = await compileHostCallback(`
      export function install(
        target: EventTarget,
        numberSink: HTMLElement,
        textSink: HTMLElement,
        value: number,
        label: string,
      ): void {
        target.addEventListener("number", () => {
          numberSink.textContent = value.toString();
        });
        target.addEventListener("text", () => {
          textSink.textContent = label;
        });
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).toContain("(func $install__closure_0");
    expect(result.wat).toContain("(func $install__closure_1");

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);

    const listeners: Function[] = [];
    const eventTypes: string[] = [];
    const target = {
      addEventListener(type: string, listener: Function): void {
        eventTypes.push(type);
        listeners.push(listener);
      },
    };
    const numberSink = { textContent: "" };
    const textSink = { textContent: "" };
    (
      instance.exports.install as (
        target: object,
        numberSink: object,
        textSink: object,
        value: number,
        label: string,
      ) => void
    )(target, numberSink, textSink, 42, "second");

    expect(eventTypes).toEqual(["number", "text"]);
    expect(listeners).toHaveLength(2);
    expect(listeners[0]).not.toBe(listeners[1]);
    expect(listeners[0]!()).toBeUndefined();
    expect(numberSink.textContent).toBe("42");
    expect(textSink.textContent).toBe("");
    expect(listeners[1]!()).toBeUndefined();
    expect(numberSink.textContent).toBe("42");
    expect(textSink.textContent).toBe("second");
  });

  it.each([
    ["wrong method", `target.removeEventListener("tick", () => { sink.textContent = "x"; });`],
    ["options argument", `target.addEventListener("tick", () => { sink.textContent = "x"; }, false);`],
    ["parameter", `target.addEventListener("tick", (_event: Event) => { sink.textContent = "x"; });`],
    ["concise body", `target.addEventListener("tick", () => sink.textContent = "x");`],
    ["async", `target.addEventListener("tick", async () => { sink.textContent = "x"; });`],
    ["non-void", `target.addEventListener("tick", (): number => { return 1; });`],
    [
      "mutable capture",
      `let count: number = 0; target.addEventListener("tick", () => { count++; sink.textContent = count.toString(); });`,
    ],
    ["outer write", `target.addEventListener("tick", () => { sink.textContent = value.toString(); }); value = 1;`],
    [
      "nested arrow",
      `target.addEventListener("tick", () => { const nested = (): number => 1; sink.textContent = nested().toString(); });`,
    ],
    [
      "lexical arguments",
      `target.addEventListener("tick", () => { sink.textContent = arguments.length.toString(); });`,
    ],
  ] as const)("rejects %s before the IR claim", async (_label, body) => {
    const result = await compileHostCallback(`
      export function install(target: EventTarget, sink: HTMLElement, value: number): void {
        ${body}
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([
    [
      "nested function before",
      `function nested(): number { return 1; }
       target.addEventListener("tick", () => { sink.textContent = value.toString(); });
       nested();`,
    ],
    [
      "nested function after",
      `target.addEventListener("tick", () => { sink.textContent = value.toString(); });
       function nested(): number { return 1; }
       nested();`,
    ],
    [
      "ordinary arrow before",
      `const ordinary = (): number => 1;
       target.addEventListener("tick", () => { sink.textContent = value.toString(); });
       ordinary();`,
    ],
    [
      "ordinary arrow after",
      `target.addEventListener("tick", () => { sink.textContent = value.toString(); });
       const ordinary = (): number => 1;
       ordinary();`,
    ],
    [
      "non-certified host callback",
      `target.addEventListener("tick", () => { sink.textContent = value.toString(); });
       target.addEventListener("tock", (_event: Event) => { sink.textContent = "invalid"; });`,
    ],
  ] as const)("rejects a %s sibling before the IR claim", async (_label, body) => {
    const result = await compileHostCallback(`
      export function install(target: EventTarget, sink: HTMLElement, value: number): void {
        ${body}
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("rejects a user-defined same-name method", async () => {
    const result = await compileHostCallback(`
      class LocalTarget {
        addEventListener(_type: string, callback: () => void): void { callback(); }
      }
      export function install(target: LocalTarget, sink: HTMLElement): void {
        target.addEventListener("tick", () => { sink.textContent = "x"; });
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("IR-emits when a source function occupies the first lifted display name", async () => {
    const result = await compileHostCallback(`
      function install__closure_0(): number { return 0; }
      export function install(target: EventTarget, sink: HTMLElement): void {
        target.addEventListener("tick", () => { sink.textContent = "x"; });
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("IR-emits when a source function occupies a later lifted display name", async () => {
    const result = await compileHostCallback(`
      function install__closure_1(): number { return 0; }
      export function install(target: EventTarget, sink: HTMLElement, value: number): void {
        target.addEventListener("tick", () => { sink.textContent = value.toString(); });
        target.addEventListener("tock", () => { sink.textContent = "second"; });
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("demotes when __make_callback resolves to a defined function instead of the exact host import", async () => {
    const result = await compileHostCallback(`
      type i32 = number;
      function __make_callback(_id: i32, capture: object): object { return capture; }
      export function install(target: EventTarget, sink: HTMLElement): void {
        target.addEventListener("tick", () => { sink.textContent = "x"; });
      }
    `);

    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a potentially final-demoted B2 call component out of the IR-first skip set", async () => {
    const result = await compileHostCallback(`
      type i32 = number;
      function __make_callback(_id: i32, capture: object): object { return capture; }
      function install(n: number): number {
        document.body.addEventListener("tick", () => { n + 1; });
        return n;
      }
      export function caller(n: number): number { return install(n); }
      export function independent(n: number): number { return n + 1; }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irCompiledFuncs ?? []).not.toContain("caller");
    expect(result.irCompiledFuncs ?? []).toContain("independent");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irFirstSkipped ?? []).not.toContain("install");
    expect(result.irFirstSkipped ?? []).not.toContain("caller");
    expect(result.irFirstSkipped ?? []).toContain("independent");
  });

  it.each([
    [
      "property",
      `
        export function install(target: EventTarget, sink: HTMLElement, textContent: number): void {
          target.addEventListener("tick", () => { sink.textContent = "x"; });
        }
      `,
    ],
    [
      "method",
      `
        export function install(target: EventTarget, sink: HTMLElement, value: number, toString: number): void {
          target.addEventListener("tick", () => { sink.textContent = value.toString(); });
        }
      `,
    ],
    [
      "property and destructured binding",
      `
        export function install(target: EventTarget, sink: HTMLElement): void {
          const [textContent] = [1];
          target.addEventListener("tick", () => { sink.textContent = "x"; });
        }
      `,
    ],
  ] as const)("rejects an outer binding colliding with a callback %s name before claim", async (_label, source) => {
    const result = await compileHostCallback(source);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("allocates captured closure subtype names uniquely across source overlays", async () => {
    const result = await compileMulti(
      {
        "./other.ts": `
          export function installOther(target: EventTarget, sink: HTMLElement): void {
            target.addEventListener("other", () => { sink.textContent = "other"; });
          }
        `,
        "./entry.ts": `
          import { installOther } from "./other.ts";
          export function installEntry(target: EventTarget, sink: HTMLElement): void {
            target.addEventListener("entry", () => { sink.textContent = "entry"; });
          }
          export function retainOther(target: EventTarget, sink: HTMLElement): void {
            installOther(target, sink);
          }
        `,
      },
      "./entry.ts",
      {
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["installOther", "installEntry"]));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const subtypeNames = [...result.wat.matchAll(/\(type \$(__ir_closure_\d+)/g)].map((match) => match[1]);
    expect(new Set(subtypeNames).size).toBeGreaterThanOrEqual(2);
  });

  it("keeps B2 disabled and import-free in standalone", async () => {
    const [irOn, irOff] = await Promise.all([
      compileHostCallback(HOST_CALLBACK_SOURCE, { target: "standalone" }),
      compileHostCallback(HOST_CALLBACK_SOURCE, { target: "standalone", experimentalIR: false }),
    ]);

    expect(irOn.success).toBe(irOff.success);
    expect(irOn.irCompiledFuncs ?? []).not.toContain("install");
    expect(irOn.irPostClaimErrors ?? []).toEqual([]);
    if (irOn.success && irOff.success) {
      const importNames = (result: CompileResult): string[] =>
        WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
          (entry) => `${entry.module}.${entry.name}`,
        );
      expect(importNames(irOn)).toEqual(importNames(irOff));
      expect(importNames(irOn)).not.toContain("env.__make_callback");
    }
  });
});
