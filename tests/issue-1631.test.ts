import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.ts";

async function run(body: string): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const ex = (await compileAndInstantiate(src)) as { test?: () => number };
  return ex.test!();
}

// #1631 — Object.create(proto, { key: descObj }) where descObj is a non-literal
// object (built imperatively / a function / inheriting flags) routes through
// the runtime __defineProperty_desc host import. That helper used to hand a
// WasmGC-struct descriptor straight to native Object.defineProperty, which sees
// a null-proto/no-keys object and drops value/get/set/flags. The fix
// materializes a plain descriptor via getField (struct-accessor + __sget_ aware)
// before applying.
describe("#1631 Object.create descriptor map — struct-backed descriptors", () => {
  it("applies a data-property descriptor passed by variable", async () => {
    expect(
      await run(`
        const descObj: any = { value: 9, configurable: true };
        const newObj: any = Object.create({}, { prop: descObj });
        const gd = Object.getOwnPropertyDescriptor(newObj, "prop");
        return (gd && gd.configurable === true && gd.value === 9) ? 1 : 0;`),
    ).toBe(1);
  });

  it("respects configurable:true so delete removes the property", async () => {
    expect(
      await run(`
        const descObj: any = function() {};
        descObj.configurable = true; descObj.value = 1;
        const newObj: any = Object.create({}, { prop: descObj });
        const r1 = newObj.hasOwnProperty("prop");
        delete newObj.prop;
        const r2 = newObj.hasOwnProperty("prop");
        return (r1 === true && r2 === false) ? 1 : 0;`),
    ).toBe(1);
  });

  it("does not regress inline object-literal descriptors", async () => {
    expect(
      await run(`
        const o: any = Object.create({}, { foo: { value: 42, enumerable: true, configurable: true, writable: true } });
        return o.foo === 42 ? 1 : 0;`),
    ).toBe(1);
  });

  it("does not regress the non-literal Properties (__defineProperties) path", async () => {
    expect(
      await run(`
        const descObj: any = { value: 9, configurable: true };
        const props: any = { prop: descObj };
        const newObj: any = Object.create({}, props);
        const gd = Object.getOwnPropertyDescriptor(newObj, "prop");
        return (gd && gd.configurable === true && gd.value === 9) ? 1 : 0;`),
    ).toBe(1);
  });
});
