// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { WASI } from "node:wasi";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";
import { classValueLifecycleCases } from "./fixtures/issue-7139-class-value-lifecycle-cases.js";

for (const fixture of classValueLifecycleCases) {
  it(`JavaScript oracle: ${fixture.name}`, () => {
    const js = ts.transpileModule(fixture.source.replace(/export /g, ""), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    expect(new Function(`${js};return run();`)()).toBe(fixture.expected);
  });
  for (const target of ["standalone", "wasi"] as const) {
    describe(`IR class value ${fixture.name}: ${target}`, () => {
      let result: Awaited<ReturnType<typeof compile>>;
      let actual: unknown;
      beforeAll(async () => {
        result = await compile(fixture.source, {
          fileName: `class-values-${fixture.name}.ts`,
          target,
          experimentalIR: true,
          trackIrOutcomes: true,
          skipSemanticDiagnostics: true,
        });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        const module = new WebAssembly.Module(result.binary);
        expect(WebAssembly.Module.imports(module).filter((entry) => entry.module !== "wasi_snapshot_preview1")).toEqual(
          [],
        );
        const wasi =
          target === "wasi" ? new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true }) : undefined;
        const instance = new WebAssembly.Instance(module, {
          ...(result.importObject ?? {}),
          ...(wasi ? wasi.getImportObject() : {}),
        });
        const x = instance.exports as Record<string, any>;
        if (wasi && typeof x._start === "function") expect(wasi.start(instance)).toBe(0);
        else x.__module_init?.();
        actual = x.run();
      });
      it("preserves the source binding, initialization order and evaluation identity", () => {
        expect(actual).toBe(fixture.expected);
      });
      it("owns every source function through IR without a legacy body", () => {
        const source = ts.createSourceFile("fixture.ts", fixture.source, ts.ScriptTarget.Latest, true);
        const names: string[] = [];
        const visit = (node: ts.Node): void => {
          if (ts.isFunctionDeclaration(node) && node.name) names.push(node.name.text);
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          const rows = result.irOutcomes?.filter((row) => row.displayName === name && row.unitKind === "function");
          expect(rows, name).toHaveLength(1);
          expect(rows![0].kind, `${name}: ${rows![0].detail}`).toBe("emitted");
          expect(rows![0].irBodyEmitted, name).toBe(true);
          expect(rows![0].legacyBodyEmitted, name).toBe(false);
          expect(rows![0].directBodyEmissions, name).toBe(0);
        }
        expect(result.irPostClaimErrors).toEqual([]);
      });
    });
  }
}
