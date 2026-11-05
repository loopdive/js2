// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Value adapter: the linear-memory string marshaling imports
 * (`__str_extern_len`, `__str_from_mem`, `__str_to_mem`) that copy UTF-16 code
 * units through the module's `__str_mem` export. Split out of
 * `src/runtime.ts`'s `resolveImport`.
 */

interface CallbackState {
  getExports: () => Record<string, Function> | undefined;
}

/** The provider for one string-memory import, or `undefined` when `name` is not one. */
export function resolveStringMemoryImport(
  name: string,
  callbackState: CallbackState | undefined,
): Function | undefined {
  // Native string marshaling (fast mode)
  if (name === "__str_extern_len") return (s: string) => s.length;
  if (name === "__str_from_mem") {
    // Returns a function that reads i16 code units from wasm memory
    // The memory is bound lazily after instantiation
    return (ptr: number, len: number) => {
      const exports = callbackState?.getExports();
      const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
      if (!mem) return "";
      if (len <= 0) return "";
      const byteLen = len * 2;
      if (ptr < 0 || ptr + byteLen > mem.buffer.byteLength) return "";
      const u16 = new Uint16Array(mem.buffer, ptr, len);
      // Avoid spread for large arrays (stack overflow at ~65k elements)
      if (len <= 4096) return String.fromCharCode(...u16);
      const parts: string[] = [];
      for (let i = 0; i < len; i += 4096) {
        const chunk = u16.subarray(i, Math.min(i + 4096, len));
        parts.push(String.fromCharCode(...chunk));
      }
      return parts.join("");
    };
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
