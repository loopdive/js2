// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Value adapter: the linear-memory string marshaling imports
 * (`__str_extern_len`, `__str_from_mem`, `__str_to_mem`) that copy UTF-16 code
 * units through the module's `__str_mem` export. Split out of
 * `src/runtime.ts`'s `resolveImport`.
 */

import { marshalExports, type MarshalExportSource } from "./init-marshal-registry.js";
import { readNativeStringMemory } from "./native-string-memory.js";

type CallbackState = MarshalExportSource;

/** The provider for one string-memory import, or `undefined` when `name` is not one. */
export function resolveStringMemoryImport(
  name: string,
  callbackState: CallbackState | undefined,
): Function | undefined {
  // Native string marshaling (fast mode)
  if (name === "__str_extern_len") return (s: string) => s.length;
  if (name === "__str_from_mem") {
    // Decode through the memory export, or the startup funcref while the
    // start section is still running (#5193): shared with the init-marshal
    // registry reader on main.
    return (ptr: number, len: number) => readNativeStringMemory(marshalExports(callbackState), ptr, len);
  }
  if (name === "__str_to_mem") {
    return (s: string, ptr: number) => {
      const exports = callbackState?.getExports();
      const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
      if (!mem) return;
      const byteLen = s.length * 2;
      if (ptr < 0 || ptr + byteLen > mem.buffer.byteLength) return;
      const u16 = new Uint16Array(mem.buffer, ptr, s.length);
      for (let i = 0; i < s.length; i++) {
        u16[i] = s.charCodeAt(i);
      }
    };
  }
  return undefined;
}
