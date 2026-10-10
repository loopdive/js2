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

const enrollmentBrand: unique symbol = Symbol("InstanceLifecycleEnrollment");

/** Brand + adapter ownership only: NOT verified artifact/module provenance. */
export interface InstanceLifecycleEnrollment {
  readonly [enrollmentBrand]: true;
}

export interface InstanceLifecycleAdapter {
  readonly callbackState: InstanceExportCallbackState;
  readonly setExports: (exports: Record<string, Function>) => void;
  readonly setInstance: (instance: WebAssembly.Instance) => void;
  /** Internal preparation only; does not prepare views, publish, or drain. */
  readonly enrollInstance: (instance: WebAssembly.Instance) => InstanceLifecycleEnrollment;
  /** Authenticate this adapter's handle, then perform the legacy installation. */
  readonly installEnrolledInstance: (enrollment: InstanceLifecycleEnrollment) => void;
}

/** Own late export wiring and start-section deferral for one import object. */
export function createInstanceLifecycleAdapter(options: InstanceLifecycleAdapterOptions): InstanceLifecycleAdapter {
  let currentExports: Record<string, Function> | undefined;
  let startExports: Record<string, Function> | undefined;
  const deferred: Array<() => void> = [];
  const enrollments = new WeakMap<InstanceLifecycleEnrollment, WebAssembly.Exports>();

  const prepareAndPublish = (exports: Record<string, Function>, mayEstablishInstanceAuthority: boolean): void => {
    // Assignment happens only after prepare returns. Its authority/timer/DOM
    // side effects remain at the original activation point, not enrollment.
    currentExports = options.prepareExports(exports, mayEstablishInstanceAuthority);
  };
  const drainDeferred = (): void => {
    // Preserve shift-before-call, including reentrant installs/queue appends.
    // A throw leaves the installed view and remaining queue; no fake rollback.
    while (deferred.length > 0) deferred.shift()!();
  };
  const install = (exports: Record<string, Function>, mayEstablishInstanceAuthority: boolean): void => {
    prepareAndPublish(exports, mayEstablishInstanceAuthority);
    drainDeferred();
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
    enrollInstance: (instance) => {
      // The supplied reader is the same trusted internal-slot reader used by
      // setInstance. Genuineness alone says nothing about the supplying module.
      const exports = options.brandedExports(instance);
      if (exports === undefined) throw new TypeError("enrollInstance: expected a genuine WebAssembly.Instance");
      const enrollment: InstanceLifecycleEnrollment = Object.freeze({ [enrollmentBrand]: true as const });
      enrollments.set(enrollment, exports);
      return enrollment;
    },
    installEnrolledInstance: (enrollment) => {
      const exports = enrollments.get(enrollment);
      if (exports === undefined) throw new TypeError("installEnrolledInstance: foreign or forged enrollment");
      install(exports as Record<string, Function>, true);
    },
  };
}
