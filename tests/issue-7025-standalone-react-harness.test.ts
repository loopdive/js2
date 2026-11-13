// #7025 — React's upstream unit suite scored 0/180 in the standalone lane.
// Three standalone-only compiler defects, each reproduced here in isolation:
//
// 1. `document.implementation.createHTMLDocument("")` (React's test shim) kept
//    an `env.DOMImplementation_createHTMLDocument` extern-class import, so the
//    zero-import check refused every batch. `document` already throws
//    ReferenceError (#6841); `DOMImplementation` is now unprovided like the
//    other lib.dom document interfaces.
// 2. React's own `function escape(key)` (child-key escaping) was lowered to the
//    Annex B `escape` builtin, dropping the `$` key prefix (`.$simple`).
// 3. A call through a union of signatures (`[syncTest, asyncTest][i]()`) dropped
//    the live arm's `f64` / native-string result to null, so every synchronous
//    test in a batch that also held an async one read back as a failure.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function build(source: string, target: "standalone" | "gc", fileName = "issue-7025.ts") {
  const result = await compile(source, {
    fileName,
    target,
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { runtimeEvalProvider: false } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return { module, imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`) };
}

async function runStandalone(source: string, fileName?: string) {
  const { module, imports } = await build(source, "standalone", fileName);
  expect(imports).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => number>;
}

const DOM_SOURCE = `
function containerFromMarkup(markup: string): any {
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = markup;
  return doc.body;
}
function classify(e: any): number { return e instanceof ReferenceError ? 1 : e instanceof TypeError ? 2 : 3; }
export function reached(): number { try { containerFromMarkup("<p></p>"); return 0; } catch (e) { return classify(e); } }
export function pure(n: number): number { return n + 1; }
// A DOMImplementation-typed value from an ordinary object takes the dynamic path.
function viaType(impl: DOMImplementation): any { return impl.createHTMLDocument("t"); }
export function typed(): number { return viaType({ createHTMLDocument: (t: string) => ({ n: t.length + 40 }) } as any).n; }
`;

describe("#7025 — React upstream harness defects under --target standalone", { timeout: 180_000 }, () => {
  it("document.implementation imports nothing; the DOM path throws ReferenceError", async () => {
    const exports = await runStandalone(DOM_SOURCE);
    expect(exports.pure(41)).toBe(42);
    expect(exports.reached()).toBe(1);
    expect(exports.typed()).toBe(41);
  });

  it("control: the JS-host lane keeps its DOMImplementation extern-class import", async () => {
    const { imports } = await build(DOM_SOURCE, "gc");
    expect(imports.some((name) => name.includes("DOMImplementation_createHTMLDocument"))).toBe(true);
  });

  it("a user function named escape/unescape is called, not the Annex B builtin", async () => {
    // React's react.production.js, verbatim shape.
    const exports = await runStandalone(
      `
function escape(key) {
  var escaperLookup = { "=": "=0", ":": "=2" };
  return "$" + key.replace(/[=:]/g, function (match) { return escaperLookup[match]; });
}
function unescape(s) { return "u" + s; }
/** @returns {number} */
export function userEscape() { var s = "." + escape("a=b"); return s === ".$a=0b" ? 1 : s.length; }
/** @returns {number} */
export function userUnescape() { return unescape("x") === "ux" ? 1 : 0; }
`,
      "issue-7025-escape.js",
    );
    expect(exports.userEscape()).toBe(1);
    expect(exports.userUnescape()).toBe(1);
  });

  it("anti-vacuity: the ambient Annex B escape still runs where no user binding exists", async () => {
    const exports = await runStandalone(
      `/** @returns {number} */ export function ambient() { return escape("a b") === "a%20b" ? 1 : 0; }`,
      "issue-7025-ambient.js",
    );
    expect(exports.ambient()).toBe(1);
  });

  it("a call through a union of signatures keeps the live arm's result", async () => {
    const exports = await runStandalone(
      `
function syncTest() { try { return 1; } catch (e) { return 0; } }
async function asyncTest() { await null; return 1; }
function name() { return "x"; }
const tests = [syncTest, asyncTest];
const mixed = [syncTest, name];
/** @returns {number} */
export function viaElement() { var r = tests[0](); return r === 1 ? 1 : 0; }
/** @returns {number} */
export function viaIdentifier() { var f = tests[0]; var r = f(); return r === 1 ? 1 : 0; }
/** @returns {number} */
export function numberOrString() { return (mixed[0]() === 1 ? 1 : 0) + (mixed[1]() === "x" ? 10 : 0); }
/** @returns {number} */
export function control() { return syncTest() === 1 ? 1 : 0; }
`,
      "issue-7025-dispatch.js",
    );
    expect(exports.control()).toBe(1);
    expect(exports.viaElement()).toBe(1);
    expect(exports.viaIdentifier()).toBe(1);
    expect(exports.numberOrString()).toBe(11);
  });
});
