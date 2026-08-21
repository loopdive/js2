// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportIntent } from "../index.js";
import { resolveClockCapabilityImport, type ClockCapabilityImport } from "./clock-capability-adapter.js";
import { resolveTimerCapabilityImport } from "./timer-capability-adapter.js";

/** Per-instance state owned by the Web Storage capability adapter. */
export interface PlatformCapabilityInstanceState {
  webStorage: { local?: unknown; session?: unknown };
}

/**
 * Narrow services the platform-capability binder needs from the value adapter.
 * Platform resolution owns ambient/dependency lookup; callable conversion stays
 * with the JS/Wasm boundary because only that layer understands Wasm closures.
 */
export interface PlatformCapabilityAdapterContext {
  deps?: Record<string, any>;
  explicitClockImport?: ClockCapabilityImport;
  globalSandbox?: Record<string, any>;
  instanceState?: PlatformCapabilityInstanceState;
  getNodeRequire(): ((id: string) => any) | undefined;
  wrapWasmClosure(value: unknown, arity: number, boundary?: "timer"): ((...args: any[]) => any) | null;
  wrapUnknownCallable(value: unknown): unknown;
}

function makeWebStoragePolyfill(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      const normalized = String(key);
      return store.has(normalized) ? store.get(normalized)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(String(key), String(value));
    },
    removeItem(key: string): void {
      store.delete(String(key));
    },
    key(index: number): string | null {
      const normalized = Number(index);
      if (!Number.isFinite(normalized) || normalized < 0) return null;
      let current = 0;
      for (const key of store.keys()) {
        if (current === normalized) return key;
        current++;
      }
      return null;
    },
  };
}

function makeNodeBuiltinFunctionAdapter(
  moduleName: string,
  functionName: string,
  raw: (...args: any[]) => any,
  context: PlatformCapabilityAdapterContext,
): Function {
  if (moduleName === "crypto" && functionName === "randomBytes") {
    return (length: number) => {
      const output = raw(length);
      if (output instanceof Uint8Array) return output;
      if (output && typeof output.length === "number") {
        return new Uint8Array(output.buffer ?? output, output.byteOffset ?? 0, output.length);
      }
      return new Uint8Array(0);
    };
  }
  return (...args: any[]) => raw(...args.map((arg) => context.wrapUnknownCallable(arg)));
}

let warnedNodeBuiltinFallback = false;

function makeNodeBuiltinFunctionFallback(moduleName: string, functionName: string): Function {
  return (...args: any[]) => {
    if (!warnedNodeBuiltinFallback) {
      warnedNodeBuiltinFallback = true;
      console.warn(
        `[js2wasm] node:${moduleName}.${functionName} called without a host runtime — ` +
          `using Math.random fallback (NOT cryptographically secure). ` +
          `Provide a deps override or run under Node/Browser with crypto support.`,
      );
    }
    if (moduleName === "crypto" && functionName === "randomBytes") {
      const length = Number(args[0] ?? 0);
      const output = new Uint8Array(Math.max(0, length | 0));
      for (let index = 0; index < output.length; index++) output[index] = Math.floor(Math.random() * 256);
      return output;
    }
    if (moduleName === "crypto" && functionName === "randomUUID") {
      const hex = "0123456789abcdef";
      const randomHex = (): string => hex[Math.floor(Math.random() * 16)]!;
      let value = "";
      for (let index = 0; index < 36; index++) {
        if (index === 8 || index === 13 || index === 18 || index === 23) value += "-";
        else if (index === 14) value += "4";
        else if (index === 19) value += hex[(Math.floor(Math.random() * 16) & 0x3) | 0x8]!;
        else value += randomHex();
      }
      return value;
    }
    return undefined;
  };
}

const builtinJsxTypeof: symbol | number = typeof Symbol === "function" ? Symbol.for("react.element") : 0xeac7;
const builtinFragment: symbol | object =
  typeof Symbol === "function" ? Symbol.for("react.fragment") : { __jsx_fragment: true };

function resolveConsole(variant: string, deps?: Record<string, any>): Function {
  const supplied: Record<string, any> = deps?.console ?? console;
  let method = "log";
  let booleanValue = variant === "bool";
  for (const candidate of ["warn", "error", "info", "debug", "log"] as const) {
    if (variant.startsWith(`${candidate}_`)) {
      method = candidate;
      booleanValue = variant === `${candidate}_bool`;
      break;
    }
  }
  const write = (value: unknown): void => {
    const fallback = console as unknown as Record<string, any>;
    const target = typeof supplied[method] === "function" ? supplied : fallback;
    (target[method] as (...args: any[]) => void).call(target, value);
  };
  return booleanValue ? (value: number) => write(Boolean(value)) : (value: unknown) => write(value);
}

/**
 * Resolve typed platform capabilities and named host accelerators. Returning
 * `undefined` means the intent belongs to value/lifecycle or compatibility
 * semantics and must be handled by another adapter.
 */
export function resolvePlatformCapabilityImport(
  intent: ImportIntent,
  context: PlatformCapabilityAdapterContext,
): Function | undefined {
  const deps = context.deps;
  switch (intent.type) {
    case "math":
      return (Math as any)[intent.method];
    case "console_log":
      return resolveConsole(intent.variant, deps);
    case "dynamic_import":
      return (specifier: unknown) => import(/* @vite-ignore */ specifier as string);
    case "date_now":
      return resolveClockCapabilityImport(context.explicitClockImport);
    case "declared_global": {
      const dependency = deps?.[intent.name];
      if (dependency !== undefined) return () => dependency;
      const globals = context.globalSandbox ?? (globalThis as any);
      if (intent.name === "globalThis") return () => globals;
      const ambient = globals[intent.name];
      return ambient !== undefined ? () => ambient : () => {};
    }
    case "node_builtin": {
      const dependency = deps?.[intent.moduleName];
      if (dependency !== undefined) return () => dependency;
      const requireNode = context.getNodeRequire();
      if (!requireNode) return () => {};
      try {
        const module = requireNode(intent.moduleName);
        return () => module;
      } catch {
        return () => {};
      }
    }
    case "web_storage": {
      const which = intent.which;
      return () => {
        const state = context.instanceState?.webStorage;
        const cached = state?.[which];
        if (cached !== undefined) return cached;
        const dependencyName = which === "local" ? "localStorage" : "sessionStorage";
        const supplied = deps?.[dependencyName];
        if (supplied !== undefined) {
          if (state) state[which] = supplied;
          return supplied;
        }
        const ambient = (globalThis as any)?.[dependencyName];
        if (ambient != null) {
          if (state) state[which] = ambient;
          return ambient;
        }
        const polyfill = makeWebStoragePolyfill();
        if (state) state[which] = polyfill;
        return polyfill;
      };
    }
    case "timer_set":
    case "timer_clear":
      return resolveTimerCapabilityImport(intent, context);
    case "node_dirname":
      return () => (deps && deps.__dirname !== undefined ? deps.__dirname : (globalThis as any).__dirname);
    case "node_filename":
      return () => (deps && deps.__filename !== undefined ? deps.__filename : (globalThis as any).__filename);
    case "node_import_meta_url":
      return () => deps?.importMetaUrl;
    case "node_builtin_fn": {
      const moduleName = intent.moduleName;
      const functionName = intent.name;
      const dependency = deps?.[moduleName] as Record<string, unknown> | undefined;
      if (dependency && typeof dependency[functionName] === "function") {
        return makeNodeBuiltinFunctionAdapter(
          moduleName,
          functionName,
          (dependency[functionName] as Function).bind(dependency),
          context,
        );
      }
      const requireNode = context.getNodeRequire();
      if (requireNode) {
        try {
          const module = requireNode(moduleName);
          const raw = module?.[functionName];
          if (typeof raw === "function") {
            return makeNodeBuiltinFunctionAdapter(moduleName, functionName, raw.bind(module), context);
          }
        } catch {
          // Continue to browser/fallback providers.
        }
      }
      const crypto = (globalThis as any)?.crypto;
      if (moduleName === "crypto" && crypto) {
        if (functionName === "randomUUID" && typeof crypto.randomUUID === "function") {
          return makeNodeBuiltinFunctionAdapter("crypto", "randomUUID", () => crypto.randomUUID(), context);
        }
        if (functionName === "randomBytes" && typeof crypto.getRandomValues === "function") {
          return makeNodeBuiltinFunctionAdapter(
            "crypto",
            "randomBytes",
            (length: number) => crypto.getRandomValues(new Uint8Array(length)),
            context,
          );
        }
      }
      return makeNodeBuiltinFunctionFallback(moduleName, functionName);
    }
    case "jsx_runtime": {
      const runtime = (deps as { jsxRuntime?: Record<string, unknown> })?.jsxRuntime;
      const module = deps?.[intent.specifier] as Record<string, unknown> | undefined;
      if (runtime && intent.method in runtime) {
        const supplied = runtime[intent.method];
        if (intent.method === "Fragment") return () => supplied;
        return typeof supplied === "function" ? (supplied as Function) : () => supplied;
      }
      if (module) {
        const supplied = module[intent.method];
        if (supplied !== undefined) {
          if (intent.method === "Fragment") return () => supplied;
          return typeof supplied === "function" ? (supplied as Function) : () => supplied;
        }
      }
      if (intent.method === "Fragment") return () => builtinFragment;
      return (type: unknown, props: unknown, key: unknown) => ({
        $$typeof: builtinJsxTypeof,
        type,
        props: props ?? {},
        key: key ?? null,
        ref: null,
      });
    }
    default:
      return undefined;
  }
}
