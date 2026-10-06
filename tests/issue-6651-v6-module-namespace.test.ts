// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

/**
 * #6651 V6 — §10.4.6 module namespace exotic object internals, standalone.
 *
 * Each module self-imports its namespace (the shape of test262's
 * `language/module-code/namespace/internals/*`) and scores what it observes,
 * one decimal digit per probe: 1 = completed normally, 2 = ReferenceError,
 * 3 = TypeError, 4 = anything else.
 */
const CODE = `
function code(f) {
  try { f(); return 1; } catch (e) {
    if (e instanceof ReferenceError) return 2;
    if (e instanceof TypeError) return 3;
    return 4;
  }
}
`;

async function run(files: Record<string, string>, entry: string): Promise<unknown> {
  const result = await compileMulti(files, entry, {
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: true,
    emitWat: false,
  } as Parameters<typeof compileMulti>[2]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  const imports: Record<string, Record<string, () => never>> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    (imports[imp.module] ??= {})[imp.name] = () => {
      throw new Error(`unexpected import ${imp.module}::${imp.name}`);
    };
  }
  const instance = new WebAssembly.Instance(module, imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => unknown)();
}

describe("#6651 V6 module namespace exotic object internals (standalone)", () => {
  it("[[Get]]/[[GetOwnProperty]] of an uninitialized binding throw; [[Delete]] of an export refuses", async () => {
    const src = `import * as ns from './mod.js';
${CODE}
var out = 0;
out = out * 10 + code(function () { return ns.local1; });
out = out * 10 + code(function () { return ns.renamed; });
out = out * 10 + code(function () { return ns.default; });
out = out * 10 + code(function () { Object.prototype.hasOwnProperty.call(ns, 'local1'); });
out = out * 10 + code(function () { Object.getOwnPropertyDescriptor(ns, 'local1'); });
out = out * 10 + code(function () { delete ns.local1; });
out = out * 10 + (Reflect.deleteProperty(ns, 'nope') ? 1 : 0);
export function run() { return out; }
export let local1 = 23;
let local2 = 45;
export { local2 as renamed };
export default null;
`;
    // local1, renamed and default are all still in their TDZ; `delete` of an
    // exported name is false, which strict module code turns into a TypeError.
    expect(await run({ "./mod.js": src }, "./mod.js")).toBe(2222231);
  });

  it("[[OwnPropertyKeys]] lists star re-exports, sorted by code unit, then @@toStringTag", async () => {
    const entry = `import * as ns from './mod.js';
export var b;
export * from './star.js';
export default null;
var f = function (s) { return eval(s); }; // keeps the bindings below as externref globals
var names = Object.getOwnPropertyNames(ns);
var keys = Reflect.ownKeys(ns);
var expected = ['a', 'b', 'default', 'run', 'z'];
var ok = names.length === expected.length ? 1 : 0;
for (var i = 0; i < expected.length; i++) if (names[i] !== expected[i]) ok = 0;
var out = ok * 10 + (keys.indexOf(Symbol.toStringTag) === expected.length ? 1 : 0);
export function run() { return out; }
`;
    const star = `export var z; export { z as a };`;
    expect(await run({ "./mod.js": entry, "./star.js": star }, "./mod.js")).toBe(11);
  });

  it("super.x = v with a namespace receiver reads the binding (TDZ) and a parent setter still wins", async () => {
    const src = `import * as ns from './mod.js';
${CODE}
var seen;
class A { constructor() { return ns; } }
class B extends A { constructor() { super(); super.foo = 14; } }
class C { constructor() { return ns; } set foo(v) { seen = v; } }
class D extends C { constructor() { super(); super.foo = 15; } }
var out = code(function () { new B(); });
out = out * 10 + code(function () { new D(); });
out = out * 100 + seen;
export function run() { return out; }
export let foo = 42;
`;
    expect(await run({ "./mod.js": src }, "./mod.js")).toBe(2115);
  });
});
