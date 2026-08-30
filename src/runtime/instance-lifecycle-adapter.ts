// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface InstanceExportCallbackState {
  readonly getExports: () => Record<string, Function> | undefined;
  readonly deferToExports: (operation: () => void) => void;
  /**
   * (#5193) Marshalling helpers the MODULE handed us from inside its own wasm
   * `start` section, as `ref.func` values.
   *
   * `getExports()` is `undefined` for the whole of module init: the host cannot
   * call `setInstance` until `WebAssembly.instantiate` returns, and the start
   * section runs before it does. Every compiled→host marshalling probe
   * (`__vec_len`/`__vec_get`/`__dv_byte_len`/…) is an EXPORT, so during init
   * they are all unreachable and a compiled ArrayBuffer handed to
   * `new Float64Array(...)` was an undecodable opaque struct.
   *
   * A funcref crossing into a JS import materializes as the very same function
   * object the export would later yield, so registering them at the top of
   * `__module_init` closes the window without waiting for the instance.
   *
   * Deliberately SEPARATE from `getExports()`: only the marshalling paths
   * consult it, so the many `getExports() !== undefined` branches that mean
   * "post-instantiation" keep their current meaning during init.
   */
  readonly getStartExports: () => Record<string, Function> | undefined;
  readonly registerStartExport: (name: string, fn: Function) => void;
}

export interface InstanceLifecycleAdapterOptions {
  readonly prepareExports: (
    exports: Record<string, Function>,
    mayEstablishInstanceAuthority: boolean,
  ) => Record<string, Function>;
  readonly brandedExports: (instance: unknown) => WebAssembly.Exports | undefined;
}

export interface InstanceLifecycleAdapter {
  readonly callbackState: InstanceExportCallbackState;
  readonly setExports: (exports: Record<string, Function>) => void;
  readonly setInstance: (instance: WebAssembly.Instance) => void;
}

/** Own late export wiring and start-section deferral for one import object. */
export function createInstanceLifecycleAdapter(options: InstanceLifecycleAdapterOptions): InstanceLifecycleAdapter {
  let currentExports: Record<string, Function> | undefined;
  let startExports: Record<string, Function> | undefined;
  const deferred: Array<() => void> = [];

  const install = (exports: Record<string, Function>, mayEstablishInstanceAuthority: boolean): void => {
    currentExports = options.prepareExports(exports, mayEstablishInstanceAuthority);
    while (deferred.length > 0) deferred.shift()!();
  };

  return {
    callbackState: {
      getExports: () => currentExports,
      deferToExports: (operation) => deferred.push(operation),
      getStartExports: () => startExports,
      registerStartExport: (name, fn) => {
        if (typeof fn !== "function") return;
        (startExports ??= {})[name] = fn;
      },
    },
    setExports: (exports) => install(exports, false),
    setInstance: (instance) => {
      const exports = options.brandedExports(instance);
      if (exports === undefined) throw new TypeError("setInstance: expected a genuine WebAssembly.Instance");
      install(exports as Record<string, Function>, true);
    },
  };
}
