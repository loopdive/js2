import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/**
 * #4469 — a private method extracted as a value and invoked with a FOREIGN
 * receiver (`this.#m.call(o)`) must not trap at the closure/method ABI
 * boundary.
 *
 * `buildTrampolineThisSlot` deliberately hands the method a `ref.null`
 * receiver when the resolved `this` does not `ref.test` as the method's exact
 * struct (#2025 passthrough). #4507's `coerceTrampolineThisSlot` bridged that
 * nullable slot onto the method's hidden `this` parameter — and because a
 * class instance method's `this` is a NON-null `ref $S`, the bridge emitted
 * `ref.as_non_null`, converting the designed passthrough into an uncatchable
 * `null_deref` trap before the body ever ran.
 *
 * The shape that broke is test262's
 * `language/statements/class/elements/super-access-inside-a-private-method.js`:
 * `#m()` only needs its HomeObject (`super.method()`), never `this`, so the
 * foreign receiver is irrelevant to its result.
 *
 * Both front-ends are pinned: the trap fired on the direct AST path AND the IR
 * path, so this is shared class/closure plumbing, not front-end selection.
 */
async function run(source: string, experimentalIR: boolean): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    experimentalIR,
    fileName: "issue-4469.ts",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return (instance.exports.runCase as () => number)();
}

const SUPER_ACCESS_INSIDE_PRIVATE_METHOD = `
  class A {
    method(): string { return "Test262"; }
  }
  class C extends A {
    #m(): string { return super.method(); }
    access(o: any): string { return (this as any).#m.call(o); }
  }
  export function runCase(): number {
    const c = new C();
    const direct = c.access(c);
    const foreign = c.access({} as any);
    return (direct === "Test262" ? 1 : 0) + (foreign === "Test262" ? 2 : 0);
  }
`;

const PRIVATE_METHOD_GET_AND_CALL = `
  class C {
    #m(): number { return (this as any)._v; }
    getPrivateMethod(): any { return (this as any).#m; }
  }
  export function runCase(): number {
    const c = new C();
    return c.getPrivateMethod().call({ _v: 7 } as any);
  }
`;

describe("#4469 private-method HomeObject dispatch with a foreign receiver", () => {
  for (const experimentalIR of [false, true]) {
    const label = experimentalIR ? "IR" : "direct";

    it(`resolves super.method() from a private method invoked via .call(o) [${label}]`, async () => {
      // 1 = `c.access(c)` (native receiver), 2 = `c.access({})` (foreign
      // receiver — the case that regressed). 3 = both correct.
      expect(await run(SUPER_ACCESS_INSIDE_PRIVATE_METHOD, experimentalIR)).toBe(3);
    });

    it(`does not trap when an extracted private method is .call()ed with a foreign receiver [${label}]`, async () => {
      // This pins the ABSENCE of an uncatchable `null_deref` trap at the
      // trampoline boundary — before the fix the module aborted here instead
      // of running the body. Reading the foreign receiver's own `_v` (spec
      // answer: 7) is a SEPARATE, still-open gap: the #2025 passthrough hands
      // the body a null receiver, so the property read yields NaN. Assert only
      // that a value comes back, so closing that gap does not need a test edit.
      await expect(run(PRIVATE_METHOD_GET_AND_CALL, experimentalIR)).resolves.toEqual(expect.any(Number));
    });
  }
});
