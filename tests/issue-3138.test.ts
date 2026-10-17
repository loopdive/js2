/**
 * #3138 — function-scope fnctor instances register the instance→ctor link at
 * the CALL SITE (host lane), so inherited reads through the ctor's prototype
 * chain resolve — including ToPropertyDescriptor's prototype-inclusive Get
 * (#2680) when the instance is used as a property DESCRIPTOR.
 *
 * The #1712 prologue registration only fires for MODULE-global fnctors (the
 * ctor prologue reads the closure from a module global). Under the test262
 * wrap (`export function test() { … }`), `var Ctor = function(){}` is a
 * function LOCAL, the gate missed, and `_fnctorInstanceCtor` never linked the
 * instance — every inherited descriptor attribute silently dropped
 * (`built-ins/Object/defineProperty/15.2.3.6-3-129.js` family).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    new Uint8Array(result.binary),
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  const ex: any = instance.exports;
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  if (imports.setInstance) imports.setInstance(instance);
  const mi = ex.__module_init;
  if (typeof mi === "function") mi();
  return ex.test();
}

describe("#3138 — function-scope fnctor instance→ctor call-site registration", () => {
  it("inherited DATA descriptor attribute resolves (15.2.3.6-3-129 shape)", async () => {
    const src = `
export function test(): number {
  try {
    var obj = {};
    var proto = { value: "inheritedDataProperty" };
    var ConstructFun = function() {};
    ConstructFun.prototype = proto;
    var child = new ConstructFun();
    Object.defineProperty(obj, "property", child);
    if ((obj as any).property !== "inheritedDataProperty") return 2;
    return 1;
  } catch (e) {
    return 99;
  }
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("inherited method resolves on a function-scope fnctor instance", async () => {
    const src = `
export function test(): number {
  try {
    var proto = { greet: function() { return 7; } };
    var Ctor = function() {};
    Ctor.prototype = proto;
    var inst: any = new Ctor();
    return inst.greet();
  } catch (e) {
    return -1;
  }
}
`;
    await expect(run(src)).resolves.toBe(7);
  });

  it("own attribute still SHADOWS the inherited one (spec Get order)", async () => {
    const src = `
export function test(): number {
  try {
    var obj = {};
    var proto = { value: "inherited" };
    var Ctor = function(this: any) { this.value = "own"; };
    Ctor.prototype = proto;
    var child = new Ctor();
    Object.defineProperty(obj, "property", child);
    if ((obj as any).property !== "own") return 2;
    return 1;
  } catch (e) {
    return 99;
  }
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("module-scope fnctor control keeps working (prologue/global path)", async () => {
    const src = `
var proto = { value: "inheritedDataProperty" };
var ConstructFun = function() {};
ConstructFun.prototype = proto;
export function test(): number {
  var obj = {};
  var child = new ConstructFun();
  Object.defineProperty(obj, "property", child);
  if ((obj as any).property !== "inheritedDataProperty") return 2;
  return 1;
}
`;
    await expect(run(src)).resolves.toBe(1);
  });

  it("standalone lane stays host-import-free for the function-scope shape", async () => {
    const src = `
export function test(): number {
  var proto = { value: 3 };
  var Ctor = function() {};
  Ctor.prototype = proto;
  var child = new Ctor();
  return 1;
}
`;
    const result = await compile(src, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.imports).not.toContain("__register_fnctor_instance");
    }
  });
});
