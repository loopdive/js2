import { JSDOM } from "jsdom";

// React's upstream tests expect the browser globals that Jest installs through
// jsdom.  Keep this list explicit: copying every property from `window` would
// overwrite Node's process/timer globals and make the native oracle differ
// from the host used by the compiler.
const DOM_GLOBALS = [
  "window",
  "self",
  "document",
  "navigator",
  "location",
  "history",
  "Node",
  "NodeList",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLDocument",
  "Document",
  "HTMLHtmlElement",
  "HTMLHeadElement",
  "HTMLBodyElement",
  "HTMLAppletElement",
  "HTMLAreaElement",
  "HTMLBRElement",
  "HTMLBaseElement",
  "HTMLDListElement",
  "HTMLDataElement",
  "HTMLDataListElement",
  "HTMLDetailsElement",
  "HTMLDialogElement",
  "HTMLDivElement",
  "HTMLAnchorElement",
  "HTMLFieldSetElement",
  "HTMLHRElement",
  "HTMLHeadingElement",
  "HTMLImageElement",
  "HTMLLinkElement",
  "HTMLMapElement",
  "HTMLMediaElement",
  "HTMLMenuElement",
  "HTMLMetaElement",
  "HTMLModElement",
  "HTMLAudioElement",
  "HTMLVideoElement",
  "HTMLObjectElement",
  "HTMLEmbedElement",
  "HTMLParamElement",
  "HTMLTableElement",
  "HTMLTableCaptionElement",
  "HTMLTableCellElement",
  "HTMLTableColElement",
  "HTMLTableRowElement",
  "HTMLTableSectionElement",
  "HTMLOptGroupElement",
  "HTMLOutputElement",
  "HTMLPictureElement",
  "HTMLUListElement",
  "HTMLOListElement",
  "HTMLLIElement",
  "HTMLParagraphElement",
  "HTMLPreElement",
  "HTMLQuoteElement",
  "HTMLLegendElement",
  "HTMLProgressElement",
  "HTMLMeterElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "HTMLSpanElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLIFrameElement",
  "HTMLOptionElement",
  "HTMLTemplateElement",
  "HTMLSlotElement",
  "HTMLSourceElement",
  "HTMLTimeElement",
  "HTMLCanvasElement",
  "HTMLStyleElement",
  "HTMLScriptElement",
  "HTMLUnknownElement",
  "HTMLTitleElement",
  "HTMLTrackElement",
  "SVGElement",
  "SVGSVGElement",
  "ShadowRoot",
  "ElementInternals",
  "EventTarget",
  "CustomElementRegistry",
  "customElements",
  "DOMRect",
  "DOMRectReadOnly",
  "CSSStyleSheet",
  "CSSStyleDeclaration",
  "Text",
  "Comment",
  "DocumentFragment",
  "DocumentType",
  "Event",
  "ErrorEvent",
  "CustomEvent",
  "ProgressEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "TouchEvent",
  "FocusEvent",
  "InputEvent",
  "CompositionEvent",
  "UIEvent",
  "WheelEvent",
  "MutationObserver",
  "IntersectionObserver",
  "Range",
  "Selection",
  "TreeWalker",
  "DOMParser",
  "XMLSerializer",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  // Node supplies these in the test process while jsdom supplies the DOM
  // constructors. Use whichever side implements the standard global.
  "MessageChannel",
  "MessagePort",
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "Blob",
  "File",
  "FileReader",
  "FileList",
  "DataTransfer",
  "AbortController",
  "AbortSignal",
];

export function installReactTestEnvironment() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const previous = new Map();
  for (const name of DOM_GLOBALS) {
    const value = name === "window" || name === "self" ? window : (window[name] ?? globalThis[name]);
    if (value === undefined) continue;
    previous.set(name, { present: Object.hasOwn(globalThis, name), value: globalThis[name] });
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // React's act() warning gate is part of the upstream test environment.  It
  // is deliberately a host setup value, not a compiler result.
  const previousActEnvironment = {
    present: Object.hasOwn(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
    value: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    dom,
    cleanup() {
      dom.window.close();
      for (const [name, state] of previous) {
        if (state.present)
          Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: state.value });
        else delete globalThis[name];
      }
      if (previousActEnvironment.present) globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment.value;
      else delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}
