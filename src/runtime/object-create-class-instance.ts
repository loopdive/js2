import { marshalExports, type MarshalExportSource } from "./init-marshal-registry.js";

/** Own the host records and provider probe used by the dynamic Object.create bridge (#5239). */
export function createObjectCreateClassInstanceRuntime(
  canBeWeakKey: (value: unknown) => boolean,
  isWasmStruct: (value: unknown) => boolean,
) {
  const dictionaryResults = new WeakSet<object>();
  const instancePrototypes = new WeakMap<object, any>();

  return {
    create(proto: any, callbackState: MarshalExportSource | undefined): any {
      if (proto != null && typeof proto === "object" && isWasmStruct(proto)) {
        const make = marshalExports(callbackState)?.__object_create_class_instance as ((value: any) => any) | undefined;
        if (typeof make === "function") {
          try {
            const instance = make(proto);
            if (instance != null) {
              if (canBeWeakKey(instance)) instancePrototypes.set(instance, proto);
              return instance;
            }
          } catch {
            // Not a class prototype owned by this module.
          }
        }
      }
      const value = Object.create(proto);
      dictionaryResults.add(value);
      return value;
    },

    isDictionaryResult(value: object): boolean {
      return dictionaryResults.has(value);
    },

    prototypeFor(value: object): any | undefined {
      return instancePrototypes.get(value);
    },
  };
}
