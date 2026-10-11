// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 B18) `.name` must not be folded from the `PropertyDescriptor` slot a
 * function was read out of.
 *
 * `property-access-dispatch.ts`'s §20.2.4.2 `.name` peephole resolves the name
 * from the receiver's TYPE SYMBOL. For a value read out of a §6.2.6 property
 * descriptor that symbol is `PropertyDescriptor.get` / `.set` — a DECLARATION
 * slot in `lib.es5.d.ts`, not the installed function — so the fold published
 * `"get"` as the accessor's name.
 *
 * It hid because the lib types the slots optional (`get?(): any`), so the plain
 * spelling `desc.get.name` keeps the union `(() => any) | undefined` and the
 * fold's own union exclusion already declined it. Only where control flow
 * narrowed `undefined` away did the fold fire — i.e. exactly the guarded
 * spellings real code uses:
 *
 *     var getter = Object.getOwnPropertyDescriptor(Array, Symbol.species).get;
 *     return getter && getter.name;      // ← answered "get"
 *
 * which is verbatim `test/built-ins/Symbol/species/builtin-getter-name.js`. The
 * defect was identical on the JS-host and standalone targets, so the fix is
 * unconditional; both lanes already answer correctly once the fold declines
 * (`$fnmeta` host-free, `__extern_get(v, "name")` on host).
 *
 * The negative controls pin the two ways this could over-reach: `"get"` IS the
 * right answer when the accessor is an anonymous function expression under an
 * object-literal `get` key (§13.2.5.5 NamedEvaluation), and a named function
 * read out of an ordinary property must keep folding to its own name.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile a standalone SCRIPT, run `__module_init`, read the `result` bitmask. */
async function run(body: string): Promise<{ imports: string[]; result: number }> {
  const source = `var result = -1;\n${body}\nexport function test(): number { return result as number; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-b18-descriptor-accessor-name.ts",
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
  return { imports, result: (instance.exports as Record<string, () => number>).test() };
}

const SPECIES_NAME = "get [Symbol.species]";

describe("#6651 B18 — a descriptor accessor's .name is not the descriptor slot's name", () => {
  it("answers the real getter name through the `getter && getter.name` guard (the test262 row's spelling)", async () => {
    const o = await run(
      `function getGetterName(obj) {\n` +
        `  var getter = Object.getOwnPropertyDescriptor(obj, Symbol.species).get;\n` +
        `  return getter && getter.name;\n` +
        `}\n` +
        `var m = 0;\n` +
        `if (getGetterName(Array) === "${SPECIES_NAME}") m += 1;\n` +
        `if (getGetterName(Map) === "${SPECIES_NAME}") m += 2;\n` +
        `if (getGetterName(Promise) === "${SPECIES_NAME}") m += 4;\n` +
        `if (getGetterName(RegExp) === "${SPECIES_NAME}") m += 8;\n` +
        `if (getGetterName(Set) === "${SPECIES_NAME}") m += 16;\n` +
        `result = m;`,
    );
    expect(o.result).toBe(31);
  });

  it("answers the real getter name through a ternary guard and a static receiver", async () => {
    // The recorded diagnosis blamed the RECEIVER (static vs function parameter).
    // It is not the receiver: a STATIC receiver under the same guard was wrong
    // too, and a PARAMETER receiver without a guard was already right. The
    // discriminator is only whether control flow narrowed the slot's
    // `undefined` away at the `.name` read.
    const o = await run(
      `var m = 0;\n` +
        `var g1 = Object.getOwnPropertyDescriptor(Array, Symbol.species).get;\n` +
        `if ((g1 ? g1.name : "x") === "${SPECIES_NAME}") m += 1;\n` +
        `var g2 = Object.getOwnPropertyDescriptor(Array, Symbol.species).get;\n` +
        `if ((g2 && g2.name) === "${SPECIES_NAME}") m += 2;\n` +
        `result = m;`,
    );
    expect(o.result).toBe(3);
  });

  it("leaves the already-correct unguarded and joined spellings unchanged", async () => {
    // These never reached the fold (the lib's optional slot keeps them a union),
    // so they are the before/after control on the untouched path.
    const o = await run(
      `var m = 0;\n` +
        `var d = Object.getOwnPropertyDescriptor(Array, Symbol.species);\n` +
        `if (d.get.name === "${SPECIES_NAME}") m += 1;\n` +
        `var g = d.get;\n` +
        `if ((g && g).name === "${SPECIES_NAME}") m += 2;\n` +
        `if (g["name"] === "${SPECIES_NAME}") m += 4;\n` +
        `if (g.length === 0) m += 8;\n` +
        `result = m;`,
    );
    expect(o.result).toBe(15);
  });

  it('negative control — an anonymous accessor under an object-literal `get` key IS named "get"', async () => {
    // §13.2.5.5 PropertyDefinitionEvaluation + NamedEvaluation: the anonymous
    // function expression takes the property key as its name. Declining the
    // descriptor-slot fold must not turn this right answer into a wrong one.
    const o = await run(
      `var host = {};\n` +
        `Object.defineProperty(host, "x", { get: function () { return 1; }, configurable: true });\n` +
        `var g = Object.getOwnPropertyDescriptor(host, "x").get;\n` +
        `result = (g && g.name) === "get" ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
  });

  it("negative control — a NAMED accessor keeps its own name, not the slot's", async () => {
    const o = await run(
      `var host = {};\n` +
        `Object.defineProperty(host, "x", { get: function realGet() { return 1; }, configurable: true });\n` +
        `var m = 0;\n` +
        `var g = Object.getOwnPropertyDescriptor(host, "x").get;\n` +
        `if ((g && g.name) === "realGet") m += 1;\n` +
        `var host2 = {};\n` +
        `Object.defineProperty(host2, "y", { set: function realSet(v) {}, configurable: true });\n` +
        `var s = Object.getOwnPropertyDescriptor(host2, "y").set;\n` +
        `if ((s && s.name) === "realSet") m += 2;\n` +
        `result = m;`,
    );
    expect(o.result).toBe(3);
  });

  it("negative control — a named function read out of an ORDINARY property still folds to its own name", async () => {
    // The guard is keyed on the `PropertyDescriptor` interface's `get`/`set`
    // members by declaration, not on the property key text, so an ordinary
    // object whose key happens to be `get` is untouched.
    const o = await run(
      `function foo() {}\n` +
        `var bag = { get: foo, other: foo };\n` +
        `var m = 0;\n` +
        `var a = bag.get;\n` +
        `if ((a && a.name) === "foo") m += 1;\n` +
        `var b = bag.other;\n` +
        `if ((b && b.name) === "foo") m += 2;\n` +
        `result = m;`,
    );
    expect(o.result).toBe(3);
  });

  it("the fixed reads stay host-free on the standalone target", async () => {
    const o = await run(
      `function getGetterName(obj) {\n` +
        `  var getter = Object.getOwnPropertyDescriptor(obj, Symbol.species).get;\n` +
        `  return getter && getter.name;\n` +
        `}\n` +
        `result = getGetterName(Array) === "${SPECIES_NAME}" ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });
});
