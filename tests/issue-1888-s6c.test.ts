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
  // Lock EVERY gated name: each must read-as-value to its exact constant under
  // standalone (the tech-lead guardrail — a name gated OUT of __get_builtin whose
  // downstream emitter doesn't actually fire would turn refuse-loud into invalid
  // Wasm). Keep these lists identical to MATH_CONSTANT_PROPS / NUMBER_CONSTANT_PROPS
  // in property-access.ts.
  const MATH_NAMES = ["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"] as const;
  const NUMBER_NAMES = [
    "EPSILON",
    "MAX_SAFE_INTEGER",
    "MIN_SAFE_INTEGER",
    "MAX_VALUE",
    "MIN_VALUE",
    "POSITIVE_INFINITY",
    "NEGATIVE_INFINITY",
    "NaN",
  ] as const;

  it.each(MATH_NAMES)("Math.%s reads its native f64 constant under standalone", async (name) => {
    const v = await runStandalone(`export function run(): number { return Math.${name}; }`);
    expect(v).toBe((Math as unknown as Record<string, number>)[name]);
  });

  it.each(NUMBER_NAMES)("Number.%s reads its native f64 constant under standalone", async (name) => {
    const v = await runStandalone(`export function run(): number { return Number.${name}; }`);
    expect(v).toBe((Number as unknown as Record<string, number>)[name]);
  });

  it("Math.PI composes in arithmetic (Math.PI * 2)", async () => {
    expect(await runStandalone(`export function run(): number { return Math.PI * 2; }`)).toBe(Math.PI * 2);
  });

  it("typeof Math.PI === 'number' (typeof path unaffected, still works)", async () => {
    expect(await runStandalone(`export function run(): number { return typeof Math.PI === "number" ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("guardrail: genuine Builtin.method value-read (Array.isArray) still refuses-loud (S6-b lever, not S6-c)", async () => {
    const r = await compile(`export function run(): number { const f: any = Array.isArray; return f([1]) ? 1 : 0; }`, {
      target: "standalone",
    });
    // S6-c must NOT accidentally widen to non-constant builtin reads; those stay
    // refused until S6-b lands. (A clean compile error, not invalid Wasm.)
    expect(r.success).toBe(false);
  });
});
