// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";
import type { ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { resolvePlatformCapabilityImport } from "../src/runtime/platform-capability-adapter.js";

const descriptor = (name: string, intent: ImportDescriptor["intent"], paramCount: number): ImportDescriptor => ({
  module: "env",
  name,
  kind: "func",
  intent,
  paramCount,
});

const capabilityContext = {
  deps: undefined,
  globalSandbox: undefined,
  instanceState: { webStorage: {} },
  getNodeRequire: () => undefined,
  wrapWasmClosure: () => null,
  wrapUnknownCallable: (value: unknown) => value,
};

describe("#4399 extracted JavaScript adapters", () => {
  it("binds declared capabilities outside the compatibility semantic resolver", () => {
    const write = vi.fn();
    const storage = {
      value: new Map<string, string>(),
      setItem(key: string, value: string) {
        this.value.set(key, value);
      },
      getItem(key: string) {
        return this.value.get(key) ?? null;
      },
    };
    const fragment = Symbol("fragment");
    const imports = buildImports(
      [
        descriptor("console_log_number", { type: "console_log", variant: "log_number" }, 1),
        descriptor("global_app", { type: "declared_global", name: "app" }, 0),
        descriptor("__storage_local", { type: "web_storage", which: "local" }, 0),
        descriptor(
          "__jsx_runtime_Fragment",
          { type: "jsx_runtime", method: "Fragment", specifier: "react/jsx-runtime" },
          0,
        ),
      ],
      {
        console: { log: write },
        app: { name: "declared" },
        localStorage: storage,
        jsxRuntime: { Fragment: fragment },
      },
      [],
      { ambientCompatibility: false },
    );

    imports.env.console_log_number(7);
    expect(write).toHaveBeenCalledWith(7);
    expect(imports.env.global_app()).toEqual({ name: "declared" });
    expect(imports.env.__storage_local()).toBe(storage);
    expect(imports.env.__storage_local()).toBe(storage);
    expect(imports.env.__jsx_runtime_Fragment()).toBe(fragment);
  });

  it("declines value/semantic intents and leaves them to their owned adapters", () => {
    expect(resolvePlatformCapabilityImport({ type: "box", targetType: "number" }, capabilityContext)).toBeUndefined();
    expect(
      resolvePlatformCapabilityImport({ type: "boundary_object", operation: "get" }, capabilityContext),
    ).toBeUndefined();
  });

  it("installs ambient RegExp compatibility only for the explicit compatibility path", () => {
    let definitions = 0;
    const observedRegExp = new Proxy(function ObservedRegExp() {}, {
      defineProperty(target, key, descriptor) {
        definitions++;
        return Reflect.defineProperty(target, key, descriptor);
      },
    });

    buildImports([], { RegExp: observedRegExp }, [], { ambientCompatibility: false });
    expect(definitions).toBe(0);

    buildImports([], { RegExp: observedRegExp }, [], { ambientCompatibility: true });
    expect(definitions).toBeGreaterThan(0);
  });

  it("refuses compatibility semantics through a native-first low-level adapter", () => {
    const manifest = [descriptor("__host_compare", { type: "host_compare" }, 2)];
    expect(() => buildImports(manifest, undefined, [], { ambientCompatibility: false })).toThrow(
      /Native-first adapter cannot bind env::__host_compare: legacy-semantic import/,
    );

    const compatibility = buildImports(manifest, undefined, [], { ambientCompatibility: true });
    expect(compatibility.env.__host_compare(1, 2)).toBe(-1);
    expect(compatibility.env.__host_compare(Number.NaN, 2)).toBe(2);
  });
});
