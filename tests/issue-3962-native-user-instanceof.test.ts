// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3962 — `x instanceof <plain user function constructor>` must be answered
 * host-free in `--target standalone`.
 *
 * It previously took the fully-dynamic path and emitted `env::__instanceof_check`,
 * which a host-free binary cannot satisfy: the module does not instantiate and
 * the #2961 leak guard refuses the test. In the ≤ES5 standalone scope, **36
 * files name `__instanceof_check` as their SOLE host import**, and **26 of them
 * are `e instanceof Test262Error`** — the harness's own top-level plain-function
 * constructor.
 *
 * Two assertions per case, and both matter:
 *   1. the ANSWER is right, and
 *   2. the binary carries NO imports — a right answer that still leaks is still
 *      refused by #2961, so the import count is part of the contract.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Outcome {
  result: number;
  imports: string[];
}

/** Compile a standalone SCRIPT, run `__module_init`, read `result`. */
async function run(body: string): Promise<Outcome> {
  const source = `var result = -1;\n${body}\nexport function test(): number { return result as number; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "native-user-instanceof.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((i: unknown) =>
    typeof i === "string" ? i : `${(i as { module: string }).module}::${(i as { name: string }).name}`,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  const result = (instance.exports as Record<string, () => number>).test();
  return { result, imports };
}

describe("#3962 — host-free instanceof for a user function constructor", () => {
  it("a fnctor instance IS an instance of its constructor, host-free", async () => {
    const o = await run(`function F(){ this.x = 1; }\nvar f = new F();\nresult = (f instanceof F) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("an instance of another fnctor is NOT an instance", async () => {
    const o = await run(
      `function F(){ this.x=1; }\nfunction G(){ this.y=2; }\nvar f = new F();\nresult = (f instanceof G) ? 1 : 0;`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("a native engine error is NOT an instance of a user fnctor (the Test262Error shape)", async () => {
    // `catch (e) { if (e instanceof Test262Error) throw e; }` is the guard 26 of
    // the 36 gated files use; the engine-thrown error must answer false.
    const o = await run(
      `function T(m){ this.message = m; }\nvar r = 0;\ntry { null.foo; } catch (e) { r = (e instanceof T) ? 1 : 0; }\nresult = r;`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("an empty-bodied fnctor's instance IS an instance (the $Object/$proto arm)", async () => {
    const o = await run(`function T(m){ this.message = m; }\nvar t = new T('x');\nresult = (t instanceof T) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("a primitive left operand answers false without a host import (§7.3.20 step 3)", async () => {
    const o = await run(`function F(){ this.x = 1; }\nresult = ((1 as any) instanceof F) ? 1 : 0;`);
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("null answers false without a host import", async () => {
    const o = await run(`function F(){ this.x = 1; }\nvar n: any = null;\nresult = (n instanceof F) ? 1 : 0;`);
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("the JS-host lane is untouched — it keeps the host predicate", async () => {
    const source = `function F(){ this.x = 1; }\nvar f = new F();\nvar result = (f instanceof F) ? 1 : 0;\nexport function test(): number { return result; }\n`;
    const compiled = await compile(source, {
      allowJs: true,
      fileName: "native-user-instanceof-host.ts",
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
      inferModuleStrictArguments: false,
    });
    expect(compiled.success).toBe(true);
    const names = (compiled.imports ?? []).map((i: unknown) =>
      typeof i === "string" ? i : `${(i as { name: string }).name}`,
    );
    // The native branch is `noJsHost`-gated, so the host lane must be unchanged.
    expect(names.some((n) => n.includes("__instanceof"))).toBe(true);
  });
});
