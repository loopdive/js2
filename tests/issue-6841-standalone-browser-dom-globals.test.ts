// #6841 — styled-components' sheet bootstrap leaked 12 `env::` lib.dom
// extern-class imports into a standalone binary: `document.head`
// (env.Document_get_head), `document.createElement` / `createTextNode` /
// `styleSheets`, `el.setAttribute` (env.Element_setAttribute),
// `appendChild` / `insertBefore` / `removeChild` / `childNodes` /
// `getRootNode` (env.Node_*), `style.sheet` (env.HTMLStyleElement_get_sheet)
// and `navigator.product` (env.Navigator_get_product). A host-free module has
// no document: `typeof document` already folded to "undefined", but a read
// produced `null` and every member reached through the lib.dom type became a
// host import. The honest lowering is an engine without the globals (#6664 /
// #6691 precedent): a read throws ReferenceError, and the members take the
// ordinary dynamic-property path behind it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

async function compileProjectFiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6841-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  return { module, imports };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

// 0 = no throw, 1 = ReferenceError, 2 = TypeError, 3 = anything else
const CLASSIFY = `function classify(e) { return e instanceof ReferenceError ? 1 : e instanceof TypeError ? 2 : 3; }
function attempt(f) { try { f(); return 0; } catch (e) { return classify(e); } }`;

// The shapes styled-components.esm.js uses, trimmed to the lowering-relevant part.
const STYLED_SHAPED = `
const be = (e) => (typeof ShadowRoot !== "undefined" && e instanceof ShadowRoot) || ("host" in e && 11 === e.nodeType);
const we = (e) => {
  if (!e) return document;
  if (be(e)) return e;
  if ("getRootNode" in e) { const t = e.getRootNode(); if (be(t)) return t; }
  return document;
};
const Ie = (e, t) => {
  const n = document.head, o = e || n, s = document.createElement("style");
  s.setAttribute("data-styled", "active");
  o.insertBefore(s, null);
  return s;
};
export class CSSOMTag {
  constructor(e, t) {
    this.element = Ie(e, t);
    this.element.appendChild(document.createTextNode(""));
    this.sheet = ((e) => {
      if (e.sheet) return e.sheet;
      const n = e.getRootNode().styleSheets ?? document.styleSheets;
      for (let i = 0, l = n.length; i < l; i++) { const s = n[i]; if (s.ownerNode === e) return s; }
      throw new Error("no sheet");
    })(this.element);
    this.length = 0;
  }
}
export class TextTag {
  constructor(e, t) { this.element = Ie(e, t); this.nodes = this.element.childNodes; this.length = 0; }
  insertRule(e, t) { const n = document.createTextNode(t); this.element.insertBefore(n, this.nodes[e] || null); this.length++; return true; }
  deleteRule(e) { this.element.removeChild(this.nodes[e]); this.length--; }
}
export function isReactNative() { return "undefined" != typeof navigator && "ReactNative" === navigator.product; }
export function rootOf(e) { return we(e); }
export function css(strings) { return strings.join(""); }
`;

describe("#6841 — browser DOM globals stay host-free under --target standalone", () => {
  it("a styled-components-shaped module imports nothing; its pure op runs", async () => {
    const { module, imports } = await compileProjectFiles({
      "sheet.js": STYLED_SHAPED,
      "main.js": `
import { css, isReactNative } from "./sheet.js";
const ns = { css }; // the npm-compat driver's shape
export function test(n) { return (typeof ns.css === "function" ? 1 : 0) + css(["a", "bc"]).length + (isReactNative() ? 100 : 0) + n; }
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test(10)).toBe(14);
  });

  it("typeof folds to undefined and every reached reference throws ReferenceError", async () => {
    const { module, imports } = await compileProjectFiles({
      "sheet.js": STYLED_SHAPED,
      "main.js": `
import { CSSOMTag, TextTag, rootOf } from "./sheet.js";
${CLASSIFY}
export function typeofs() {
  return (typeof document === "undefined" ? 1 : 0) + (typeof navigator === "undefined" ? 10 : 0) +
    (typeof window === "undefined" ? 100 : 0) + (typeof location === "undefined" ? 1000 : 0) +
    (typeof history === "undefined" ? 10000 : 0);
}
export function reads() {
  return attempt(() => document) + attempt(() => navigator) * 10 + attempt(() => window) * 100 +
    attempt(() => location) * 1000 + attempt(() => history) * 10000;
}
export function members() {
  return attempt(() => new CSSOMTag()) + attempt(() => new TextTag()) * 10 + attempt(() => rootOf(null)) * 100 +
    attempt(() => document.head) * 1000 + attempt(() => navigator.product) * 10000;
}
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    expect(exports.typeofs()).toBe(11111);
    expect(exports.reads()).toBe(11111);
    expect(exports.members()).toBe(11111);
  });

  it("members typed through lib.dom classes take the dynamic path on user objects", async () => {
    // The lib.dom classes are no longer extern classes in a host-free module,
    // so a member typed `HTMLStyleElement` / `Document` must still RESOLVE on
    // an ordinary object — the lowering is dynamic property access, not a
    // blanket throw. (`typeof document` pulls the lib.dom classes in.)
    const result = await compile(
      `
function probe(el: HTMLStyleElement, doc: Document): number {
  el.setAttribute("k", "v");
  return (el.sheet as any).length + (doc.head as any).n + el.childNodes.length;
}
export function kind(): string { return typeof document; }
export function test(): number {
  const el: any = { sheet: { length: 1 }, childNodes: [1, 2], attrs: 0,
    setAttribute(k: string, v: string) { this.attrs = k.length + v.length; } };
  return probe(el, { head: { n: 100 } } as any) + el.attrs * 1000;
}
`,
      { fileName: "issue-6841-typed.ts", target: "standalone" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    expect((await run(module)).test()).toBe(1 + 100 + 2 + 2000);
  });

  it("window functions (getComputedStyle, matchMedia, animation frames) import nothing and throw ReferenceError", async () => {
    // styled-components' `createTheme().resolve` calls `getComputedStyle`; the
    // optimizer folds it away behind `IS_BROWSER`, the unoptimized binary did not.
    const { module, imports } = await compileProjectFiles({
      "win.js": `
export function computed(n) { return getComputedStyle(n).getPropertyValue("--x"); }
export function media(q) { return matchMedia(q).matches; }
export function frame(f) { return requestAnimationFrame(f); }
export function unframe(h) { cancelAnimationFrame(h); }
`,
      "main.js": `
import { computed, media, frame, unframe } from "./win.js";
${CLASSIFY}
export function typeofs() {
  return (typeof getComputedStyle === "undefined" ? 1 : 0) + (typeof matchMedia === "undefined" ? 10 : 0) +
    (typeof requestAnimationFrame === "undefined" ? 100 : 0) + (typeof cancelAnimationFrame === "undefined" ? 1000 : 0);
}
export function reached() {
  return attempt(() => computed({})) + attempt(() => media("(x)")) * 10 + attempt(() => frame(() => 1)) * 100 +
    attempt(() => unframe(1)) * 1000;
}
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    expect(exports.typeofs()).toBe(1111);
    expect(exports.reached()).toBe(1111);
  });

  it("user bindings of the same names keep their own semantics", async () => {
    const { module, imports } = await compileProjectFiles({
      "shim.js": `
export const document = { head: { id: 7 }, createElement(t) { return { tag: t }; } };
export const navigator = { product: "Gecko" };
`,
      "main.js": `
import { document, navigator } from "./shim.js";
export function test() { return document.head.id + document.createElement("style").tag.length * 10 + navigator.product.length * 100; }
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test()).toBe(7 + 50 + 500);
  });
});
