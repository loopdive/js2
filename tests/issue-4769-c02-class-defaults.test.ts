/**
 * #4769 C02 — class-valued binding-element defaults in zero-suspend native
 * generator methods.
 *
 * The selected six-row slice is the class-declaration and object-literal
 * method family. The methods have no yield in their body, so the native
 * state-machine executes the call-time parameter destructuring and then
 * completes in its initial state. Class-expression methods are deliberately
 * not included: the same experiment still null-dereferences their class
 * default value, and remains pinned by #3952.
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

describe("#4769 C02 — selected six-row class/object method family", () => {
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

  it("keeps class-expression methods on the conservative host path", async () => {
    const result = await compile(
      [
        "const C = class { *m({ K = class {} } = {}) { return 1; } };",
        "export function test(): number { return C.prototype.m().next().value as number; }",
      ].join("\n"),
      { fileName: "issue-4769-class-expression.ts", target: "standalone" },
    );
    expect(result.success).toBe(true);
    expect((result.imports ?? []).map((i) => i.name)).toContain("__create_generator");
  });
});
