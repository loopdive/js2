import type { BenchmarkDef } from "../harness.js";

/**
 * DOM benchmarks measure the boundary-crossing overhead for DOM operations.
 *
 * Since wasm cannot access the DOM directly, all wasm strategies must cross
 * the host boundary. The comparison here is:
 *   - JS baseline (no boundary)
 *   - host-call mode (externref DOM objects)
 *
 * GC-native and linear-memory are skipped for pure DOM operations because
 * DOM always requires host calls. Future batching strategies could be added.
 *
 * Note: These benchmarks use mock DOM objects since Node.js has no real DOM.
 * The mock overhead is constant across strategies, so relative performance
 * is still meaningful for measuring boundary-crossing cost.
 */

// ---------------------------------------------------------------------------
// Mock DOM for Node.js
// ---------------------------------------------------------------------------

class MockElement {
  tagName: string;
  textContent = "";
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  classList: Set<string> = new Set();
  style: Record<string, string> = {};

  constructor(tag: string) {
    this.tagName = tag;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  appendChild(child: MockElement) {
    this.children.push(child);
  }
}

class MockDocument {
  createElement(tag: string): MockElement {
    return new MockElement(tag);
  }
  querySelector(_sel: string): MockElement | null {
    return new MockElement("div");
  }
}

const mockDoc = new MockDocument();

/**
 * Host dependencies handed to `buildImports` for every DOM benchmark.
 *
 * `document` is the load-bearing entry (#3904). Each compiled module imports
 * `env.global_document`, which the runtime resolves through the
 * `declared_global` intent: `deps.document` first, then the ambient
 * `globalThis.document`, then a `() => {}` stub. Node has no `document`, so
 * omitting the key handed the module `undefined` as its Document handle and
 * every host-call lane trapped on the first call with
 * `Cannot read properties of undefined (reading 'createElement')` — which the
 * harness swallowed, leaving all four DOM benchmarks with a JS-only bar.
 *
 * The classes satisfy the `extern_class` imports (`Document_createElement`,
 * `Element_appendChild`, `Element_setAttribute`, ...).
 */
const domDeps = {
  Document: MockDocument,
  Element: MockElement,
  document: mockDoc,
};

// ---------------------------------------------------------------------------
// JS baselines
// ---------------------------------------------------------------------------

function createElements(): void {
  const parent = mockDoc.createElement("div");
  for (let i = 0; i < 1000; i++) {
    const el = mockDoc.createElement("span");
    parent.appendChild(el);
  }
}

function setAttributes(): void {
  const elements: MockElement[] = [];
  for (let i = 0; i < 1000; i++) elements.push(mockDoc.createElement("div"));
  for (const el of elements) {
    el.setAttribute("id", "test");
    el.setAttribute("class", "item");
    el.setAttribute("data-index", "0");
    el.setAttribute("data-type", "node");
    el.setAttribute("title", "element");
  }
}

function readAttributes(): number {
  const elements: MockElement[] = [];
  for (let i = 0; i < 1000; i++) {
    const el = mockDoc.createElement("div");
    el.setAttribute("data-value", "test");
    elements.push(el);
  }
  let count = 0;
  for (const el of elements) {
    const v = el.getAttribute("data-value");
    if (v !== null && v.length > 0) count++;
  }
  return count;
}

function modifyText(): void {
  for (let i = 0; i < 1000; i++) {
    const el = mockDoc.createElement("span");
    el.textContent = "updated content";
  }
}

// ---------------------------------------------------------------------------
// Benchmark definitions
// ---------------------------------------------------------------------------

export const domBenchmarks: BenchmarkDef[] = [
  {
    name: "dom/create-elements",
    iterations: 100,
    // 1000 createElement + 1000 appendChild host calls.
    opsPerCall: 2000,
    // Uses extern class pattern for DOM
    source: `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  appendChild(child: Element): void;
}
declare const document: Document;

export function run(): number {
  const parent = document.createElement("div");
  for (let i = 0; i < 1000; i = i + 1) {
    const el = document.createElement("span");
    parent.appendChild(el);
  }
  return 0;
}`,
    deps: domDeps,
    js: createElements,
    skip: ["gc-native", "linear-memory"], // DOM always needs host calls
  },
  {
    name: "dom/set-attributes",
    iterations: 100,
    // 1000 createElement + 5000 setAttribute host calls.
    opsPerCall: 6000,
    source: `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  setAttribute(name: string, value: string): void;
}
declare const document: Document;

export function run(): number {
  for (let i = 0; i < 1000; i = i + 1) {
    const el = document.createElement("div");
    el.setAttribute("id", "test");
    el.setAttribute("class", "item");
    el.setAttribute("data-index", "0");
    el.setAttribute("data-type", "node");
    el.setAttribute("title", "element");
  }
  return 0;
}`,
    deps: domDeps,
    js: setAttributes,
    skip: ["gc-native", "linear-memory"],
  },
  {
    name: "dom/read-attributes",
    iterations: 100,
    // 1000 each of createElement / setAttribute / getAttribute.
    opsPerCall: 3000,
    source: `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}
declare const document: Document;

export function run(): number {
  let count = 0;
  for (let i = 0; i < 1000; i = i + 1) {
    const el = document.createElement("div");
    el.setAttribute("data-value", "test");
    const v = el.getAttribute("data-value");
    if (v !== null && v.length > 0) count = count + 1;
  }
  return count;
}`,
    deps: domDeps,
    js: readAttributes,
    skip: ["gc-native", "linear-memory"],
  },
  {
    name: "dom/modify-text",
    iterations: 100,
    // 1000 createElement + 1000 textContent writes, matching the JS baseline
    // above.
    opsPerCall: 2000,
    source: `
declare class Document {
  createElement(tag: string): Element;
}
declare class Element {
  textContent: string;
}
declare const document: Document;

export function run(): number {
  for (let i = 0; i < 1000; i = i + 1) {
    const el = document.createElement("span");
    el.textContent = "updated content";
  }
  return 0;
}`,
    deps: domDeps,
    js: modifyText,
    skip: ["gc-native", "linear-memory"],
  },
];
