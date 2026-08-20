// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  DOM_INTERACTION_IMPORT_NAMES,
  type DomCapabilityImportContract,
  type DomInteractionImportContract,
  isDomCapabilityImportDescriptor,
  isDomInteractionImportDescriptor,
} from "../dom-capability-contract.js";
import type { ImportDescriptor } from "../index.js";

export { DOM_CAPABILITY_IMPORT_NAMES, DOM_INTERACTION_IMPORT_NAMES } from "../dom-capability-contract.js";

export type DomCapabilityImportName = DomCapabilityImportContract["name"];

type ObjectLike = object | Function;

const reflectApply = Reflect.apply;
const reflectGet = Reflect.get;
const reflectSet = Reflect.set;
const weakSetAdd = WeakSet.prototype.add;
const weakSetHas = WeakSet.prototype.has;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;

/** The only host authority admitted by the exact `dom@1` adapter. */
export interface DomCapabilityRoot {
  readonly body: unknown;
  contains(candidate: unknown): boolean;
  createElement(tagName: string, options?: unknown): unknown;
}

export type DomCapabilityStringSite =
  | "Document.createElement tagName"
  | "Element.innerHTML"
  | "Element.textContent"
  | "CSSStyleDeclaration.cssText"
  | "CSSStyleDeclaration.background"
  | "HTMLElement.addEventListener type";

export { isDomInteractionImportDescriptor } from "../dom-capability-contract.js";

export type DomInteractionImportName = DomInteractionImportContract["name"];

export interface DomCapabilityInteractionOptions {
  /** Wrap one packed Wasm closure through this lifecycle's authenticated dispatcher. */
  readonly wrapCallback: (packedClosure: unknown) => Function;
}

export interface DomCapabilityAdapterOptions {
  /** Explicit subtree/Document facade. Ambient `document` is never consulted. */
  readonly root: unknown;
  /** Optional opaque document handle; host operations still run on `root`. */
  readonly documentAuthority?: unknown;
  /** Strict native-string projection. It must either return a string or throw. */
  readonly toHostString: (value: unknown, site: DomCapabilityStringSite) => string;
  /** Omit to retain the frozen eight-import dom@1 surface. */
  readonly interaction?: DomCapabilityInteractionOptions;
}

export interface DomCapabilityImports {
  readonly global_document: () => unknown;
  readonly Document_createElement: (self: unknown, tagName: unknown, options?: unknown) => unknown;
  readonly Document_get_body: (self: unknown) => unknown;
  readonly Element_set_innerHTML: (self: unknown, value: unknown) => void;
  readonly Element_set_textContent: (self: unknown, value: unknown) => void;
  readonly CSSStyleDeclaration_set_cssText: (self: unknown, value: unknown) => void;
  readonly HTMLElement_get_style: (self: unknown) => unknown;
  readonly Node_appendChild: (self: unknown, child: unknown) => unknown;
}

export interface DomInteractionImports {
  readonly HTMLElement_addEventListener: (self: unknown, type: unknown, callback: unknown, options: unknown) => void;
  readonly CSSStyleDeclaration_set_background: (self: unknown, value: unknown) => void;
}

/** Closed adapter surface consumed by `buildImports`. */
export interface DomCapabilityAdapter {
  readonly imports: Readonly<DomCapabilityImports & Partial<DomInteractionImports>>;
  /** Return `undefined` outside the exact enabled ABI. */
  bind(descriptor: ImportDescriptor): Function | undefined;
}

function isObjectLike(value: unknown): value is ObjectLike {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function requireObjectLike(value: unknown, detail: string): ObjectLike {
  if (!isObjectLike(value)) {
    throw new TypeError(`DOM capability authentication failed: ${detail} must be an object`);
  }
  return value;
}

function requireMethod(value: ObjectLike, name: string, detail: string): Function {
  const method = reflectGet(value, name) as unknown;
  if (typeof method !== "function") {
    throw new TypeError(`DOM capability authentication failed: ${detail}.${name} must be callable`);
  }
  return method;
}

/**
 * Bind the exact `dom@1` capability to one explicit subtree root.
 *
 * Authority is structural only at the root boundary: no DOM globals,
 * constructors, `instanceof`, string coercion, or ambient `document` fallback
 * participates. A node is accepted when it is the explicit root/body, is
 * currently contained by the root, or was minted by this provider. Styles are
 * accepted only after being obtained from an authorized node.
 */
export function createDomCapabilityAdapter(options: DomCapabilityAdapterOptions): DomCapabilityAdapter {
  if (!options || typeof options.toHostString !== "function") {
    throw new TypeError("DOM capability authentication failed: a strict toHostString callback is required");
  }
  if (options.interaction !== undefined && typeof options.interaction.wrapCallback !== "function") {
    throw new TypeError("DOM capability authentication failed: interaction.wrapCallback must be callable");
  }

  const hostRoot = requireObjectLike(options.root, "an explicit root");
  const documentAuthority =
    options.documentAuthority === undefined
      ? hostRoot
      : requireObjectLike(options.documentAuthority, "the document authority handle");
  const contains = requireMethod(hostRoot, "contains", "root");
  const createElement = requireMethod(hostRoot, "createElement", "root");
  const body = requireObjectLike(reflectGet(hostRoot, "body"), "root.body");

  const containsAtRoot = (candidate: unknown): boolean => {
    try {
      return reflectApply(contains, hostRoot, [candidate]) === true;
    } catch {
      return false;
    }
  };

  if (body !== hostRoot && !containsAtRoot(body)) {
    throw new TypeError("DOM capability authentication failed: root.body must be inside the explicit root");
  }

  const providerNodes = new WeakSet<ObjectLike>();
  const providerStyles = new WeakMap<ObjectLike, ObjectLike>();
  reflectApply(weakSetAdd, providerNodes, [hostRoot]);

  const isAuthorizedNode = (value: unknown): value is ObjectLike =>
    isObjectLike(value) && (reflectApply(weakSetHas, providerNodes, [value]) || containsAtRoot(value));

  const requireAuthorizedNode = (value: unknown, site: string): ObjectLike => {
    if (!isAuthorizedNode(value)) {
      throw new TypeError(`DOM capability authority violation: ${site} is outside the authenticated subtree`);
    }
    return value;
  };

  const requireDocument = (value: unknown, site: string): ObjectLike => {
    if (value !== documentAuthority) {
      throw new TypeError(`DOM capability authority violation: ${site} requires the authenticated root`);
    }
    return hostRoot;
  };

  const toHostString = (value: unknown, site: DomCapabilityStringSite): string => {
    if (typeof value === "string") return value;
    const projected = options.toHostString(value, site);
    if (typeof projected !== "string") {
      throw new TypeError(`DOM capability string projection failed at ${site}: expected a JavaScript string`);
    }
    return projected;
  };

  const setStringProperty = (
    value: unknown,
    property: "innerHTML" | "textContent" | "cssText" | "background",
    projected: string,
    site: string,
  ): void => {
    if (!reflectSet(value as ObjectLike, property, projected)) {
      throw new TypeError(`DOM capability mutation failed: ${site} is not writable`);
    }
  };

  const imports: DomCapabilityImports & {
    HTMLElement_addEventListener?: DomInteractionImports["HTMLElement_addEventListener"];
    CSSStyleDeclaration_set_background?: DomInteractionImports["CSSStyleDeclaration_set_background"];
  } = {
    global_document: () => documentAuthority,

    Document_createElement: (self, tagName, elementOptions) => {
      const receiver = requireDocument(self, "Document.createElement receiver");
      const hostTagName = toHostString(tagName, "Document.createElement tagName");
      const created =
        elementOptions == null
          ? reflectApply(createElement, receiver, [hostTagName])
          : reflectApply(createElement, receiver, [hostTagName, elementOptions]);
      const node = requireObjectLike(created, "Document.createElement result");
      reflectApply(weakSetAdd, providerNodes, [node]);
      return node;
    },

    Document_get_body: (self) => {
      requireDocument(self, "Document.body receiver");
      return requireAuthorizedNode(body, "Document.body result");
    },

    Element_set_innerHTML: (self, value) => {
      const node = requireAuthorizedNode(self, "Element.innerHTML receiver");
      setStringProperty(node, "innerHTML", toHostString(value, "Element.innerHTML"), "Element.innerHTML");
    },

    Element_set_textContent: (self, value) => {
      const node = requireAuthorizedNode(self, "Element.textContent receiver");
      setStringProperty(node, "textContent", toHostString(value, "Element.textContent"), "Element.textContent");
    },

    CSSStyleDeclaration_set_cssText: (self, value) => {
      const owner = isObjectLike(self)
        ? (reflectApply(weakMapGet, providerStyles, [self]) as ObjectLike | undefined)
        : undefined;
      if (!owner) {
        throw new TypeError(
          "DOM capability authority violation: CSSStyleDeclaration.cssText receiver is not a provider style",
        );
      }
      requireAuthorizedNode(owner, "CSSStyleDeclaration.cssText owner");
      setStringProperty(
        self,
        "cssText",
        toHostString(value, "CSSStyleDeclaration.cssText"),
        "CSSStyleDeclaration.cssText",
      );
    },

    HTMLElement_get_style: (self) => {
      const node = requireAuthorizedNode(self, "HTMLElement.style receiver");
      const style = requireObjectLike(reflectGet(node, "style"), "HTMLElement.style result");
      reflectApply(weakMapSet, providerStyles, [style, node]);
      return style;
    },

    Node_appendChild: (self, child) => {
      const parent = requireAuthorizedNode(self, "Node.appendChild receiver");
      const authorizedChild = requireAuthorizedNode(child, "Node.appendChild operand");
      const appendChild = requireMethod(parent, "appendChild", "authorized node");
      const result = reflectApply(appendChild, parent, [authorizedChild]);
      requireAuthorizedNode(result, "Node.appendChild result");
      return result;
    },
  };

  if (options.interaction) {
    imports.HTMLElement_addEventListener = (
      self: unknown,
      type: unknown,
      packedCallback: unknown,
      eventOptions: unknown,
    ) => {
      const node = requireAuthorizedNode(self, "HTMLElement.addEventListener receiver");
      if (eventOptions !== null && eventOptions !== undefined) {
        throw new TypeError("DOM capability authority violation: addEventListener options must be null or undefined");
      }
      const hostType = toHostString(type, "HTMLElement.addEventListener type");
      const callback = options.interaction!.wrapCallback(packedCallback);
      if (typeof callback !== "function") {
        throw new TypeError("DOM capability authentication failed: interaction callback wrapper was not callable");
      }
      const addEventListener = requireMethod(node, "addEventListener", "authorized node");
      reflectApply(addEventListener, node, [hostType, callback, eventOptions]);
    };

    imports.CSSStyleDeclaration_set_background = (self: unknown, value: unknown) => {
      const owner = isObjectLike(self)
        ? (reflectApply(weakMapGet, providerStyles, [self]) as ObjectLike | undefined)
        : undefined;
      if (!owner) {
        throw new TypeError(
          "DOM capability authority violation: CSSStyleDeclaration.background receiver is not a provider style",
        );
      }
      requireAuthorizedNode(owner, "CSSStyleDeclaration.background owner");
      setStringProperty(
        self,
        "background",
        toHostString(value, "CSSStyleDeclaration.background"),
        "CSSStyleDeclaration.background",
      );
    };
  }

  Object.freeze(imports);
  return Object.freeze({
    imports,
    bind(descriptor: ImportDescriptor): Function | undefined {
      if (isDomCapabilityImportDescriptor(descriptor)) return imports[descriptor.name as DomCapabilityImportName];
      return options.interaction && isDomInteractionImportDescriptor(descriptor)
        ? imports[descriptor.name as DomInteractionImportName]
        : undefined;
    },
  });
}
