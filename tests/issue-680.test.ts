import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function envImportNames(result: { imports: { module: string; name: string }[] }): string[] {
  return result.imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function compileStandalone(source: string) {
  const result = await compile(source, { fileName: "issue-680.ts", target: "standalone" });
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  return result;
}

async function instantiateStandalone(source: string): Promise<Record<string, Function>> {
  const result = await compileStandalone(source);
  const instance = await WebAssembly.instantiate(new WebAssembly.Module(result.binary), {});
  return instance.exports as Record<string, Function>;
}

describe("#680 Wasm-native generator state machines", () => {
  it("lowers sequential numeric yields without generator host imports", async () => {
    const result = await compileStandalone(`
      function* gen(): Generator<number> {
        yield 1;
        yield 2;
        return 3;
      }

      export function run(): number {
        const g = gen();
        const a = g.next();
        const b = g.next();
        const c = g.next();
        const d = g.next();
        return a.value * 1000 + b.value * 100 + c.value * 10 + (c.done ? 4 : 0) + (d.done ? 1 : 0);
      }
    `);

    expect(envImportNames(result).filter((name) => name.startsWith("__gen_") || name === "__create_generator")).toEqual(
      [],
    );
    expect(result.wat).toContain("__GenState_gen");

    const instance = await WebAssembly.instantiate(new WebAssembly.Module(result.binary), {});
    expect((instance.exports as Record<string, Function>).run()).toBe(1235);
  });

  it("persists parameters in the native generator state struct", async () => {
    const exports = await instantiateStandalone(`
      function* gen(start: number): Generator<number> {
        yield start;
        yield start + 1;
        return start + 2;
      }

      export function run(): number {
        const g = gen(5);
        const a = g.next();
        const b = g.next();
        const c = g.next();
        return a.value * 100 + b.value * 10 + c.value + (c.done ? 1000 : 0);
      }
    `);

    expect(exports.run()).toBe(1567);
  });

  it("runs generator body effects lazily on next", async () => {
    const exports = await instantiateStandalone(`
      let hits = 0;

      function tick(): number {
        hits = hits + 1;
        return hits;
      }

      function* gen(): Generator<number> {
        yield tick();
        yield tick();
      }

      export function run(): number {
        const g = gen();
        const before = hits;
        const a = g.next();
        const afterOne = hits;
        const b = g.next();
        return before * 10000 + afterOne * 1000 + hits * 100 + a.value * 10 + b.value;
      }
    `);

    expect(exports.run()).toBe(1212);
  });

  it("standalone class generator method compiles host-free (native state machine, no __gen_* imports)", async () => {
    // (#680 refresh, #3561/#3562 audit) Standalone generators lower to the native
    // `__GenState` state machine — `addGeneratorImports` (registry/imports.ts)
    // early-returns under `--target standalone`, so the host eager-buffer imports
    // (`__gen_create_buffer` / `__create_generator`) are NEVER registered there.
    // A class generator method therefore leaks ZERO generator host imports and
    // produces valid Wasm. (The ORIGINAL assertion — that these imports ARE
    // present — silently rotted when generators went native; it was invisible
    // outside required checks, #3008. See #680 regression, bisected to #3341.)
    const result = await compileStandalone(`
      class C {
        *method(): Generator<number> {}
      }

      export function run(): number {
        return 1;
      }
    `);

    expect(envImportNames(result).filter((n) => n.startsWith("__gen_") || n === "__create_generator")).toEqual([]);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("default-target generators are Wasm-native too — no host __create_generator eager buffer", async () => {
    // (#680 refresh) The native generator state machine now serves the default
    // gc/host target as well; the host eager-buffer `__create_generator` import
    // is retired there too (only value-boxing helpers like `__box_boolean`
    // remain). Guard the OBSERVABLE, not just the import shape: the generator
    // runs and yields correctly.
    const result = await compile(`
      function* gen(): Generator<number> {
        yield 1;
      }
      export function run(): number {
        return gen().next().value;
      }
    `);

    expect(result.success).toBe(true);
    expect(envImportNames(result)).not.toContain("__create_generator");
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });
});
