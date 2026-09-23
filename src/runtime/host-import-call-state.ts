// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Structural import facts used by the existing guard; no source resolver or policy table. */
export interface HostImportCallDescriptor {
  readonly name: string;
  readonly paramCount?: number;
  readonly intent: { readonly type: string; readonly targetType?: string; readonly name?: string };
}

export interface HostImportCallState {
  readonly getCaughtException: () => unknown;
  readonly registerImport: (name: string) => number;
  readonly wrap: (
    imp: HostImportCallDescriptor,
    fn: Function,
    importIndex: number,
  ) => { fn: Function; fastLeaf: boolean };
  readonly startImportCounting: () => void;
  readonly takeImportCounts: () => Record<string, number>;
}

function isFastLeafHostImport(imp: HostImportCallDescriptor): boolean {
  switch (imp.intent.type) {
    case "box":
    case "typeof_check":
    case "truthy_check":
      return true;
    case "unbox":
      return imp.intent.targetType === "boolean";
    case "builtin":
      return imp.intent.name === "__get_undefined";
    default:
      return false;
  }
}

/**
 * (#6492 round 6) The "last host exception" latch is PROCESS-WIDE, not
 * per-import-object.
 *
 * A wasm `catch_all` cannot see the thrown JS value; it recovers it by calling
 * the `caught_exception` import, which reads this latch. The latch is written
 * by the wrapper below — i.e. by the host import of the module whose call
 * threw. Within one module that is the same import object, which is why a
 * per-object latch worked for the entire single-module history of this
 * compiler.
 *
 * In a LINKED graph it is two different import objects. The provider calls a
 * consumer closure, the consumer's `__throw_reference_error` (or any other
 * throwing host import) raises a real JS error, and that error propagates
 * wasm→wasm as a JS exception. The provider's `catch_all` then asked ITS OWN
 * latch, which nothing had written, and got `undefined` — so the harness's
 * `assert.throws` reported "Thrown value was not an object!" for a throw whose
 * value the CONSUMER catches perfectly well (measured: `typeof e === "object"`,
 * `[object Error]`, `name === "ReferenceError"`).
 *
 * A wasm-thrown error is unaffected either way: it travels in the shared
 * `env.__exn` tag (#5226) and the catching module reads the payload from the
 * tag, never from this latch — which is exactly why
 * `assert.throws(ReferenceError, function () { throw new ReferenceError("x"); })`
 * passed while the host-thrown twin did not.
 *
 * Making it process-wide is last-write-wins, the same discipline it already
 * had: a `catch_all` reads immediately after the throw that reached it, and
 * nothing clears the latch in either design, so a reader that could see a
 * stale value before can still see exactly the same stale value now. The only
 * behaviour that changes is the cross-module read, which previously could not
 * be right at all.
 */
let lastCaughtException: any = undefined;

/** The existing caught object, shared crossing depth and diagnostic counters for one import object. */
export function createHostImportCallState(): HostImportCallState {
  const envImportNames: string[] = [];
  let importCounts: Uint32Array | undefined;
  const MAX_HOST_RECURSION_DEPTH = 512;
  let hostCallDepth = 0;
  const getCaughtException = (): unknown => lastCaughtException;
  const registerImport = (name: string): number => envImportNames.push(name) - 1;
  const wrap = (
    imp: HostImportCallDescriptor,
    fn: Function,
    importIndex: number,
  ): { fn: Function; fastLeaf: boolean } => {
    const fastLeaf = process.env.JS2WASM_FAST_LEAF_HOST_IMPORTS !== "0" && isFastLeafHostImport(imp);
    if (fastLeaf && imp.paramCount === 0) {
      const original = fn;
      // biome-ignore lint/complexity/useArrowFunction: Preserve the original ordinary wrapper's shape and arity.
      fn = function () {
        if (importCounts) importCounts[importIndex]++;
        return original();
      };
      return { fn, fastLeaf: true };
    }
    if (fastLeaf && imp.paramCount === 1) {
      const original = fn;
      // biome-ignore lint/complexity/useArrowFunction: Preserve the original ordinary wrapper's shape and arity.
      fn = function (a: any) {
        if (importCounts) importCounts[importIndex]++;
        return original(a);
      };
      return { fn, fastLeaf: true };
    }
    {
      const original = fn;
      const guardEnter = (): void => {
        if (importCounts) importCounts[importIndex]++;
        if (hostCallDepth >= MAX_HOST_RECURSION_DEPTH) {
          const err = new RangeError("Maximum call stack size exceeded");
          lastCaughtException = err;
          throw err;
        }
        hostCallDepth++;
      };
      // The arity comes from the WASM IMPORT SIGNATURE (`paramCount`), not from
      // `original.length`. The wasm side is what does the calling and its call
      // sites are fixed-arity, so this count is exactly how many arguments the
      // wrapper can ever receive. `original.length` would be wrong: it excludes
      // rest and defaulted parameters, so a variadic callee under-reports
      // (`Math.max.length` is 2) and a wrapper sized from it would silently
      // drop arguments. Anything without a declared count keeps the rest form.
      const arity = imp.paramCount ?? -1;
      const variadic = arity < 0 || arity > 4;
      if (variadic) {
        fn = function (this: any, ...args: any[]) {
          guardEnter();
          try {
            return original.apply(this, args);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 0) {
        fn = function (this: any) {
          guardEnter();
          try {
            return original();
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 1) {
        fn = function (this: any, a: any) {
          guardEnter();
          try {
            return original(a);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 2) {
        fn = function (this: any, a: any, b: any) {
          guardEnter();
          try {
            return original(a, b);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 3) {
        fn = function (this: any, a: any, b: any, c: any) {
          guardEnter();
          try {
            return original(a, b, c);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 4) {
        fn = function (this: any, a: any, b: any, c: any, d: any) {
          guardEnter();
          try {
            return original(a, b, c, d);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else {
        fn = function (this: any, ...args: any[]) {
          guardEnter();
          try {
            return original.apply(this, args);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      }
    }
    return { fn, fastLeaf: false };
  };
  const startImportCounting = () => {
    importCounts = new Uint32Array(envImportNames.length);
  };
  const takeImportCounts = () => {
    const counts: Record<string, number> = Object.create(null);
    if (importCounts) {
      for (let index = 0; index < envImportNames.length; index++) {
        if (importCounts[index] > 0) counts[envImportNames[index]] = importCounts[index];
      }
    }
    importCounts = undefined;
    return counts;
  };
  return { getCaughtException, registerImport, wrap, startImportCounting, takeImportCounts };
}
