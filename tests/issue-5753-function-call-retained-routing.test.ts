// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { BUILTIN_BRAND_TABLE } from "../src/codegen/builtin-brands.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = process.env.FUNCTION_CALL_CONTROL_ROOT;
const { compile, compileMulti } = await import(
  root ? pathToFileURL(resolve(root, "src/index.ts")).href : "../src/index.js"
);

const bodyName = `__proto_method_${BUILTIN_BRAND_TABLE.Function}_call`;

function inspectCallBody(wat: string, helpers: string[]): string {
  const functions = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)];
  const imports = [...wat.matchAll(/^ {2}\(import .*\(func\b/gm)].length;
  const entry = functions.find((match) => match[1] === bodyName);
  expect(entry, "missing actual call-glue definition").toBeDefined();
  const end = wat.indexOf("\n  )", entry!.index);
  expect(end).toBeGreaterThan(entry!.index!);
  const body = wat.slice(entry!.index, end);
  for (const helper of helpers) {
    const ordinal = functions.findIndex((match) => match[1] === helper);
    expect(ordinal, `missing helper definition ${helper}`).toBeGreaterThanOrEqual(0);
    expect(body, `call glue must invoke ${helper}`).toMatch(new RegExp(`\\bcall ${imports + ordinal}(?:\\s|$)`));
  }
  return body;
}

const source = `
const callValue: any = Function.prototype.call;
const receiver: any = { base: 10 };
function add(this: any, a: number, b: number): number { return this.base + a + b; }
const empty: any = function(this: any): boolean { "use strict"; return this === undefined; };
export function run(): number {
  if (callValue.call(add, receiver, 1, 2) !== 13) return -1;
  if (!callValue.call(empty)) return -2;
  let caught = false;
  try { callValue.call(7); } catch (e) { caught = e instanceof TypeError; }
  return caught ? 1 : -3;
}`;

it("executes the retained standalone Function.call body", async () => {
  const result = await compile(source, {
    target: "standalone",
    optimize: 0,
    emitWat: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  const wat = inspectCallBody(result.wat ?? "", ["__extern_get_idx", "__apply_closure"]);
  // Retained signed loop, but semantic reads also handle reused user arrays.
  expect(wat).toContain("i32.ge_s");
  expect(wat).not.toContain("array.get");
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});

it("emits the generic linked-consumer body with its provider guard", async () => {
  const namespace = "js2wasm:npm:call-routing-proof";
  const result = await compileMulti(
    {
      "/stub.ts": "export declare function factory(): any;",
      "/main.ts": 'import { factory } from "/stub"; const peer = factory();\n' + source,
    },
    "/main.ts",
    {
      target: "standalone",
      optimize: 0,
      canonicalRuntimeTypes: true,
      link: [namespace],
      linkedPackageBindings: new Map([["factory", { module: namespace, field: "factory" }]]),
      emitWat: true,
    },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const fullWat = result.wat ?? "";
  const wat = inspectCallBody(fullWat, ["__typeof_function", "__extern_length", "__extern_get_idx", "__apply_closure"]);
  expect(wat).toContain("f64.ge");
  expect(wat).toContain("f64.add");
  const imports = [...fullWat.matchAll(/^ {2}\(import .*\(func\b.*$/gm)];
  const peer = imports.findIndex((match) => match[0].includes(`"${namespace}" "__js2wasm_link_callable_kind"`));
  expect(peer, "missing linked callable-kind import").toBeGreaterThanOrEqual(0);
  expect(wat).toMatch(new RegExp(`\\bcall ${peer}\\s+i32.const 1\\s+i32.and\\s+i32.or\\s+i32.eqz`));
  // Emission proof only; the unchanged issue-6643 suite supplies linked runtime proof.
});
