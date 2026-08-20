// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { DOM_CAPABILITY_IMPORT_NAMES } from "../src/dom-capability-contract.js";
import type { ImportDescriptor } from "../src/index.js";
import { createDomCapabilityAdapter, type DomCapabilityStringSite } from "../src/runtime/dom-capability-adapter.js";
import { createStandaloneDomCapabilityRuntime } from "../src/runtime/standalone-dom-string-bridge.js";

class TestStyle {
  cssText = "";
}

class TestNode {
  readonly nodeType = 1;
  readonly style = new TestStyle();
  readonly children: TestNode[] = [];
  textContent = "";
  innerHTML = "";

  constructor(readonly tagName: string) {}

  appendChild(child: TestNode): TestNode {
    this.children.push(child);
    return child;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }
}

class TestRoot extends TestNode {
  readonly body = this;

  constructor() {
    super("body");
  }

  createElement(tagName: string): TestNode {
    return new TestNode(tagName);
  }
}

const DOM_DESCRIPTORS: readonly ImportDescriptor[] = [
  {
    module: "env",
    name: "global_document",
    kind: "func",
    intent: { type: "declared_global", name: "document" },
    paramCount: 0,
  },
  ...[
    ["Document_createElement", "Document", "method", "createElement", 3],
    ["Document_get_body", "Document", "get", "body", 1],
    ["Element_set_innerHTML", "Element", "set", "innerHTML", 2],
    ["Element_set_textContent", "Element", "set", "textContent", 2],
    ["CSSStyleDeclaration_set_cssText", "CSSStyleDeclaration", "set", "cssText", 2],
    ["HTMLElement_get_style", "HTMLElement", "get", "style", 1],
    ["Node_appendChild", "Node", "method", "appendChild", 2],
  ].map(
    ([name, className, action, member, paramCount]) =>
      ({
        module: "env",
        name,
        kind: "func",
        intent: { type: "extern_class", className, action, member },
        paramCount,
      }) as ImportDescriptor,
  ),
];

function strictProjector(entries: ReadonlyMap<object, string>, observations: DomCapabilityStringSite[]) {
  return (value: unknown, site: DomCapabilityStringSite): string => {
    observations.push(site);
    if (value !== null && typeof value === "object") {
      const projected = entries.get(value);
      if (projected !== undefined) return projected;
    }
    throw new TypeError(`unsupported string carrier at ${site}`);
  };
}

describe("exact DOM capability adapter", () => {
  it("requires an explicit authenticating root and binds only the shared eight-import contract", () => {
    const project = () => "unused";
    expect(() => createDomCapabilityAdapter({ root: undefined, toHostString: project })).toThrow(
      /DOM capability.+explicit root/i,
    );
    expect(() =>
      createDomCapabilityAdapter({
        root: { body: {}, createElement: () => ({}) },
        toHostString: project,
      }),
    ).toThrow(/root\.contains must be callable/i);
    expect(() =>
      createDomCapabilityAdapter({
        root: { body: {}, contains: () => false, createElement: () => ({}) },
        toHostString: project,
      }),
    ).toThrow(/root\.body must be inside/i);

    const root = new TestRoot();
    const adapter = createDomCapabilityAdapter({ root, toHostString: project });
    expect(Object.keys(adapter.imports).sort()).toEqual([...DOM_CAPABILITY_IMPORT_NAMES].sort());
    for (const descriptor of DOM_DESCRIPTORS) {
      expect(adapter.bind(descriptor)).toBe(adapter.imports[descriptor.name as keyof typeof adapter.imports]);
    }
    expect(
      adapter.bind({
        module: "env",
        name: "Element_querySelector",
        kind: "func",
        intent: { type: "extern_class", className: "Element", action: "method", member: "querySelector" },
        paramCount: 2,
      }),
    ).toBeUndefined();
    expect(adapter.bind({ ...DOM_DESCRIPTORS[3]!, intent: { type: "extern_get" } })).toBeUndefined();
    expect(Object.isFrozen(DOM_CAPABILITY_IMPORT_NAMES)).toBe(true);
    expect(() => (DOM_CAPABILITY_IMPORT_NAMES as string[]).pop()).toThrow();
    expect(Object.isFrozen(adapter.imports)).toBe(true);
    expect(adapter.imports.global_document()).toBe(root);
    expect(adapter.imports.Document_get_body(root)).toBe(root);

    const runtime = createStandaloneDomCapabilityRuntime(root);
    expect(() =>
      runtime.bindImport({
        module: "env",
        name: "HTMLDivElement_get_parentElement",
        kind: "func",
        intent: { type: "extern_class", className: "HTMLDivElement", action: "get", member: "parentElement" },
        paramCount: 1,
      }),
    ).toThrow(/non-exact|rejected|dom@1/i);
    expect(() =>
      runtime.bindImport({
        module: "env",
        name: "global_window",
        kind: "func",
        intent: { type: "declared_global", name: "window" },
        paramCount: 0,
      }),
    ).toThrow(/non-exact|rejected|dom@1/i);
  });

  it("authorizes provider-minted detached nodes and styles while projecting strings strictly", () => {
    const root = new TestRoot();
    const tagCarrier = {};
    const textCarrier = {};
    const cssCarrier = {};
    const projections = new Map<object, string>([
      [tagCarrier, "section"],
      [textCarrier, "native text"],
      [cssCarrier, "color:purple"],
    ]);
    const observations: DomCapabilityStringSite[] = [];
    const { imports } = createDomCapabilityAdapter({
      root,
      toHostString: strictProjector(projections, observations),
    });

    const detached = imports.Document_createElement(root, tagCarrier) as TestNode;
    expect(root.contains(detached)).toBe(false);
    imports.Element_set_textContent(detached, textCarrier);
    const style = imports.HTMLElement_get_style(detached) as TestStyle;
    imports.CSSStyleDeclaration_set_cssText(style, cssCarrier);
    imports.Element_set_innerHTML(detached, "plain JS string");
    expect(detached).toMatchObject({
      tagName: "section",
      textContent: "native text",
      innerHTML: "plain JS string",
      style: { cssText: "color:purple" },
    });
    expect(observations).toEqual([
      "Document.createElement tagName",
      "Element.textContent",
      "CSSStyleDeclaration.cssText",
    ]);

    expect(imports.Node_appendChild(root, detached)).toBe(detached);
    expect(root.contains(detached)).toBe(true);
  });

  it("rejects foreign nodes, styles, append operands, receivers, and coercible non-string values", () => {
    const root = new TestRoot();
    const observations: DomCapabilityStringSite[] = [];
    const { imports } = createDomCapabilityAdapter({
      root,
      toHostString: strictProjector(new Map(), observations),
    });
    const minted = imports.Document_createElement(root, "div") as TestNode;
    const foreign = new TestNode("foreign");

    expect(() => imports.Document_createElement(foreign, "p")).toThrow(/authority|authenticated root/i);
    expect(() => imports.Element_set_textContent(foreign, "evil")).toThrow(/authority|subtree/i);
    expect(() => imports.HTMLElement_get_style(foreign)).toThrow(/authority|subtree/i);
    expect(() => imports.CSSStyleDeclaration_set_cssText(foreign.style, "evil")).toThrow(/provider style/i);
    expect(() => imports.Node_appendChild(foreign, minted)).toThrow(/authority|subtree/i);
    expect(() => imports.Node_appendChild(root, foreign)).toThrow(/authority|subtree/i);

    const initiallyContained = new TestNode("contained");
    root.appendChild(initiallyContained);
    const formerlyAuthorizedStyle = imports.HTMLElement_get_style(initiallyContained);
    root.children.splice(root.children.indexOf(initiallyContained), 1);
    expect(() => imports.CSSStyleDeclaration_set_cssText(formerlyAuthorizedStyle, "evil")).toThrow(
      /authority|subtree|owner/i,
    );

    let coercions = 0;
    const coercible = {
      toString() {
        coercions++;
        return "coerced";
      },
    };
    expect(() => imports.Element_set_textContent(minted, coercible)).toThrow(/unsupported string carrier/i);
    expect(coercions).toBe(0);
    expect(observations).toEqual(["Element.textContent"]);
  });
});
