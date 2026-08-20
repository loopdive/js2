// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  DOM_STRING_BINDINGS_EXPORT,
  DOM_STRING_BINDINGS_PHYSICAL_BASE,
  DOM_STRING_CHAR_EXPORT,
  DOM_STRING_CHAR_PHYSICAL_BASE,
  DOM_STRING_MANIFEST_EXPORT,
  DOM_STRING_MANIFEST_MAGIC,
  DOM_STRING_MANIFEST_PHYSICAL_BASE,
  DOM_STRING_MARKER_EXPORT,
  DOM_STRING_MARKER_PHYSICAL_BASE,
  DOM_STRING_PREPARE_EXPORT,
  DOM_STRING_PREPARE_PHYSICAL_BASE,
  isDomCapabilityDescriptorCandidate,
  isDomCapabilityImportDescriptor,
} from "../dom-capability-contract.js";
import type { ImportDescriptor } from "../index.js";
import { createDomCapabilityAdapter } from "./dom-capability-adapter.js";

export type { DomCapabilityRoot } from "./dom-capability-adapter.js";

export interface StandaloneDomStringState {
  readonly getExports: () => Record<string, Function> | undefined;
}

export interface StandaloneDomStringBridge {
  recordExportView(
    rawExports: Record<string, any>,
    finalExports: Record<string, any>,
    mayEstablishAuthority: boolean,
  ): void;
  bindCallbackState(callbackState: StandaloneDomStringState): void;
  /** Bind the exact document authority supplied to this import lifecycle. */
  bindCapabilityImport(globalDocument: Function, root: object | Function): void;
}

interface DomStringAuthority {
  readonly marker: WebAssembly.Table;
  readonly manifest: WebAssembly.Global;
  readonly bindings: WebAssembly.Table;
  readonly globalDocument: Function;
  readonly root: object | Function;
  readonly prepare: (value: unknown) => number;
  readonly char: (index: number) => number;
}

const reflectApply = Reflect.apply;
const objectHasOwnProperty = Object.prototype.hasOwnProperty;
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const arrayPush = Array.prototype.push;
const arrayJoin = Array.prototype.join;
const stringFromCharCode = String.fromCharCode;
const numberIsInteger = Number.isInteger;
const weakSetAdd = WeakSet.prototype.add;
const weakSetHas = WeakSet.prototype.has;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const weakMap = WeakMap;
const wasmGlobal = WebAssembly.Global;
const wasmTable = WebAssembly.Table;
const wasmModule = WebAssembly.Module;
const wasmInstance = WebAssembly.Instance;
const uint8Array = Uint8Array;
const uint8ArrayFrom = Uint8Array.from;
const tableGet = WebAssembly.Table.prototype.get;
const tableLengthGetter = Object.getOwnPropertyDescriptor(WebAssembly.Table.prototype, "length")?.get;
const globalValueGetter = Object.getOwnPropertyDescriptor(WebAssembly.Global.prototype, "value")?.get;
const immutableI32GlobalVerdict = new WeakSet<WebAssembly.Global>();
const exactFuncrefTableVerdicts = {
  0: new WeakSet<WebAssembly.Table>(),
  3: new WeakSet<WebAssembly.Table>(),
};
const exactFuncrefTableProbeModules: Partial<Record<0 | 3, WebAssembly.Module>> = {};
let immutableI32GlobalProbeModule: WebAssembly.Module | undefined;
const bridgeByCallbackState = new WeakMap<StandaloneDomStringState, (value: unknown) => string>();

function hasOwn(value: unknown, key: PropertyKey): boolean {
  return reflectApply(objectHasOwnProperty, value, [key]) as boolean;
}

function terminalAlias(exports: Record<string, any>, physicalBase: string): unknown {
  let name = physicalBase;
  let value: unknown;
  while (hasOwn(exports, name)) {
    value = exports[name];
    name += "$";
  }
  return value;
}

function isImmutableI32Global(value: unknown): value is WebAssembly.Global {
  try {
    if (!(value instanceof wasmGlobal)) return false;
    if (reflectApply(weakSetHas, immutableI32GlobalVerdict, [value])) return true;
    immutableI32GlobalProbeModule ??= new wasmModule(
      reflectApply(uint8ArrayFrom, uint8Array, [
        [0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 101, 1, 103, 3, 127, 0],
      ]) as Uint8Array<ArrayBuffer>,
    );
    new wasmInstance(immutableI32GlobalProbeModule, { e: { g: value } });
    reflectApply(weakSetAdd, immutableI32GlobalVerdict, [value]);
    return true;
  } catch {
    return false;
  }
}

function isExactFuncrefTable(value: unknown, size: 0 | 3): value is WebAssembly.Table {
  try {
    if (
      !(value instanceof wasmTable) ||
      typeof tableLengthGetter !== "function" ||
      reflectApply(tableLengthGetter, value, []) !== size
    ) {
      return false;
    }
    const verdict = exactFuncrefTableVerdicts[size];
    if (reflectApply(weakSetHas, verdict, [value])) return true;
    let probe = exactFuncrefTableProbeModules[size];
    if (!probe) {
      probe = new wasmModule(
        reflectApply(uint8ArrayFrom, uint8Array, [
          size === 0
            ? [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 0, 0]
            : [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 3, 3],
        ]) as Uint8Array<ArrayBuffer>,
      );
      exactFuncrefTableProbeModules[size] = probe;
    }
    new wasmInstance(probe, { e: { t: value } });
    reflectApply(weakSetAdd, verdict, [value]);
    return true;
  } catch {
    return false;
  }
}

function readAuthority(
  exports: Record<string, any>,
  expected: DomStringAuthority | undefined,
  expectedRoot: object | Function | undefined,
  mayEstablishAuthority: boolean,
): DomStringAuthority | undefined {
  if (!expectedRoot) return undefined;
  if (
    !hasOwn(exports, DOM_STRING_PREPARE_EXPORT) ||
    !hasOwn(exports, DOM_STRING_CHAR_EXPORT) ||
    !hasOwn(exports, DOM_STRING_MANIFEST_EXPORT) ||
    !hasOwn(exports, DOM_STRING_MARKER_EXPORT) ||
    !hasOwn(exports, DOM_STRING_BINDINGS_EXPORT)
  ) {
    return undefined;
  }

  const marker = terminalAlias(exports, DOM_STRING_MARKER_PHYSICAL_BASE);
  const manifest = terminalAlias(exports, DOM_STRING_MANIFEST_PHYSICAL_BASE);
  const bindings = terminalAlias(exports, DOM_STRING_BINDINGS_PHYSICAL_BASE);
  const rawPrepare = terminalAlias(exports, DOM_STRING_PREPARE_PHYSICAL_BASE);
  const rawChar = terminalAlias(exports, DOM_STRING_CHAR_PHYSICAL_BASE);
  if (
    !isExactFuncrefTable(marker, 0) ||
    !isImmutableI32Global(manifest) ||
    !isExactFuncrefTable(bindings, 3) ||
    typeof rawPrepare !== "function" ||
    typeof rawChar !== "function"
  ) {
    return undefined;
  }
  try {
    const globalDocument = reflectApply(tableGet, bindings, [0]);
    const manifestValue =
      typeof globalValueGetter === "function" ? reflectApply(globalValueGetter, manifest, []) : undefined;
    if (
      typeof manifestValue !== "number" ||
      (manifestValue | 0) !== DOM_STRING_MANIFEST_MAGIC ||
      typeof globalDocument !== "function" ||
      reflectApply(globalDocument, undefined, []) !== expectedRoot ||
      reflectApply(tableGet, bindings, [1]) !== rawPrepare ||
      reflectApply(tableGet, bindings, [2]) !== rawChar
    ) {
      return undefined;
    }
    if (expected) {
      return expected.marker === marker &&
        expected.manifest === manifest &&
        expected.bindings === bindings &&
        expected.globalDocument === globalDocument &&
        expected.root === expectedRoot &&
        expected.prepare === rawPrepare &&
        expected.char === rawChar
        ? expected
        : undefined;
    }
    return mayEstablishAuthority
      ? objectFreeze({
          marker,
          manifest,
          bindings,
          globalDocument,
          root: expectedRoot,
          prepare: rawPrepare as DomStringAuthority["prepare"],
          char: rawChar as DomStringAuthority["char"],
        })
      : undefined;
  } catch {
    return undefined;
  }
}

/** Own the authenticated string-reader authority for one buildImports lifecycle. */
export function createStandaloneDomStringBridge(): StandaloneDomStringBridge {
  let authority: DomStringAuthority | undefined;
  let expectedRoot: object | Function | undefined;
  const authorityByExportView = new weakMap<object, DomStringAuthority>();
  const cache = new weakMap<object, string>();

  return {
    recordExportView: (rawExports, finalExports, mayEstablishAuthority) => {
      const authenticated = readAuthority(rawExports, authority, expectedRoot, mayEstablishAuthority);
      if (!authenticated) return;
      authority ??= authenticated;
      reflectApply(weakMapSet, authorityByExportView, [finalExports, authenticated]);
    },
    bindCapabilityImport: (globalDocument, root) => {
      if (expectedRoot && expectedRoot !== root) {
        throw new TypeError("dom@1 native-string bridge root identity changed");
      }
      if (reflectApply(globalDocument, undefined, []) !== root) {
        throw new TypeError("dom@1 native-string bridge import returned the wrong root");
      }
      expectedRoot = root;
    },
    bindCallbackState: (callbackState) =>
      reflectApply(weakMapSet, bridgeByCallbackState, [
        callbackState,
        (value: unknown) => {
          if (typeof value === "string") return value;
          if ((typeof value !== "object" && typeof value !== "function") || value === null) {
            throw new TypeError("dom@1 expected a JavaScript or compiler-owned native string");
          }
          const exports = callbackState.getExports();
          const authenticated = exports
            ? (reflectApply(weakMapGet, authorityByExportView, [exports]) as DomStringAuthority | undefined)
            : undefined;
          if (!authenticated) throw new TypeError("dom@1 native-string bridge is not authenticated");
          const cached = reflectApply(weakMapGet, cache, [value]) as string | undefined;
          if (cached !== undefined) return cached;
          const length = reflectApply(authenticated.prepare, undefined, [value]);
          if (!reflectApply(numberIsInteger, undefined, [length]) || length < 0 || length > 0x7fffffff) {
            throw new TypeError("dom@1 rejected a non-string native carrier");
          }
          const chunks: string[] = [];
          const codeUnits: number[] = [];
          for (let index = 0; index < length; index++) {
            reflectApply(arrayPush, codeUnits, [reflectApply(authenticated.char, undefined, [index]) & 0xffff]);
            if (codeUnits.length === 8192) {
              reflectApply(arrayPush, chunks, [reflectApply(stringFromCharCode, String, codeUnits)]);
              codeUnits.length = 0;
            }
          }
          if (codeUnits.length > 0) {
            reflectApply(arrayPush, chunks, [reflectApply(stringFromCharCode, String, codeUnits)]);
          }
          const result = reflectApply(arrayJoin, chunks, [""]) as string;
          reflectApply(weakMapSet, cache, [value, result]);
          return result;
        },
      ]),
  };
}

/** Strict DOM boundary projection through the bridge bound to this lifecycle. */
export function standaloneDomStringToHost(value: unknown, callbackState: StandaloneDomStringState | undefined): string {
  if (typeof value === "string") return value;
  if (!callbackState) throw new TypeError("dom@1 native-string bridge is unavailable");
  const convert = reflectApply(weakMapGet, bridgeByCallbackState, [callbackState]) as
    | ((value: unknown) => string)
    | undefined;
  if (!convert) throw new TypeError("dom@1 native-string bridge is unavailable");
  return convert(value);
}

/** Complete explicit-dom runtime owned by one `buildImports` lifecycle. */
export interface StandaloneDomCapabilityRuntime {
  recordExportView(
    rawExports: Record<string, any>,
    finalExports: Record<string, any>,
    mayEstablishAuthority: boolean,
  ): void;
  bindCallbackState(callbackState: StandaloneDomStringState): void;
  bindImport(descriptor: ImportDescriptor): Function | undefined;
  recordWrappedImport(descriptor: ImportDescriptor, original: Function | undefined, wrapped: Function): void;
  finalizeImports(env: Readonly<Record<string, Function>>): void;
}

/** Compose the authenticated DOM imports with their native-string bridge. */
export function createStandaloneDomCapabilityRuntime(root: unknown): StandaloneDomCapabilityRuntime {
  const stringBridge = createStandaloneDomStringBridge();
  let callbackState: StandaloneDomStringState | undefined;
  let wrappedGlobalDocument: Function | undefined;
  // The host root may intentionally be shared by multiple independent
  // instances. Give each import lifecycle an opaque document handle so the
  // Wasm binding table authenticates this lifecycle, while the adapter keeps
  // containment and host method calls on the original root.
  const documentAuthority = objectFreeze(reflectApply(objectCreate, undefined, [null])) as object;
  const adapter = createDomCapabilityAdapter({
    root,
    documentAuthority,
    toHostString: (value) => standaloneDomStringToHost(value, callbackState),
  });
  const runtime: StandaloneDomCapabilityRuntime = {
    recordExportView: (rawExports, finalExports, mayEstablishAuthority) =>
      stringBridge.recordExportView(rawExports, finalExports, mayEstablishAuthority),
    bindCallbackState: (state) => {
      callbackState = state;
      stringBridge.bindCallbackState(state);
    },
    bindImport: (descriptor) => {
      const binding = adapter.bind(descriptor);
      if (
        isDomCapabilityDescriptorCandidate(descriptor) &&
        (!isDomCapabilityImportDescriptor(descriptor) || typeof binding !== "function")
      ) {
        throw new Error(`Explicit dom@1 adapter rejected the non-exact import descriptor env::${descriptor.name}`);
      }
      return binding;
    },
    recordWrappedImport: (descriptor, original, wrapped) => {
      if (descriptor.name !== "global_document") return;
      if (original !== adapter.imports.global_document || !isDomCapabilityImportDescriptor(descriptor)) {
        throw new Error("Explicit dom@1 adapter lost the exact global_document binding");
      }
      if (wrappedGlobalDocument && wrappedGlobalDocument !== wrapped) {
        throw new Error("Explicit dom@1 adapter changed the wrapped global_document binding");
      }
      wrappedGlobalDocument = wrapped;
    },
    finalizeImports: (env) => {
      const globalDocument = env.global_document;
      const authorityRoot = adapter.imports.global_document();
      if (
        globalDocument !== wrappedGlobalDocument ||
        authorityRoot === null ||
        (typeof authorityRoot !== "object" && typeof authorityRoot !== "function")
      ) {
        throw new Error("Explicit dom@1 adapter lost its authenticated global_document import or root");
      }
      stringBridge.bindCapabilityImport(globalDocument, authorityRoot);
    },
  };
  return Object.freeze(runtime);
}
