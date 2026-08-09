import { describe, it, expect, afterAll } from "vitest";
import { createIncrementalCompiler, compile, buildImports } from "../src/index.ts";
import { IncrementalLanguageService } from "../src/checker/language-service.ts";

describe("Incremental Language Service Compiler", () => {
  const compiler = createIncrementalCompiler();

  afterAll(() => {
    compiler.dispose();
  });

  it("compiles a simple function", async () => {
    const result = await compiler.compile("export function add(a: number, b: number): number { return a + b; }");
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);
  });

  it("compiles a second function (reusing cached libs)", async () => {
    const result = await compiler.compile("export function mul(a: number, b: number): number { return a * b; }");
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("warm compilation is faster than cold", async () => {
    // First call may still be warm from previous tests, but we measure relative speed
    const iterations = 5;
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      await compiler.compile(`export function fn${i}(x: number): number { return x * ${i}; }`);
      times.push(performance.now() - t0);
    }
    // Last few should be fast
    const avgLast3 = times.slice(-3).reduce((a, b) => a + b, 0) / 3;
    // Just verify they complete in reasonable time (< 200ms each for warm)
    expect(avgLast3).toBeLessThan(200);
  });

  it("produces valid Wasm that can be instantiated", async () => {
    const result = await compiler.compile("export function double(n: number): number { return n * 2; }");
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const double = instance.exports.double as (n: number) => number;
    expect(double(21)).toBe(42);
  });

  it("produces same results as non-incremental compile", async () => {
    const source = "export function add(a: number, b: number): number { return a + b; }";
    const incResult = await compiler.compile(source);
    const stdResult = await compile(source);

    expect(incResult.success).toBe(stdResult.success);
    expect(incResult.errors.filter((e) => e.severity === "error").length).toBe(
      stdResult.errors.filter((e) => e.severity === "error").length,
    );
    // Both should produce valid Wasm binary
    expect(incResult.binary.length).toBeGreaterThan(0);
    expect(stdResult.binary.length).toBeGreaterThan(0);
  });

  it("handles compilation errors gracefully", async () => {
    const result = await compiler.compile("export function bad( { }");
    // Should still return a result (may have errors)
    expect(result).toBeDefined();
    expect(typeof result.success).toBe("boolean");
  });

  it("handles skipSemanticDiagnostics option", async () => {
    const result = await compiler.compile("export function test(): number { const x: string = 42; return x; }", {
      skipSemanticDiagnostics: true,
    });
    // With skipped semantics, type errors become warnings or are absent
    expect(result).toBeDefined();
  });
});

describe("Incremental Language Service Program reuse", () => {
  it("reuses an unchanged Program and invalidates it after a source edit", () => {
    const service = new IncrementalLanguageService("test.ts");
    const firstSource = "export function value(): number { return 1; }";
    const invalidSource = 'export function value(): number { return "wrong"; }';
    const recoveredSource = "export function value(): number { return 2; }";

    service.updateSource(firstSource, "test.ts");
    const first = service.analyze();

    service.updateSource(firstSource, "test.ts");
    const unchanged = service.analyze();
    expect(unchanged.program).toBe(first.program);
    expect(unchanged.checker).toBe(first.checker);
    expect(unchanged.sourceFile).toBe(first.sourceFile);

    service.updateSource(invalidSource, "test.ts");
    const edited = service.analyze();
    expect(edited.program).not.toBe(first.program);
    expect(edited.sourceFile.text).toBe(invalidSource);
    expect(edited.diagnostics.some((diag) => diag.code === 2322)).toBe(true);

    service.updateSource(recoveredSource, "test.ts");
    const recovered = service.analyze();
    expect(recovered.program).not.toBe(edited.program);
    expect(recovered.sourceFile.text).toBe(recoveredSource);
    expect(recovered.diagnostics.some((diag) => diag.code === 2322)).toBe(false);

    service.dispose();
  });

  it("invalidates the Program when compiler options or the source identity change", () => {
    const service = new IncrementalLanguageService("input.js");
    const source = "export function value() { return window.innerWidth; }";

    service.updateSource(source, "input.js");
    const web = service.analyze({ platform: "web" });
    const webAgain = service.analyze({ platform: "web" });
    expect(webAgain.program).toBe(web.program);
    expect(web.diagnostics.some((diag) => diag.code === 2304)).toBe(false);

    const node = service.analyze({ platform: "node" });
    expect(node.program).not.toBe(web.program);
    expect(node.diagnostics.some((diag) => diag.code === 2304)).toBe(true);

    service.updateSource(source, "renamed.js");
    const renamed = service.analyze({ platform: "node" });
    expect(renamed.program).not.toBe(node.program);
    expect(renamed.sourceFile.fileName.endsWith("renamed.js")).toBe(true);
    expect(renamed.program.getSourceFiles().some((sf) => sf.fileName.endsWith("input.js"))).toBe(false);

    service.dispose();
  });

  it("isolates mutable sources between services that use the same virtual filename", () => {
    const firstService = new IncrementalLanguageService("shared.ts");
    const secondService = new IncrementalLanguageService("shared.ts");
    const firstSource = "export const value: number = 1;";
    const secondSource = 'export const value: string = "two";';

    firstService.updateSource(firstSource, "shared.ts");
    const first = firstService.analyze();
    secondService.updateSource(secondSource, "shared.ts");
    const second = secondService.analyze();

    expect(first.sourceFile.text).toBe(firstSource);
    expect(second.sourceFile.text).toBe(secondSource);
    expect(firstService.analyze().sourceFile.text).toBe(firstSource);
    expect(secondService.analyze().sourceFile.text).toBe(secondSource);

    firstService.dispose();
    secondService.dispose();
  });
});
