// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { JavaScriptAdapterManifestV1 } from "../adapter-manifest.js";
import { ASYNC_CALLBACK_EXCEPTION_POLICY } from "../ir/async-runtime-providers.js";
import {
  STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT,
  STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT,
  STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT,
  STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC,
  STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_MARKER_EXPORT,
  STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE,
} from "../timer-capability-contract.js";
import { installNativeFunctionSourceFacade, normalizeModuleCallbackException } from "./native-function-source.js";

export interface StandaloneTimerCallbackState {
  readonly getExports: () => Record<string, Function> | undefined;
}

export interface StandaloneTimerCallbackBridge {
  /** Authenticate one raw record, then associate its final composed view. */
  recordExportView(
    rawExports: Record<string, any>,
    finalExports: Record<string, any>,
    mayEstablishAuthority: boolean,
  ): void;
  /** Bind the bridge without adding mutable or discoverable state to the lifecycle object. */
  bindCallbackState(callbackState: StandaloneTimerCallbackState, wrapGenericClosure: GenericClosureWrapper): void;
}

interface TimerCallbackBridgeAuthority {
  readonly marker: WebAssembly.Table;
  readonly manifest: WebAssembly.Global;
  readonly bindings: WebAssembly.Table;
  readonly dispatch: Function;
}

type GenericClosureWrapper = (value: unknown, arity: number) => ((...args: any[]) => any) | null;

interface BoundTimerCallbackBridge {
  wrapCallback(closure: unknown): ((...args: any[]) => any) | null;
}

const reflectApply = Reflect.apply;
const objectHasOwnProperty = Object.prototype.hasOwnProperty;
const immutableI32GlobalVerdict = new WeakSet<WebAssembly.Global>();
const exactFuncrefTableVerdicts = {
  0: new WeakSet<WebAssembly.Table>(),
  1: new WeakSet<WebAssembly.Table>(),
};
const exactFuncrefTableProbeModules: Partial<Record<0 | 1, WebAssembly.Module>> = {};
let immutableI32GlobalProbeModule: WebAssembly.Module | undefined;
const bridgeByCallbackState = new WeakMap<StandaloneTimerCallbackState, BoundTimerCallbackBridge>();
const drainingTimerDispatchers = new WeakSet<object>();

function hasOwn(value: unknown, key: PropertyKey): boolean {
  return reflectApply(objectHasOwnProperty, value, [key]) as boolean;
}

function terminalAlias(exports: Record<string, any>, physicalBase: string): unknown {
  let physicalName = physicalBase;
  let helper: unknown;
  while (hasOwn(exports, physicalName)) {
    helper = exports[physicalName];
    physicalName += "$";
  }
  return helper;
}

function isImmutableI32Global(value: unknown): value is WebAssembly.Global {
  if (!(value instanceof WebAssembly.Global)) return false;
  if (immutableI32GlobalVerdict.has(value)) return true;
  try {
    immutableI32GlobalProbeModule ??= new WebAssembly.Module(
      Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 101, 1, 103, 3, 127, 0]),
    );
    new WebAssembly.Instance(immutableI32GlobalProbeModule, { e: { g: value } });
    immutableI32GlobalVerdict.add(value);
    return true;
  } catch {
    return false;
  }
}

function isExactFuncrefTable(value: unknown, size: 0 | 1): value is WebAssembly.Table {
  try {
    if (!(value instanceof WebAssembly.Table) || value.length !== size) return false;
    const verdict = exactFuncrefTableVerdicts[size];
    if (verdict.has(value)) return true;
    let probe = exactFuncrefTableProbeModules[size];
    if (!probe) {
      probe = new WebAssembly.Module(
        Uint8Array.from(
          size === 0
            ? [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 0, 0]
            : [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 1, 1],
        ),
      );
      exactFuncrefTableProbeModules[size] = probe;
    }
    new WebAssembly.Instance(probe, { e: { t: value } });
    verdict.add(value);
    return true;
  } catch {
    return false;
  }
}

function readAuthority(
  exports: Record<string, any>,
  expectedAuthority: TimerCallbackBridgeAuthority | undefined,
  mayEstablishAuthority: boolean,
): TimerCallbackBridgeAuthority | undefined {
  if (!hasOwn(exports, STANDALONE_TIMER_CALLBACK_MARKER_EXPORT)) return undefined;
  const marker = terminalAlias(exports, STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE);
  if (!isExactFuncrefTable(marker, 0)) return undefined;

  if (!hasOwn(exports, STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT)) return undefined;
  const manifest = terminalAlias(exports, STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE);
  if (
    !isImmutableI32Global(manifest) ||
    typeof manifest.value !== "number" ||
    (manifest.value | 0) !== STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC
  ) {
    return undefined;
  }

  if (!hasOwn(exports, STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT)) return undefined;
  const bindings = terminalAlias(exports, STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE);
  if (!isExactFuncrefTable(bindings, 1)) return undefined;

  if (!hasOwn(exports, STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT)) return undefined;
  const dispatch = terminalAlias(exports, STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE);
  if (typeof dispatch !== "function") return undefined;
  try {
    if (bindings.get(0) !== dispatch) return undefined;
  } catch {
    return undefined;
  }

  if (expectedAuthority) {
    return expectedAuthority.marker === marker &&
      expectedAuthority.manifest === manifest &&
      expectedAuthority.bindings === bindings &&
      expectedAuthority.dispatch === dispatch
      ? expectedAuthority
      : undefined;
  }
  // A raw export record can borrow genuine values from a donor instance. Only
  // the branded setInstance path may establish this import object's authority.
  return mayEstablishAuthority ? Object.freeze({ marker, manifest, bindings, dispatch }) : undefined;
}

function drainTimerMicrotasks(callbackState: StandaloneTimerCallbackState, dispatch: Function): void {
  const drain = callbackState.getExports()?.__drain_microtasks as (() => void) | undefined;
  if (typeof drain !== "function" || drainingTimerDispatchers.has(dispatch)) return;
  drainingTimerDispatchers.add(dispatch);
  try {
    drain();
  } finally {
    drainingTimerDispatchers.delete(dispatch);
  }
}

/** Own authentication and callback dispatch for one buildImports lifecycle. */
export function createStandaloneTimerCallbackBridge(): StandaloneTimerCallbackBridge {
  let authority: TimerCallbackBridgeAuthority | undefined;
  const dispatchByExportView = new WeakMap<object, Function>();
  const wrapCallback = (
    closure: unknown,
    callbackState: StandaloneTimerCallbackState,
    wrapGenericClosure: GenericClosureWrapper,
  ): ((...args: any[]) => any) => {
    let genericFallback: ((...args: any[]) => any) | null | undefined;
    const wrapped = function wasmStandaloneTimerCallback(this: any, ...args: any[]): any {
      try {
        const exports = callbackState.getExports();
        const dispatch = exports ? dispatchByExportView.get(exports) : undefined;
        if (dispatch) {
          const result = dispatch(closure);
          drainTimerMicrotasks(callbackState, dispatch);
          return result;
        }
        genericFallback ??= wrapGenericClosure(closure, 0);
        if (!genericFallback) throw new TypeError("standalone timer callback dispatcher is not available");
        return reflectApply(genericFallback, this, args);
      } catch (error) {
        throw normalizeModuleCallbackException(error, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
      }
    };
    return installNativeFunctionSourceFacade(wrapped);
  };

  return {
    recordExportView: (rawExports, finalExports, mayEstablishAuthority) => {
      const authenticated = readAuthority(rawExports, authority, mayEstablishAuthority);
      if (!authenticated) return;
      authority ??= authenticated;
      dispatchByExportView.set(finalExports, authenticated.dispatch);
    },
    bindCallbackState: (callbackState, wrapGenericClosure) =>
      bridgeByCallbackState.set(callbackState, {
        wrapCallback: (closure) => wrapCallback(closure, callbackState, wrapGenericClosure),
      }),
  };
}

/** Wrap a timer boundary through the bridge bound to this lifecycle state. */
export function wrapStandaloneTimerCallback(
  closure: unknown,
  callbackState: StandaloneTimerCallbackState | undefined,
): ((...args: any[]) => any) | null {
  if (!callbackState) return null;
  return bridgeByCallbackState.get(callbackState)?.wrapCallback(closure) ?? null;
}

const TIMER_EMBEDDER_DEPENDENCY_BY_IMPORT: Readonly<Record<string, string>> = Object.freeze({
  __timer_set_timeout: "setTimeout",
  __timer_set_interval: "setInterval",
  __timer_clear_timeout: "clearTimeout",
  __timer_clear_interval: "clearInterval",
});

/** Fail closed when an explicit standalone capability has no required embedder binding. */
export function assertExplicitEmbedderCapabilityBindings(
  manifest: JavaScriptAdapterManifestV1,
  deps: Record<string, any> | undefined,
): void {
  for (const requirement of manifest.capabilities) {
    if (!requirement.selectedProviders.includes("embedder") || requirement.id !== "timers") continue;
    for (const entry of requirement.imports) {
      const dependencyName = TIMER_EMBEDDER_DEPENDENCY_BY_IMPORT[entry.name];
      if (!dependencyName || typeof deps?.[dependencyName] !== "function") {
        throw new Error(
          `Explicit embedder capability '${requirement.id}' requires deps.${dependencyName ?? entry.name} for ` +
            `'${entry.module}::${entry.name}'`,
        );
      }
    }
  }
}
