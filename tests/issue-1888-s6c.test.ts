import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1888 S6-c — Math/Number constant reads must reach their native f64.const
 * emitter under `--target standalone`.
 *
 * Defect: the generic `Builtin.prop` → `__get_builtin` shortcut in
 * property-access.ts fires for ANY builtin-constructor identifier and, under
 * standalone, refuses-loud (the open-object runtime does not expose
 * `__get_builtin`). It sits ABOVE the pure-Wasm `f64.const` handlers for
 * `Math.PI` / `Number.MAX_SAFE_INTEGER` & co., so those handlers were dead code
 * under standalone — `Math.PI` failed to compile even though a native lowering
 * exists. S6-c gates the shortcut to defer to the native constant emitter for
 * Math/Number f64 constants under standalone.
 *
 * Behaviour assertions: correct value + zero host imports + valid module.
 * Symbol well-knowns are intentionally NOT covered here (their i32-const result
 * does not yet compose with every consumer — see hasNativeBuiltinConstantHandler).
 */

const BANNED = [/^env::__get_builtin/, /^env::__extern_/, /^env::__object_/, /^env::__new_plain_object/];
function assertNoHostObjectImports(imports: ReadonlyArray<{ module: string; name: string }>): void {
  const labels = imports.map((i) => `${i.module}::${i.name}`);
  for (const re of BANNED) {
    const hits = labels.filter((l) => re.test(l));
    expect(hits, `--target standalone leaked ${re} (got ${hits.join(", ")})`).toEqual([]);
  }
}
type NumExports = Record<string, () => number>;

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoHostObjectImports(r.imports);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as NumExports).run();
}

describe("#1888 S6-c — Math/Number constants reach native f64.const under standalone", () => {
  it("Math.PI returns 3.141592653589793 (was a __get_builtin refusal)", async () => {
    expect(await runStandalone(`export function run(): number { return Math.PI; }`)).toBe(Math.PI);
  });

  it("Math.E and Math.SQRT2 are native", async () => {
    expect(await runStandalone(`export function run(): number { return Math.E + Math.SQRT2; }`)).toBe(
      Math.E + Math.SQRT2,
    );
  });

  it("Number.MAX_SAFE_INTEGER is native", async () => {
    expect(await runStandalone(`export function run(): number { return Number.MAX_SAFE_INTEGER; }`)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("Number.EPSILON is native", async () => {
    expect(await runStandalone(`export function run(): number { return Number.EPSILON; }`)).toBe(Number.EPSILON);
  });

  it("Math.PI composes in arithmetic (Math.PI * 2)", async () => {
    expect(await runStandalone(`export function run(): number { return Math.PI * 2; }`)).toBe(Math.PI * 2);
  });

  it("typeof Math.PI === 'number' (typeof path unaffected, still works)", async () => {
    expect(await runStandalone(`export function run(): number { return typeof Math.PI === "number" ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("S6 follow-up: genuine Builtin.method value-read (Array.isArray) is now native", async () => {
    const r = await compile(`export function run(): number { const f: any = Array.isArray; return f([1]) ? 1 : 0; }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    assertNoHostObjectImports(r.imports);
    expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as NumExports).run()).toBe(1);
  });

  it("guardrail: unsupported Builtin.method value-read still refuses-loud (S6-b lever)", async () => {
    const r = await compile(`export function run(): number { const f: any = Math.max; return f(1, 2); }`, {
      target: "standalone",
    });
    // #1907 only enables selected static method values; unsupported pairs still
    // refuse cleanly instead of routing through __get_builtin or invalid Wasm.
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/#1907|#1888 S6-b/);
  });
});
