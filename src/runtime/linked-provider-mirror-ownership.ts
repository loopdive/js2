import { marshalExports, type MarshalExportSource } from "./init-marshal-registry.js";

/**
 * (#5222) Track which module minted a host mirror so linked-provider values
 * retain the decoder that owns their underlying WasmGC structs.
 */
export function createLinkedProviderMirrorOwnership(canBeWeakKey: (value: unknown) => boolean) {
  const linkedProviderExportSets = new WeakSet<object>();
  const hostMirrorOwnerExports = new WeakMap<object, Record<string, Function>>();
  // Fast opt-out for the overwhelmingly common single-module path.
  let anyLinkedProviderRegistered = false;

  return {
    registerProviderExports(exports: Record<string, Function>): void {
      if (!canBeWeakKey(exports)) return;
      linkedProviderExportSets.add(exports);
      anyLinkedProviderRegistered = true;
    },

    /**
     * (#5364) Twin of the #5225 registry reset: forget that any linked provider
     * is live once the project that owned it is gone. `linkedProviderExportSets`
     * and `hostMirrorOwnerExports` are weak and keyed on the retiring project's
     * own objects, so only the fast-opt-out boolean needs clearing — but leaving
     * it TRUE would keep `isForeignModuleMirror` probing on every read of a
     * process that no longer has a linked project live.
     */
    reset(): void {
      anyLinkedProviderRegistered = false;
    },

    recordMirrorOwner(mirror: unknown, exports: Record<string, Function> | undefined): void {
      if (exports === undefined || !canBeWeakKey(mirror)) return;
      if (!hostMirrorOwnerExports.has(mirror as object)) {
        hostMirrorOwnerExports.set(mirror as object, exports);
      }
    },

    isForeignModuleMirror(mirror: unknown, reader: MarshalExportSource | undefined): boolean {
      if (!anyLinkedProviderRegistered || reader === undefined || !canBeWeakKey(mirror)) return false;
      const owner = hostMirrorOwnerExports.get(mirror as object);
      if (owner === undefined) return false;
      const currentExports = marshalExports(reader);
      if (currentExports === undefined || owner === currentExports) return false;
      return linkedProviderExportSets.has(owner) || linkedProviderExportSets.has(currentExports);
    },
  };
}
