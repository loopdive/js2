// #6987 — Octane `typescript` on --target standalone.
//
// (1) The bundled TypeScript compiler's Node.js IO adapter reads
//     `process.stdout` / `process.stderr` / `process.argv` in code that only
//     runs when `typeof require === "function"`. Each read lowered to a
//     JS-host getter import (`env.__get_process_*`), so the module could not be
//     instantiated host-free even though the code is never reached there. A
//     host-free module has no `process`: reads are unresolvable-global
//     references (ReferenceError) and `typeof process` is "undefined".
//
// (2) TypeScript's namespace emit `(function (TypeScript) {…})(TypeScript ||
//     (TypeScript = {}))` is inlined into `__module_init`, leaving a local named
//     `TypeScript` behind once the IIFE's binding scope closes. A LATER closure
//     reading the module-scope `var TypeScript` missed `localMap` and the #1177
//     by-name slot rescan resurrected that dead parameter slot: the closure
//     captured (and boxed) the IIFE's parameter instead of the global. Writes to
//     the global then went to the box, and with module-init chunking the
//     recorded capture slot pointed into a different chunk's frame ("stack-balance
//     invariant (entry): '__module_init_chunk_1' references local N").
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "issue-6987.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  return { module, imports };
}

const NODE_IO = `
function getNodeIO() {
  return {
    printLine: function (s) { process.stdout.write(s + "\\n"); },
    printError: function (s) { process.stderr.write(s); },
    args: process.argv.slice(2),
    platform: process.platform,
    arch: process.arch,
    quit: process.exit,
  };
}
var IO = typeof require === "function" ? getNodeIO() : null;
function classify(f) {
  try { f(); return 0; } catch (e) { return e instanceof ReferenceError ? 1 : 2; }
}
/** @returns {number} */
export function probe() {
  return (IO === null ? 1 : 0) +
    (typeof process === "undefined" ? 10 : 0) +
    classify(function () { return process.stdout; }) * 100 +
    classify(function () { return process.argv; }) * 1000 +
    classify(function () { return process.platform; }) * 10000;
}
`;

const NAMESPACE_THEN_CLASS_IIFES = (padding: number) => `
var TypeScript;
(function (TypeScript) {
  var NullLogger = (function () {
    function NullLogger() { }
    NullLogger.prototype.log = function (s) { };
    return NullLogger;
  })();
  TypeScript.NullLogger = NullLogger;
})(TypeScript || (TypeScript = {}));
var pad = [];
${Array.from({ length: padding }, (_, i) => `pad.push(${i});`).join("\n")}
var CommandLineHost = (function () {
  function CommandLineHost(settings) { this.settings = settings; }
  CommandLineHost.prototype.make = function () { return new TypeScript.NullLogger(); };
  return CommandLineHost;
})();
var BatchCompiler = (function () {
  function BatchCompiler(ioHost) {
    this.ioHost = ioHost;
    this.logger = new TypeScript.NullLogger();
    this.compilerVersion = "0.8.2.0";
  }
  return BatchCompiler;
})();
var original = TypeScript;
TypeScript = { NullLogger: TypeScript.NullLogger, replaced: 1 };
/** @returns {number} */
export function probe() {
  var b = new BatchCompiler(null);
  var h = new CommandLineHost(1);
  return (b.compilerVersion === "0.8.2.0" ? 1 : 0) +
    (h.make() instanceof TypeScript.NullLogger ? 10 : 0) +
    (TypeScript.replaced === 1 ? 100 : 0) +
    (original !== TypeScript ? 1000 : 0);
}
`;

// (3) A CAPTURING constructor declared in a class IIFE nested in a namespace
//     IIFE (`this.k = K` reads the namespace's `var K`) is memoized in a frame
//     local, so it had no `__closure_proto_of` identity key. The static
//     `Table.prototype.add = …` wrote the per-fnctor prototype global while
//     `new NS.Table()` from another function linked the instance to the
//     closure's own `prototype` bag entry — `t.add()` threw "called value is
//     not a function" (the TypeScript compiler's `StringHashTable`).
const NAMESPACE_CLASS_WITH_CAPTURE = `
var NS;
(function (NS) {
  var K = 3;
  var Table = (function () {
    function Table() { this.k = K; }
    Table.prototype.add = function () { return 1; };
    return Table;
  })();
  NS.Table = Table;
})(NS || (NS = {}));
/** @returns {number} */
export function probe() {
  var t = new NS.Table();
  return (typeof t.add === "function" ? 1 : 0) +
    (Object.getPrototypeOf(t) === NS.Table.prototype ? 10 : 0) +
    (t.k === 3 ? 100 : 0) +
    (t instanceof NS.Table ? 1000 : 0) +
    (t.add() === 1 ? 10000 : 0);
}
`;

describe("#6987 — octane typescript standalone", () => {
  it("process.* reads in host-detection code need no host import", async () => {
    const { module, imports } = await compileStandalone(NODE_IO);
    expect(imports).toEqual([]);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports.probe as () => number)()).toBe(11111);
  });

  it("a closure after an inlined namespace IIFE reads the module global, not the dead parameter slot", async () => {
    const { module, imports } = await compileStandalone(NAMESPACE_THEN_CLASS_IIFES(0));
    expect(imports).toEqual([]);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports.probe as () => number)()).toBe(1111);
  });

  it("a capturing constructor inside a namespace IIFE keeps its prototype methods for `new NS.C()`", async () => {
    const { module, imports } = await compileStandalone(NAMESPACE_CLASS_WITH_CAPTURE);
    expect(imports).toEqual([]);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports.probe as () => number)()).toBe(11111);
  });

  it("the same shape split across module-init chunks compiles and runs", async () => {
    // 16 padding statements push the class IIFEs into a later init chunk than
    // the namespace IIFE whose parameter slot used to be captured.
    const { module, imports } = await compileStandalone(NAMESPACE_THEN_CLASS_IIFES(16));
    expect(imports).toEqual([]);
    const { exports } = await WebAssembly.instantiate(module, {});
    expect((exports.probe as () => number)()).toBe(1111);
  });
});
