// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compile, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const STRING_ARRAY_SOURCE = `
  export function pick(index: number): string {
    const labels = ["SUN", "MON", "TUE"];
    return labels[index];
  }
`;

async function tracked(source: string, options: CompileOptions = {}): Promise<CompileResult> {
  return compile(source, {
    fileName: "issue-2856-calendar-residuals.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
}

function dateImportNames(result: CompileResult): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((entry) => entry.kind === "function" && entry.module === "env" && entry.name.startsWith("Date_"))
    .map((entry) => entry.name)
    .sort();
}

describe("#2856 Calendar residual lowering", () => {
  it("stores a uniform host-string literal table in the externref vec family", async () => {
    const result = await tracked(`
      export function install(sink: HTMLElement, index: number): void {
        const labels = ["SUN", "MON", "TUE"];
        sink.textContent = labels[index];
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const sink = { textContent: "" };
    (instance.exports.install as (sink: object, index: number) => void)(sink, 1);
    expect(sink.textContent).toBe("MON");
  });

  it.each([
    ["native strings", { nativeStrings: true }],
    ["standalone", { target: "standalone" as const }],
    ["WASI", { target: "wasi" as const }],
    ["linear", { target: "linear" as const }],
  ])("keeps uniform string arrays on legacy in %s", async (_label, options) => {
    const result = await tracked(STRING_ARRAY_SOURCE, options);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("pick");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([
    ["mixed", `const labels = ["A", 1]; void labels;`],
    ["spread", `const base = ["B"]; const labels = ["A", ...base]; void labels;`],
    ["sparse", `const labels = ["A", , "B"]; void labels;`],
    ["annotated carrier", `const labels: string[] = ["A"]; void labels;`],
    ["callback use", `const labels = ["A"]; labels.map(() => "B");`],
  ])("rejects the unsupported %s string-array shape before claim", async (_label, body) => {
    const result = await tracked(`export function unsupported(): void { ${body} }`);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("unsupported");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("lowers exact ambient Date snapshots through the synthetic host ABI", async () => {
    const result = await tracked(`
      export function stamp(): number {
        const snapshot = new Date();
        return snapshot.getFullYear() * 10000 + snapshot.getMonth() * 100 + snapshot.getDate();
      }
      export function direct(): number { return new Date().getFullYear(); }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["stamp", "direct"]));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual(["Date_getDate", "Date_getFullYear", "Date_getMonth", "Date_new"]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const snapshot = {};
    let constructions = 0;
    imports.env.Date_new = () => {
      constructions++;
      return snapshot;
    };
    imports.env.Date_getDate = (value: object) => {
      expect(value).toBe(snapshot);
      return 17;
    };
    imports.env.Date_getMonth = (value: object) => {
      expect(value).toBe(snapshot);
      return 4;
    };
    imports.env.Date_getFullYear = (value: object) => {
      expect(value).toBe(snapshot);
      return 2024;
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.stamp as () => number)()).toBe(20240417);
    expect((instance.exports.direct as () => number)()).toBe(2024);
    expect(constructions).toBe(2);
  });

  it("uses the same host Date snapshot ABI in module init and function bodies", async () => {
    const result = await tracked(`
      let moduleYear = new Date().getFullYear();
      export function years(): number {
        return moduleYear * 10000 + new Date().getFullYear();
      }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["<module-init>", "years"]));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual(["Date_getFullYear", "Date_new"]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const snapshot = {};
    let constructions = 0;
    imports.env.Date_new = () => {
      constructions++;
      return snapshot;
    };
    imports.env.Date_getFullYear = (value: object) => {
      expect(value).toBe(snapshot);
      return 2024;
    };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.years as () => number)()).toBe(20242024);
    expect(constructions).toBe(2);
  });

  it("materializes the host Date ABI for a module-init-only snapshot", async () => {
    const result = await tracked(`
      let moduleYear = new Date().getFullYear();
      export function years(): number { return moduleYear; }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual(["Date_getFullYear", "Date_new"]);
  });

  it.each(["Date_new", "Date_getFullYear"])("demotes a module-init-only snapshot when %s is occupied", async (name) => {
    const result = await tracked(`
        function ${name}(): number { return 1; }
        let moduleYear = new Date().getFullYear();
        export function years(): number { return moduleYear; }
      `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);
  });

  it("closes module-init callees when a Date import collision demotes the module", async () => {
    const result = await tracked(`
      function Date_new(): number { return 1; }
      function helper(): number { return 7; }
      let moduleYear = new Date().getFullYear() + helper();
      export function years(): number { return moduleYear; }
    `);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>");
    expect(result.irCompiledFuncs ?? []).not.toContain("helper");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);
  });

  it.each([
    ["constructor argument", `const d = new Date(0); return d.getDate();`],
    ["unsupported getter", `const d = new Date(); return d.getTime();`],
    ["alias escape", `const d = new Date(); const alias = d; return alias.getDate();`],
    ["optional getter", `const d = new Date(); return d?.getDate();`],
  ])("rejects Date %s before claim", async (_label, body) => {
    const result = await tracked(`export function snap(): number { ${body} }`);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("snap");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);
  });

  it("keeps a shadowed Date constructor on local-class IR without installing the host-Date ABI", async () => {
    const result = await tracked(`
      class Date { getDate(): number { return 9; } }
      export function snap(): number { const d = new Date(); return d.getDate(); }
    `);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["snap", "Date_getDate"]));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.snap as () => number)()).toBe(9);
  });

  it.each(["standalone", "wasi"] as const)("keeps Date snapshots host-free in %s", async (target) => {
    const result = await tracked(
      `
      export function snap(): number { const d = new Date(); return d.getFullYear(); }
    `,
      { target },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("snap");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);
  });

  it.each(["Date_new", "Date_getDate"])("demotes an occupied %s name without partial imports", async (name) => {
    const source = `
      function ${name}(): number { return 1; }
      function snap(): number { const d = new Date(); return d.getDate(); }
      export function caller(): number { return snap(); }
    `;
    const [first, second] = await Promise.all([tracked(source), tracked(source)]);
    for (const result of [first, second]) {
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(result.irCompiledFuncs ?? []).not.toContain("snap");
      expect(result.irCompiledFuncs ?? []).not.toContain("caller");
      expect(result.irFirstSkipped ?? []).not.toContain("snap");
      expect(result.irFirstSkipped ?? []).not.toContain("caller");
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(dateImportNames(result)).toEqual([]);
    }
    expect([...first.binary]).toEqual([...second.binary]);
  });

  it("closes a connected mixed-getter collision before adding any Date import", async () => {
    const result = await tracked(`
      function Date_getMonth(): number { return 1; }
      function month(): number { const d = new Date(); return d.getMonth(); }
      function year(): number { const d = new Date(); return d.getFullYear(); }
      export function caller(): number { return month() + year(); }
    `);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("month");
    expect(result.irCompiledFuncs ?? []).not.toContain("year");
    expect(result.irCompiledFuncs ?? []).not.toContain("caller");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);
  });

  it("runs callback final demotion before mutating the Date import set", async () => {
    const result = await tracked(`
      type i32 = number;
      function __make_callback(_id: i32, capture: object): object { return capture; }
      export function install(target: EventTarget, sink: HTMLElement): number {
        target.addEventListener("tick", () => { sink.textContent = "tick"; });
        const d = new Date();
        return d.getDate();
      }
    `);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("install");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(dateImportNames(result)).toEqual([]);
  });

  it("genuinely emits the live single-source Calendar owners with zero postclaim", async () => {
    const fileName = new URL("../website/playground/examples/dom/calendar.ts", import.meta.url);
    const source = readFileSync(fileName, "utf8");
    const previousStrictBalance = process.env.JS2WASM_STRICT_BALANCE;
    process.env.JS2WASM_STRICT_BALANCE = "1";
    let result: CompileResult;
    try {
      result = await tracked(source, { fileName: fileName.pathname });
    } finally {
      if (previousStrictBalance === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_STRICT_BALANCE");
      } else {
        process.env.JS2WASM_STRICT_BALANCE = previousStrictBalance;
      }
    }
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining([
        "renderCal",
        "renderCal__closure_0",
        "renderCal__closure_1",
        "renderCal__closure_2",
        "onDay",
        "main",
        "main__closure_0",
        "main__closure_1",
        "main__closure_2",
        "main__closure_3",
      ]),
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.errors.filter((error) => /Stack-balance fixup \[local-set-coerce\]/.test(error.message))).toEqual([]);
    expect(dateImportNames(result)).toEqual(["Date_getDate", "Date_getFullYear", "Date_getMonth", "Date_new"]);
  });
});
