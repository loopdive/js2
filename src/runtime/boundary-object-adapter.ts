// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportIntent } from "../index.js";

export type BoundaryObjectOperation = Extract<ImportIntent, { type: "boundary_object" }>["operation"];

export interface BoundaryObjectAdapterContext {
  readonly getExports: () => Record<string, Function> | undefined;
  readonly isAdmitted: (obj: unknown, exports: Record<string, Function>) => boolean;
  readonly toPropertyKey: (value: unknown, exports: Record<string, Function>) => PropertyKey;
  readonly toHostValue: (value: unknown, exports: Record<string, Function>) => any;
  readonly fromHostValue: (value: unknown, exports: Record<string, Function>) => any;
  readonly toNativeVector: (values: readonly unknown[], exports: Record<string, Function>) => any;
  readonly readArguments: (value: unknown, exports: Record<string, Function>) => any[];
  readonly toAccessor: (
    value: unknown,
    arity: 0 | 1,
    markGetterReturn: boolean,
    exports: Record<string, Function>,
  ) => any;
}

type BoundaryImport = (...args: any[]) => any;

function admittedExports(context: BoundaryObjectAdapterContext, obj: unknown): Record<string, Function> | undefined {
  const exports = context.getExports();
  return exports && context.isAdmitted(obj, exports) ? exports : undefined;
}

/**
 * Bind the narrow JS-owned-object MOP used by native-first modules.
 *
 * Admission and every value conversion remain instance-scoped callbacks. This
 * module owns only the boundary operation itself; it has no access to ambient
 * capabilities and cannot service a Wasm-owned value that was not admitted.
 */
export function createBoundaryObjectAdapter(
  operation: BoundaryObjectOperation,
  context: BoundaryObjectAdapterContext,
): BoundaryImport {
  switch (operation) {
    case "get":
      return (obj: any, key: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        return context.fromHostValue(Reflect.get(obj, context.toPropertyKey(key, exports)), exports);
      };
    case "set":
      return (obj: any, key: any, value: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return 0;
        return Reflect.set(obj, context.toPropertyKey(key, exports), context.toHostValue(value, exports)) ? 1 : 2;
      };
    case "has":
    case "delete":
      return (obj: any, key: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return 0;
        const hostKey = context.toPropertyKey(key, exports);
        const result = operation === "has" ? Reflect.has(obj, hostKey) : Reflect.deleteProperty(obj, hostKey);
        return result ? 2 : 1;
      };
    case "keys":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        return exports ? context.toNativeVector(Object.keys(obj), exports) : null;
      };
    case "call":
      return (obj: any, key: any, args: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        const hostKey = context.toPropertyKey(key, exports);
        const callable = Reflect.get(obj, hostKey);
        if (typeof callable !== "function") throw new TypeError(`${String(hostKey)} is not a function`);
        return context.fromHostValue(Reflect.apply(callable, obj, context.readArguments(args, exports)), exports);
      };
    case "apply":
      return (callable: any, thisArg: any, args: any) => {
        const exports = admittedExports(context, callable);
        if (!exports || typeof callable !== "function") {
          throw new TypeError("Reflect.apply target is not an admitted JavaScript function");
        }
        return context.fromHostValue(
          Reflect.apply(callable, context.toHostValue(thisArg, exports), context.readArguments(args, exports)),
          exports,
        );
      };
    case "construct":
      return (constructor: any, args: any, newTarget: any) => {
        const exports = admittedExports(context, constructor);
        if (!exports || typeof constructor !== "function") {
          throw new TypeError("Reflect.construct target is not an admitted JavaScript constructor");
        }
        const hostNewTarget = newTarget == null ? constructor : context.toHostValue(newTarget, exports);
        if (hostNewTarget !== constructor && !context.isAdmitted(hostNewTarget, exports)) {
          throw new TypeError("Reflect.construct newTarget is not an admitted JavaScript constructor");
        }
        return context.fromHostValue(
          Reflect.construct(constructor, context.readArguments(args, exports), hostNewTarget),
          exports,
        );
      };
    case "reflectGet":
      return (obj: any, key: any, receiver: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) throw new TypeError("Reflect.get target is not an admitted JavaScript object");
        return context.fromHostValue(
          Reflect.get(obj, context.toPropertyKey(key, exports), context.toHostValue(receiver, exports)),
          exports,
        );
      };
    case "reflectSet":
      return (obj: any, key: any, value: any, receiver: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) throw new TypeError("Reflect.set target is not an admitted JavaScript object");
        return Reflect.set(
          obj,
          context.toPropertyKey(key, exports),
          context.toHostValue(value, exports),
          context.toHostValue(receiver, exports),
        )
          ? 1
          : 0;
      };
    case "getPrototypeOf":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        return exports ? context.fromHostValue(Reflect.getPrototypeOf(obj), exports) : null;
      };
    case "setPrototypeOf":
      return (obj: any, proto: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        Object.setPrototypeOf(obj, context.toHostValue(proto, exports));
        return obj;
      };
    case "getOwnPropertyDescriptor":
      return (obj: any, key: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        return context.fromHostValue(
          Reflect.getOwnPropertyDescriptor(obj, context.toPropertyKey(key, exports)),
          exports,
        );
      };
    case "definePropertyValue":
      return (obj: any, key: any, value: any, flags: number) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        const descriptor: PropertyDescriptor = {};
        if (flags & (1 << 7)) descriptor.value = context.toHostValue(value, exports);
        if (flags & (1 << 3)) descriptor.writable = !!(flags & 1);
        if (flags & (1 << 4)) descriptor.enumerable = !!(flags & (1 << 1));
        if (flags & (1 << 5)) descriptor.configurable = !!(flags & (1 << 2));
        Object.defineProperty(obj, context.toPropertyKey(key, exports), descriptor);
        return obj;
      };
    case "definePropertyAccessor":
      return (obj: any, key: any, getter: any, setter: any, flags: number) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        const descriptor: PropertyDescriptor = {};
        // Historical callers encode "both halves specified" by leaving bits
        // 8/9 clear. New callers use those bits for partial descriptor merges.
        const accessorPresence = flags & ((1 << 8) | (1 << 9));
        if (!accessorPresence || flags & (1 << 8)) {
          const hostGetter = context.toAccessor(getter, 0, true, exports);
          descriptor.get = hostGetter == null ? undefined : hostGetter;
        }
        if (!accessorPresence || flags & (1 << 9)) {
          const hostSetter = context.toAccessor(setter, 1, false, exports);
          descriptor.set = hostSetter == null ? undefined : hostSetter;
        }
        if (flags & (1 << 4)) descriptor.enumerable = !!(flags & (1 << 1));
        if (flags & (1 << 5)) descriptor.configurable = !!(flags & (1 << 2));
        Object.defineProperty(obj, context.toPropertyKey(key, exports), descriptor);
        return obj;
      };
    case "getOwnPropertyNames":
    case "getOwnPropertySymbols":
    case "ownKeys":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        const keys =
          operation === "getOwnPropertyNames"
            ? Object.getOwnPropertyNames(obj)
            : operation === "getOwnPropertySymbols"
              ? Object.getOwnPropertySymbols(obj)
              : Reflect.ownKeys(obj);
        return context.toNativeVector(keys, exports);
      };
    case "isAdmitted":
      return (obj: any) => {
        const exports = context.getExports();
        return exports && context.isAdmitted(obj, exports) ? 1 : 0;
      };
    case "callableKind":
      return (value: any) => {
        const exports = context.getExports();
        if (!exports || !context.isAdmitted(value, exports) || typeof value !== "function") return 0;
        let constructible = 0;
        try {
          Reflect.construct(function () {}, [], value);
          constructible = 2;
        } catch {
          // Callable-only values (arrows, methods, revoked callable-only
          // proxies) deliberately keep only bit 0.
        }
        return 1 | constructible;
      };
    case "preventExtensions":
    case "seal":
    case "freeze":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        if (operation === "preventExtensions") Object.preventExtensions(obj);
        else if (operation === "seal") Object.seal(obj);
        else Object.freeze(obj);
        return obj;
      };
    case "reflectPreventExtensions":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return 0;
        return Reflect.preventExtensions(obj) ? 2 : 1;
      };
    case "isExtensible":
    case "isSealed":
    case "isFrozen":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return 0;
        const result =
          operation === "isExtensible"
            ? Object.isExtensible(obj)
            : operation === "isSealed"
              ? Object.isSealed(obj)
              : Object.isFrozen(obj);
        return result ? 2 : 1;
      };
    case "forInKeys":
      return (obj: any) => {
        const exports = admittedExports(context, obj);
        if (!exports) return null;
        const keys: string[] = [];
        for (const key in obj) keys.push(key);
        return context.toNativeVector(keys, exports);
      };
  }
}
