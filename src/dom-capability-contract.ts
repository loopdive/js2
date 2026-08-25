// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportDescriptor } from "./index.js";
import type { CompileTargetProfile } from "./target-profile.js";

/** Exact standalone embedder ABI for the bounded DOM subtree capability. */
export const DOM_CAPABILITY_ID = "dom" as const;
export const DOM_CAPABILITY_ABI_NAMESPACE = "js2wasm:capability/dom" as const;
export const DOM_CAPABILITY_ABI_VERSION = 1 as const;

export const DOM_CAPABILITY_PERMISSIONS = Object.freeze([
  "dom:subtree-read",
  "dom:subtree-write",
  "dom:create-element",
] as const);

export interface DomCapabilityImportContract {
  readonly name:
    | "global_document"
    | "Document_createElement"
    | "Document_get_body"
    | "Element_set_innerHTML"
    | "Element_set_textContent"
    | "CSSStyleDeclaration_set_cssText"
    | "HTMLElement_get_style"
    | "Node_appendChild";
  readonly params: readonly string[];
  readonly results: readonly string[];
}

export const DOM_CAPABILITY_IMPORTS: readonly DomCapabilityImportContract[] = Object.freeze([
  Object.freeze({ name: "global_document", params: Object.freeze([]), results: Object.freeze(["externref"]) }),
  Object.freeze({
    name: "Document_createElement",
    params: Object.freeze(["externref", "externref", "externref"]),
    results: Object.freeze(["externref"]),
  }),
  Object.freeze({
    name: "Document_get_body",
    params: Object.freeze(["externref"]),
    results: Object.freeze(["externref"]),
  }),
  Object.freeze({
    name: "Element_set_innerHTML",
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze([]),
  }),
  Object.freeze({
    name: "Element_set_textContent",
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze([]),
  }),
  Object.freeze({
    name: "CSSStyleDeclaration_set_cssText",
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze([]),
  }),
  Object.freeze({
    name: "HTMLElement_get_style",
    params: Object.freeze(["externref"]),
    results: Object.freeze(["externref"]),
  }),
  Object.freeze({
    name: "Node_appendChild",
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze(["externref"]),
  }),
]);

export const DOM_CAPABILITY_IMPORT_NAMES = Object.freeze(DOM_CAPABILITY_IMPORTS.map(({ name }) => name));

/** Frozen optional Calendar interaction ABI; base dom@1 remains unchanged. */
export const DOM_INTERACTION_CAPABILITY_ID = "dom-interaction" as const;
export const DOM_INTERACTION_CAPABILITY_ABI_NAMESPACE = "js2wasm:capability/dom-interaction" as const;
export const DOM_INTERACTION_CAPABILITY_ABI_VERSION = 1 as const;
export const DOM_INTERACTION_CAPABILITY_PERMISSIONS = Object.freeze(["dom:event-listen", "dom:style-write"] as const);

export interface DomInteractionImportContract {
  readonly name: "HTMLElement_addEventListener" | "CSSStyleDeclaration_set_background";
  readonly params: readonly string[];
  readonly results: readonly string[];
}

export const DOM_INTERACTION_CAPABILITY_IMPORTS: readonly DomInteractionImportContract[] = Object.freeze([
  Object.freeze({
    name: "HTMLElement_addEventListener",
    params: Object.freeze(["externref", "externref", "externref", "externref"]),
    results: Object.freeze([]),
  }),
  Object.freeze({
    name: "CSSStyleDeclaration_set_background",
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze([]),
  }),
]);

export const DOM_INTERACTION_IMPORT_NAMES = Object.freeze(DOM_INTERACTION_CAPABILITY_IMPORTS.map(({ name }) => name));

// Authority checks must never depend on a caller-mutable collection. The
// exported tuple above is useful for manifests/tests; this private membership
// table is the only source used by the runtime/codegen guards.
const DOM_CAPABILITY_IMPORT_NAME_SET: ReadonlySet<string> = new Set(DOM_CAPABILITY_IMPORT_NAMES);
const DOM_INTERACTION_IMPORT_NAME_SET: ReadonlySet<string> = new Set(DOM_INTERACTION_IMPORT_NAMES);

export function isDomCapabilityImportName(name: string): name is DomCapabilityImportContract["name"] {
  return DOM_CAPABILITY_IMPORT_NAME_SET.has(name);
}

export function isDomInteractionImportName(name: string): name is DomInteractionImportContract["name"] {
  return DOM_INTERACTION_IMPORT_NAME_SET.has(name);
}

/** Exact typed descriptor surface authenticated by the standalone adapter. */
export function isDomCapabilityImportDescriptor(descriptor: ImportDescriptor): boolean {
  if (descriptor.module !== "env" || descriptor.kind !== "func") return false;
  const { intent } = descriptor;
  if (descriptor.name === "global_document") {
    return intent.type === "declared_global" && intent.name === "document" && descriptor.paramCount === 0;
  }
  if (intent.type !== "extern_class") return false;
  const key = `${descriptor.name}:${intent.className}:${intent.action}:${intent.member ?? ""}:${descriptor.paramCount ?? -1}`;
  return DOM_CAPABILITY_DESCRIPTOR_KEYS.has(key);
}

/** Exact typed descriptor surface of the optional DOM-interaction extension. */
export function isDomInteractionImportDescriptor(descriptor: ImportDescriptor): boolean {
  if (descriptor.module !== "env" || descriptor.kind !== "func" || descriptor.intent.type !== "extern_class") {
    return false;
  }
  const { intent } = descriptor;
  return DOM_INTERACTION_DESCRIPTOR_KEYS.has(
    `${descriptor.name}:${intent.className}:${intent.action}:${intent.member ?? ""}:${descriptor.paramCount ?? -1}`,
  );
}

/**
 * True for a descriptor that attempts to occupy the bounded DOM surface. A
 * candidate that is not exact must fail closed instead of reaching the broad
 * compatibility resolver.
 */
export function isDomCapabilityDescriptorCandidate(descriptor: ImportDescriptor): boolean {
  if (descriptor.module !== "env") return false;
  if (isDomCapabilityImportName(descriptor.name) || isDomInteractionImportName(descriptor.name)) return true;
  const { intent } = descriptor;
  return (
    intent.type === "declared_global" ||
    // A separately authenticated ambient global or external API needs its own
    // adapter. Once closed dom@1 is active, no broad resolver may sit beside it
    // and acquire DOM authority through a mixin or derived interface name.
    intent.type === "extern_class"
  );
}

/** Require the frozen adapter manifest to retain the exact closed dom@1 owner. */
export function requiresExactDomCapabilityAdapter(
  imports: readonly ImportDescriptor[],
  capabilities: readonly { readonly id: string; readonly selectedProviders: readonly string[] }[],
  targetProfile: CompileTargetProfile,
): boolean {
  const selected = capabilities.some(
    ({ id, selectedProviders }) => id === DOM_CAPABILITY_ID && selectedProviders.includes("embedder"),
  );
  const interactionSelected = capabilities.some(
    ({ id, selectedProviders }) => id === DOM_INTERACTION_CAPABILITY_ID && selectedProviders.includes("embedder"),
  );
  const contractNamed = imports.some(
    (descriptor) =>
      isDomCapabilityImportName(descriptor.name) ||
      isDomInteractionImportName(descriptor.name) ||
      (descriptor.intent.type === "declared_global" && descriptor.intent.name === "document"),
  );
  if (!selected) {
    if (interactionSelected) {
      throw new TypeError("DOM interaction imports require the exact validated dom@1 embedder capability");
    }
    const coherentJavaScriptHost =
      targetProfile.target === "gc" &&
      targetProfile.backend === "wasmgc" &&
      targetProfile.environment === "javascript" &&
      targetProfile.capabilityPolicy === "ambient-js";
    if (!coherentJavaScriptHost && contractNamed) {
      throw new TypeError("Explicit DOM imports require the exact validated dom@1 embedder capability");
    }
    return false;
  }
  if (
    imports.some(
      (descriptor) =>
        isDomCapabilityDescriptorCandidate(descriptor) &&
        !isDomCapabilityImportDescriptor(descriptor) &&
        !(interactionSelected && isDomInteractionImportDescriptor(descriptor)),
    )
  ) {
    throw new TypeError("Explicit DOM imports require the exact validated dom@1 embedder capability");
  }
  if (imports.some(({ name }) => isDomInteractionImportName(name)) !== interactionSelected) {
    throw new TypeError("DOM interaction imports require the exact validated dom-interaction@1 capability");
  }
  return true;
}

/** True only after the companion interaction provider survived exact validation. */
export function requiresExactDomInteractionCapabilityAdapter(
  capabilities: readonly { readonly id: string; readonly selectedProviders: readonly string[] }[],
): boolean {
  return capabilities.some(
    ({ id, selectedProviders }) => id === DOM_INTERACTION_CAPABILITY_ID && selectedProviders.includes("embedder"),
  );
}

const DOM_CAPABILITY_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  "Document_createElement:Document:method:createElement:3",
  "Document_get_body:Document:get:body:1",
  "Element_set_innerHTML:Element:set:innerHTML:2",
  "Element_set_textContent:Element:set:textContent:2",
  "CSSStyleDeclaration_set_cssText:CSSStyleDeclaration:set:cssText:2",
  "HTMLElement_get_style:HTMLElement:get:style:1",
  "Node_appendChild:Node:method:appendChild:2",
]);

const DOM_INTERACTION_DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  "HTMLElement_addEventListener:HTMLElement:method:addEventListener:4",
  "CSSStyleDeclaration_set_background:CSSStyleDeclaration:set:background:2",
]);

/** Collision-safe, compiler-owned native-string readout used only by dom@1. */
export const DOM_STRING_PREPARE_EXPORT = "__\0js2_dom_string_prepare";
export const DOM_STRING_PREPARE_PHYSICAL_BASE = "$dp";
export const DOM_STRING_CHAR_EXPORT = "__\0js2_dom_string_char";
export const DOM_STRING_CHAR_PHYSICAL_BASE = "$dc";
/** Optional exact arity-zero dispatcher published only for DOM interaction. */
export const DOM_CALLBACK_DISPATCH_EXPORT = "__\0js2_dom_callback_dispatch";
export const DOM_CALLBACK_DISPATCH_PHYSICAL_BASE = "$dd";
/** Private trailing carrier field whose singleton value authenticates DOM callbacks. */
export const DOM_CALLBACK_AUTHORITY_FIELD = "$domCallbackAuthority";
export const DOM_STRING_MANIFEST_EXPORT = "__\0js2_dom_string_manifest";
export const DOM_STRING_MANIFEST_PHYSICAL_BASE = "$dx";
export const DOM_STRING_MARKER_EXPORT = "__\0js2_dom_string_marker";
export const DOM_STRING_MARKER_PHYSICAL_BASE = "$dy";
export const DOM_STRING_BINDINGS_EXPORT = "__\0js2_dom_string_bindings";
export const DOM_STRING_BINDINGS_PHYSICAL_BASE = "$dz";
export const DOM_STRING_MANIFEST_MAGIC = 0x5a600001;
