// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface InstanceExportCallbackState {
  readonly getExports: () => Record<string, Function> | undefined;
  readonly deferToExports: (operation: () => void) => void;
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
  const deferred: Array<() => void> = [];

  const install = (exports: Record<string, Function>, mayEstablishInstanceAuthority: boolean): void => {
    currentExports = options.prepareExports(exports, mayEstablishInstanceAuthority);
    while (deferred.length > 0) deferred.shift()!();
  };

  return {
    callbackState: {
      getExports: () => currentExports,
      deferToExports: (operation) => deferred.push(operation),
    },
    setExports: (exports) => install(exports, false),
    setInstance: (instance) => {
      const exports = options.brandedExports(instance);
      if (exports === undefined) throw new TypeError("setInstance: expected a genuine WebAssembly.Instance");
      install(exports as Record<string, Function>, true);
    },
  };
}
