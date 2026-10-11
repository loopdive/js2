// #6792 — DOM containment (`buildImports(..., { domRoot })`) must not exempt the
// root itself from the mutation checks. Methods that act on the receiver's PARENT
// or siblings (after/before/remove/replaceWith, insertAdjacent* "beforebegin" /
// "afterend", outerHTML/outerText writes) escape the container when the receiver
// is the root; inward mutators on the root must keep working.
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
export function rAfter(root: HTMLElement, el: HTMLElement): void { root.after(el); }
export function rBefore(root: HTMLElement, el: HTMLElement): void { root.before(el); }
export function rRemove(root: HTMLElement): void { root.remove(); }
export function rReplaceWith(root: HTMLElement, el: HTMLElement): void { root.replaceWith(el); }
export function rAdjHtml(root: HTMLElement, pos: any): void { root.insertAdjacentHTML(pos, "<div>outside</div>"); }
export function rAdjElement(root: HTMLElement, el: HTMLElement): void { root.insertAdjacentElement("beforebegin", el); }
export function rAdjText(root: HTMLElement): void { root.insertAdjacentText("afterend", "outside"); }
export function rOuterHTML(root: HTMLElement): void { root.outerHTML = "<p>replaced</p>"; }
export function rOuterText(root: HTMLElement): void { root.outerText = "replaced"; }
export function rAppend(root: HTMLElement, el: HTMLElement): void { root.append(el); }
export function rInnerHTML(root: HTMLElement): void { root.innerHTML = "<b>inner</b>"; }
export function rChildAfter(root: HTMLElement, el: HTMLElement): void {
  const c = root.firstElementChild;
  if (c) c.after(el);
}
`;

let compiled: Awaited<ReturnType<typeof compile>>;

beforeAll(async () => {
  compiled = await compile(SOURCE, { fileName: "issue-6792.ts" });
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
});

async function setup() {
  const dom = new JSDOM(`<body><header></header><div id="root"><span>kid</span></div><footer></footer></body>`);
  const doc = dom.window.document;
  const root = doc.getElementById("root")!;
  const imports: any = buildImports(compiled.imports, undefined, compiled.stringPool, { domRoot: root as any });
  const { instance } = await WebAssembly.instantiate(compiled.binary, imports);
  imports.setInstance?.(instance);
  const outsideSnapshot = () => [...doc.body.childNodes].map((n) => (n === root ? "[root]" : n.nodeName)).join(",");
  return { doc, root, exports: instance.exports as Record<string, Function>, outsideSnapshot };
}

describe("#6792 — domRoot cannot mutate outside itself", () => {
  const escaping: Array<[string, string, (doc: Document) => unknown[]]> = [
    ["after", "rAfter", (doc) => [doc.createElement("script")]],
    ["before", "rBefore", (doc) => [doc.createElement("script")]],
    ["remove", "rRemove", () => []],
    ["replaceWith", "rReplaceWith", (doc) => [doc.createElement("script")]],
    ['insertAdjacentHTML("beforebegin")', "rAdjHtml", () => ["beforebegin"]],
    ['insertAdjacentHTML("AfterEnd") — position is case-insensitive', "rAdjHtml", () => ["AfterEnd"]],
    ['insertAdjacentElement("beforebegin")', "rAdjElement", (doc) => [doc.createElement("script")]],
    ['insertAdjacentText("afterend")', "rAdjText", () => []],
    ["outerHTML =", "rOuterHTML", () => []],
    ["outerText =", "rOuterText", () => []],
  ];

  it.each(escaping)("root.%s throws the containment error and leaves the parent unchanged", async (_l, fn, args) => {
    const { doc, root, exports, outsideSnapshot } = await setup();
    const before = outsideSnapshot();
    expect(() => exports[fn](root, ...args(doc))).toThrow("DOM containment violation");
    expect(outsideSnapshot()).toBe(before);
    expect(root.parentNode).toBe(doc.body);
    expect(root.innerHTML).toBe("<span>kid</span>");
  });

  it("inward mutations on the root and outward ones on a contained child still work", async () => {
    const { doc, root, exports, outsideSnapshot } = await setup();
    const before = outsideSnapshot();
    exports.rAppend(root, doc.createElement("i"));
    exports.rAdjHtml(root, "beforeend");
    exports.rAdjHtml(root, "afterbegin");
    expect(root.innerHTML).toBe("<div>outside</div><span>kid</span><i></i><div>outside</div>");
    exports.rChildAfter(root, doc.createElement("em"));
    expect(root.innerHTML).toBe("<div>outside</div><em></em><span>kid</span><i></i><div>outside</div>");
    exports.rInnerHTML(root);
    expect(root.innerHTML).toBe("<b>inner</b>");
    expect(outsideSnapshot()).toBe(before);
  });
});
