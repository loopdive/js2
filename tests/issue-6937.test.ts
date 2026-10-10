// #6937 — `inferModuleStrictArguments: false` is the single-file Script-goal
// switch for a source whose top-level `export` is a synthetic entry point
// (test262 wrappers, Octane/benchmark drivers, QuickJS canaries). Before the
// fix it made function code sloppy but left `ctx.sourceIsModule` following the
// synthetic `export`, so top-level `this` stayed `undefined` and top-level
// `var`s stayed module-scoped. Expected values are node's Script-goal results
// (`vm.runInThisContext`) for the same programs, asserted as literals.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.ts";

type Lane = "gc" | "standalone";

async function runMain(src: string, lane: Lane, scriptGoal: boolean): Promise<unknown> {
  const result = await compile(src, {
    fileName: "input.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(scriptGoal ? { inferModuleStrictArguments: false } : {}),
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  let exports: Record<string, unknown>;
  if (lane === "standalone") {
    exports = (await WebAssembly.instantiate(await WebAssembly.compile(result.binary), {})).exports;
  } else {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    exports = instance.exports;
  }
  return (exports.main as () => unknown)();
}

/** Run, mapping a throw (JS error or Wasm exception) to the string "throw". */
async function outcome(src: string, lane: Lane, scriptGoal: boolean): Promise<unknown> {
  try {
    return await runMain(src, lane, scriptGoal);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("compile failed")) throw e;
    return "throw";
  }
}

const R1_IMPLICIT_GLOBAL = `
setupEngine = function (x) { return x + 1; };
function f() { return setupEngine(41); }
export function main() { return f(); }
`;

const R2_SLOPPY_THIS = `
function checkResult(d) { this.result = 0; this.result += d; return this.result; }
export function main() { return checkResult(77); }
`;

const R2_STRICT = `"use strict";\n${R2_SLOPPY_THIS}`;

const R3_TOP_LEVEL_THIS = `
var top = this;
var g = 7;
export function main() { return top === undefined ? -1 : (top.g === 7 ? 1 : 0); }
`;

const R3B_TOP_LEVEL_THIS_IS_GLOBAL = `
var top = this;
export function main() { return top === globalThis ? 1 : 0; }
`;

const R4_VAR_GLOBAL_PROPERTY = `
var g = 7;
export function main() { return globalThis.g; }
`;

const R5_EXPORTED_ENTRY = `
export function octane_run(n) { return n + 1; }
export function main() { return octane_run(1); }
`;

const NO_EXPORT_THIS = `
var top = this;
function main() { return top === undefined ? -1 : 1; }
main();
`;

for (const lane of ["gc", "standalone"] as const) {
  describe(`#6937 Script-goal single-file compile (${lane})`, () => {
    it("implicit global assignment creates a global (crypto setupEngine)", async () => {
      expect(await outcome(R1_IMPLICIT_GLOBAL, lane, true)).toBe(42);
    });

    it("sloppy `this` in a plain call is the global object (navier-stokes checkResult)", async () => {
      expect(await outcome(R2_SLOPPY_THIS, lane, true)).toBe(77);
    });

    it("top-level `this` is the global object", async () => {
      expect(await outcome(R3B_TOP_LEVEL_THIS_IS_GLOBAL, lane, true)).toBe(1);
      expect(await outcome(R3B_TOP_LEVEL_THIS_IS_GLOBAL, lane, false)).toBe(0);
    });

    // Known residual on the gc HOST lane, independent of the goal switch: an
    // export-free script fails the same `this.g` read, because the host lane
    // does not publish top-level `var`s onto the host global object
    // (`emitScriptGlobalVarBindings` is standalone/WASI-only). `it.fails`
    // flips red once that is fixed, so the assertion can be promoted.
    (lane === "gc" ? it.fails : it)("top-level `var` is a property of top-level `this`", async () => {
      expect(await outcome(R3_TOP_LEVEL_THIS, lane, true)).toBe(1);
    });

    // Does-not-regress only: `globalThis.g` already reads 7 under the module
    // goal too (pre-fix behaviour), so this case does not discriminate.
    it("top-level `var` is readable as a globalThis property", async () => {
      expect(await outcome(R4_VAR_GLOBAL_PROPERTY, lane, true)).toBe(7);
    });

    it("exported entry points stay Wasm exports and callable by name", async () => {
      expect(await outcome(R5_EXPORTED_ENTRY, lane, true)).toBe(2);
      expect(await outcome(R5_EXPORTED_ENTRY, lane, false)).toBe(2);
    });

    // Negative controls: the default (module goal) behaviour must not change.
    it("default compile keeps module semantics", async () => {
      expect(await outcome(R1_IMPLICIT_GLOBAL, lane, false)).toBe("throw");
      const r2 = await outcome(R2_SLOPPY_THIS, lane, false);
      expect(r2 === "throw" || Number.isNaN(r2)).toBe(true);
      expect(await outcome(R3_TOP_LEVEL_THIS, lane, false)).toBe(-1);
    });

    it("an explicit 'use strict' prologue stays strict under the flag", async () => {
      const r = await outcome(R2_STRICT, lane, true);
      expect(r === "throw" || Number.isNaN(r)).toBe(true);
    });

    it("a source without any export compiles under both settings", async () => {
      for (const flag of [true, false]) {
        const result = await compile(NO_EXPORT_THIS, {
          fileName: "input.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          ...(flag ? { inferModuleStrictArguments: false } : {}),
          ...(lane === "standalone" ? { target: "standalone" as const } : {}),
        });
        expect(result.success).toBe(true);
      }
    });
  });
}
