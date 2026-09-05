/**
 * #4769 C02 — class-valued binding-element defaults in zero-suspend native
 * generator methods.
 *
 * The selected class/object method slices have no yield in their body, so the
 * native state-machine executes the call-time parameter destructuring and then
 * completes in its initial state. Class-expression methods need one extra
 * representation rule: their class-valued defaults spill as externrefs because
 * TypeScript can otherwise alias an anonymous default class to the enclosing
 * class's GC type.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const source = `
class C {
  *instanceDefault({
    cls = class {},
    xCls = class X {},
    xCls2 = class { static name() {} }
  } = {}) {
    return (cls.name === "cls" ? 1 : 0) +
      (xCls.name === "xCls" ? 0 : 2) +
      (xCls2.name === "xCls2" ? 0 : 4);
  }
  *instanceNoDefault({
    cls = class {},
    xCls = class X {},
    xCls2 = class { static name() {} }
  }) {
    return (cls.name === "cls" ? 1 : 0) +
      (xCls.name === "xCls" ? 0 : 2) +
      (xCls2.name === "xCls2" ? 0 : 4);
  }
  static *staticDefault({
    cls = class {},
    xCls = class X {},
    xCls2 = class { static name() {} }
  } = {}) {
    return (cls.name === "cls" ? 1 : 0) +
      (xCls.name === "xCls" ? 0 : 2) +
      (xCls2.name === "xCls2" ? 0 : 4);
  }
  static *staticNoDefault({
    cls = class {},
    xCls = class X {},
    xCls2 = class { static name() {} }
  }) {
    return (cls.name === "cls" ? 1 : 0) +
      (xCls.name === "xCls" ? 0 : 2) +
      (xCls2.name === "xCls2" ? 0 : 4);
  }
}

const o = {
  *objectDefault({
    cls = class {},
    xCls = class X {},
    xCls2 = class { static name() {} }
  } = {}) {
    return (cls.name === "cls" ? 1 : 0) +
      (xCls.name === "xCls" ? 0 : 2) +
      (xCls2.name === "xCls2" ? 0 : 4);
  },
  *objectNoDefault({
    cls = class {},
    xCls = class X {},
    xCls2 = class { static name() {} }
  }) {
    return (cls.name === "cls" ? 1 : 0) +
      (xCls.name === "xCls" ? 0 : 2) +
      (xCls2.name === "xCls2" ? 0 : 4);
  },
};

export function test(): number {
  return (new C().instanceDefault().next().value as number) +
    (new C().instanceNoDefault({}).next().value as number) +
    (C.staticDefault().next().value as number) +
    (C.staticNoDefault({}).next().value as number) +
    (o.objectDefault().next().value as number) +
    (o.objectNoDefault({}).next().value as number);
}
`;

describe("#4769 C02 — selected class/object method families", () => {
  it("keeps class defaults native and preserves NamedEvaluation", async () => {
    const result = await compile(source, { fileName: "issue-4769.ts", target: "standalone" });
    expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(
      WebAssembly.Module.imports(await WebAssembly.compile(result.binary)).map((i) => i.module + "::" + i.name),
    ).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("admits zero-suspend class-expression methods with class defaults", async () => {
    const result = await compile(
      [
        "const C = class {",
        "  *instanceDefault({ cls = class {}, xCls = class X {}, xCls2 = class { static name() {} } } = {}) {",
        "    return (cls.name === 'cls' ? 1 : 0) + (xCls.name === 'xCls' ? 0 : 2) + (xCls2.name === 'xCls2' ? 0 : 4);",
        "  }",
        "  *instanceNoDefault({ cls = class {}, xCls = class X {}, xCls2 = class { static name() {} } }) {",
        "    return (cls.name === 'cls' ? 1 : 0) + (xCls.name === 'xCls' ? 0 : 2) + (xCls2.name === 'xCls2' ? 0 : 4);",
        "  }",
        "  static *staticDefault({ cls = class {}, xCls = class X {}, xCls2 = class { static name() {} } } = {}) {",
        "    return (cls.name === 'cls' ? 1 : 0) + (xCls.name === 'xCls' ? 0 : 2) + (xCls2.name === 'xCls2' ? 0 : 4);",
        "  }",
        "  static *staticNoDefault({ cls = class {}, xCls = class X {}, xCls2 = class { static name() {} } }) {",
        "    return (cls.name === 'cls' ? 1 : 0) + (xCls.name === 'xCls' ? 0 : 2) + (xCls2.name === 'xCls2' ? 0 : 4);",
        "  }",
        "};",
        "export function test(): number {",
        "  return (new C().instanceDefault().next().value as number) +",
        "    (new C().instanceNoDefault({}).next().value as number) +",
        "    (C.staticDefault().next().value as number) +",
        "    (C.staticNoDefault({}).next().value as number);",
        "}",
      ].join("\n"),
      { fileName: "issue-4769-class-expression-defaults.ts", target: "standalone" },
    );
    expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.imports ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(28);
  });

  it("keeps yielding class-expression methods on the conservative host path", async () => {
    const result = await compile(
      [
        "const C = class { *m({ K = class { v(): number { return 41; } } } = {}) { yield 0; yield new K().v() + 1; } };",
        "export function test(): number { const it = C.prototype.m(); it.next(); return it.next().value as number; }",
      ].join("\n"),
      { fileName: "issue-4769-class-expression-yield.ts", target: "standalone" },
    );
    expect(result.success).toBe(true);
    expect((result.imports ?? []).map((i) => i.name)).toContain("__create_generator");
  });
});
