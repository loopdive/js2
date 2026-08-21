// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  DOM_CALLBACK_DISPATCH_EXPORT,
  DOM_CALLBACK_DISPATCH_PHYSICAL_BASE,
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
  isDomInteractionImportDescriptor,
} from "../dom-capability-contract.js";
import type { ImportDescriptor } from "../index.js";
import { createDomCapabilityAdapter } from "./dom-capability-adapter.js";

export type { DomCapabilityRoot } from "./dom-capability-adapter.js";

export interface StandaloneDomStringState {
  readonly getExports: () => Record<string, unknown> | undefined;
}

export interface StandaloneDomStringBridge {
  recordExportView(
    rawExports: Record<string, unknown>,
    finalExports: Record<string, unknown>,
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
  readonly dispatch?: (packedClosure: unknown) => void;
}

export interface StandaloneDomStringBridgeOptions {
  /** Require the exact four-slot DOM-interaction boundary. Base dom@1 is three-slot only. */
  readonly interaction?: boolean;
}

const reflectApply = Reflect.apply;
const objectHasOwnProperty = Object.prototype.hasOwnProperty;
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectIsExtensible = Object.isExtensible;
const reflectOwnKeys = Reflect.ownKeys;
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
  4: new WeakSet<WebAssembly.Table>(),
};
const exactFuncrefTableProbeModules: Partial<Record<0 | 3 | 4, WebAssembly.Module>> = {};
let immutableI32GlobalProbeModule: WebAssembly.Module | undefined;

interface BoundDomBridge {
  readonly toHostString: (value: unknown) => string;
  readonly wrapCallback: (packedClosure: unknown) => Function;
}

const bridgeByCallbackState = new WeakMap<StandaloneDomStringState, BoundDomBridge>();

function hasOwn(value: unknown, key: PropertyKey): boolean {
  return reflectApply(objectHasOwnProperty, value, [key]) as boolean;
}

function terminalAlias(exports: Record<string, unknown>, physicalBase: string): unknown {
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

function isExactFuncrefTable(value: unknown, size: 0 | 3 | 4): value is WebAssembly.Table {
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
            : [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, size, size],
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
  exports: Record<string, unknown>,
  expected: DomStringAuthority | undefined,
  expectedRoot: object | Function | undefined,
  mayEstablishAuthority: boolean,
  interaction: boolean,
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
  const bindingSize = interaction
    ? isExactFuncrefTable(bindings, 4)
      ? 4
      : undefined
    : isExactFuncrefTable(bindings, 3)
      ? 3
      : undefined;
  if (
    !isExactFuncrefTable(marker, 0) ||
    !isImmutableI32Global(manifest) ||
    bindingSize === undefined ||
    typeof rawPrepare !== "function" ||
    typeof rawChar !== "function"
  ) {
    return undefined;
  }
  try {
    const globalDocument = reflectApply(tableGet, bindings, [0]);
    const dispatch = bindingSize === 4 ? reflectApply(tableGet, bindings, [3]) : undefined;
    const exportedDispatch =
      bindingSize === 4 && hasOwn(exports, DOM_CALLBACK_DISPATCH_EXPORT)
        ? terminalAlias(exports, DOM_CALLBACK_DISPATCH_PHYSICAL_BASE)
        : undefined;
    const manifestValue =
      typeof globalValueGetter === "function" ? reflectApply(globalValueGetter, manifest, []) : undefined;
    if (
      typeof manifestValue !== "number" ||
      (manifestValue | 0) !== DOM_STRING_MANIFEST_MAGIC ||
      typeof globalDocument !== "function" ||
      reflectApply(globalDocument, undefined, []) !== expectedRoot ||
      reflectApply(tableGet, bindings, [1]) !== rawPrepare ||
      reflectApply(tableGet, bindings, [2]) !== rawChar ||
      (bindingSize === 4 && (typeof dispatch !== "function" || exportedDispatch !== dispatch))
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
        expected.char === rawChar &&
        expected.dispatch === dispatch
        ? expected
        : undefined;
    }
    return mayEstablishAuthority
      ? objectFreeze({
          marker,
          manifest,
          bindings: bindings as WebAssembly.Table,
          globalDocument,
          root: expectedRoot,
          prepare: rawPrepare as DomStringAuthority["prepare"],
          char: rawChar as DomStringAuthority["char"],
          ...(dispatch === undefined ? {} : { dispatch: dispatch as DomStringAuthority["dispatch"] }),
        })
      : undefined;
  } catch {
    return undefined;
  }
}

function isOpaqueWasmCarrier(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  try {
    return (
      reflectApply(objectGetPrototypeOf, Object, [value]) === null &&
      reflectApply(objectIsExtensible, Object, [value]) === false &&
      (reflectApply(reflectOwnKeys, Reflect, [value]) as PropertyKey[]).length === 0
    );
  } catch {
    return false;
  }
}

function hasIntactBindings(authority: DomStringAuthority): boolean {
  try {
    const expectedSize = authority.dispatch === undefined ? 3 : 4;
    return (
      isExactFuncrefTable(authority.bindings, expectedSize) &&
      reflectApply(tableGet, authority.bindings, [0]) === authority.globalDocument &&
      reflectApply(tableGet, authority.bindings, [1]) === authority.prepare &&
      reflectApply(tableGet, authority.bindings, [2]) === authority.char &&
      (expectedSize === 3 || reflectApply(tableGet, authority.bindings, [3]) === authority.dispatch)
    );
  } catch {
    return false;
  }
}

/** Own authenticated string and reusable callback authority for one import lifecycle. */
export function createStandaloneDomStringBridge(
  options: StandaloneDomStringBridgeOptions = {},
): StandaloneDomStringBridge {
  const interaction = options.interaction === true;
  let authority: DomStringAuthority | undefined;
  let expectedRoot: object | Function | undefined;
  const authorityByExportView = new weakMap<object, DomStringAuthority>();
  const stringCache = new weakMap<object, string>();
  const callbackCache = new weakMap<object, Function>();

  return {
    recordExportView: (rawExports, finalExports, mayEstablishAuthority) => {
      const authenticated = readAuthority(rawExports, authority, expectedRoot, mayEstablishAuthority, interaction);
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
    bindCallbackState: (callbackState) => {
      const bound: BoundDomBridge = objectFreeze({
        toHostString: (value: unknown) => {
          if (typeof value === "string") return value;
          if ((typeof value !== "object" && typeof value !== "function") || value === null) {
            throw new TypeError("dom@1 expected a JavaScript or compiler-owned native string");
          }
          const exports = callbackState.getExports();
          const authenticated = exports
            ? (reflectApply(weakMapGet, authorityByExportView, [exports]) as DomStringAuthority | undefined)
            : undefined;
          if (!authenticated || !hasIntactBindings(authenticated)) {
            throw new TypeError("dom@1 native-string bridge is not authenticated");
          }
          const cached = reflectApply(weakMapGet, stringCache, [value]) as string | undefined;
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
          reflectApply(weakMapSet, stringCache, [value, result]);
          return result;
        },
        wrapCallback: (packedClosure: unknown) => {
          if (!interaction) {
            throw new TypeError("base dom@1 cannot bind callback authority");
          }
          if (!isOpaqueWasmCarrier(packedClosure)) {
            throw new TypeError("dom-interaction@1 rejected a non-closure callback carrier");
          }
          const cached = reflectApply(weakMapGet, callbackCache, [packedClosure]) as Function | undefined;
          if (cached) return cached;
          const wrapped = function wasmStandaloneDomCallback(): undefined {
            const exports = callbackState.getExports();
            const authenticated = exports
              ? (reflectApply(weakMapGet, authorityByExportView, [exports]) as DomStringAuthority | undefined)
              : undefined;
            if (!authenticated?.dispatch || !hasIntactBindings(authenticated)) {
              throw new TypeError("dom-interaction@1 callback dispatcher is not authenticated");
            }
            reflectApply(authenticated.dispatch, undefined, [packedClosure]);
            return undefined;
          };
          reflectApply(weakMapSet, callbackCache, [packedClosure, wrapped]);
          return wrapped;
        },
      });
      reflectApply(weakMapSet, bridgeByCallbackState, [callbackState, bound]);
    },
  };
}

/** Strict DOM boundary projection through the bridge bound to this lifecycle. */
export function standaloneDomStringToHost(value: unknown, callbackState: StandaloneDomStringState | undefined): string {
  if (typeof value === "string") return value;
  if (!callbackState) throw new TypeError("dom@1 native-string bridge is unavailable");
  const bridge = reflectApply(weakMapGet, bridgeByCallbackState, [callbackState]) as BoundDomBridge | undefined;
  if (!bridge) throw new TypeError("dom@1 native-string bridge is unavailable");
  return bridge.toHostString(value);
}

/** Wrap an opaque compiled closure through this lifecycle's authenticated slot-three dispatcher. */
export function wrapStandaloneDomCallback(
  packedClosure: unknown,
  callbackState: StandaloneDomStringState | undefined,
): Function {
  if (!callbackState) throw new TypeError("dom-interaction@1 callback bridge is unavailable");
  const bridge = reflectApply(weakMapGet, bridgeByCallbackState, [callbackState]) as BoundDomBridge | undefined;
  if (!bridge) throw new TypeError("dom-interaction@1 callback bridge is unavailable");
  return bridge.wrapCallback(packedClosure);
}

/** Complete explicit-dom runtime owned by one `buildImports` lifecycle. */
export interface StandaloneDomCapabilityRuntime {
  recordExportView(
    rawExports: Record<string, unknown>,
    finalExports: Record<string, unknown>,
    mayEstablishAuthority: boolean,
  ): void;
  bindCallbackState(callbackState: StandaloneDomStringState): void;
  bindImport(descriptor: ImportDescriptor): Function | undefined;
  recordWrappedImport(descriptor: ImportDescriptor, original: Function | undefined, wrapped: Function): void;
  finalizeImports(env: Readonly<Record<string, Function>>): void;
}

export interface StandaloneDomCapabilityRuntimeOptions {
  /** Enable only when the validated DOM-interaction capability owns its exact two imports. */
  readonly interaction?: boolean;
}

/** Compose the authenticated DOM imports with their native-string bridge. */
export function createStandaloneDomCapabilityRuntime(
  root: unknown,
  options: StandaloneDomCapabilityRuntimeOptions = {},
): StandaloneDomCapabilityRuntime {
  const stringBridge = createStandaloneDomStringBridge({ interaction: options.interaction === true });
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
    ...(options.interaction
      ? { interaction: { wrapCallback: (value: unknown) => wrapStandaloneDomCallback(value, callbackState) } }
      : {}),
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
      const exactInteraction = options.interaction === true && isDomInteractionImportDescriptor(descriptor);
      if (
        isDomCapabilityDescriptorCandidate(descriptor) &&
        ((!isDomCapabilityImportDescriptor(descriptor) && !exactInteraction) || typeof binding !== "function")
      ) {
        throw new Error(
          `Explicit DOM capability adapter rejected the non-exact import descriptor env::${descriptor.name}`,
        );
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
