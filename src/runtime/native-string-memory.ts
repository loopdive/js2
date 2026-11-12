// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { NATIVE_STRING_MEMORY_READER } from "../shared/contracts/init-marshal-helpers.js";

/** Decode the string bridge through its memory export or its startup funcref. */
export function readNativeStringMemory(
  exports: Record<string, Function> | undefined,
  ptr: number,
  len: number,
): string {
  if (ptr < 0 || len <= 0) return "";
  const memory = exports?.__str_mem as WebAssembly.Memory | undefined;
  const read16 = exports?.[NATIVE_STRING_MEMORY_READER];
  if (memory ? ptr + len * 2 > memory.buffer.byteLength : !read16) return "";
  const units = memory ? new Uint16Array(memory.buffer, ptr, len) : undefined;
  const parts: string[] = [];
  for (let start = 0; start < len; start += 4096) {
    const end = Math.min(start + 4096, len);
    const chunk = units
      ? units.subarray(start, end)
      : Array.from({ length: end - start }, (_, i) => read16!(ptr + (start + i) * 2));
    parts.push(String.fromCharCode(...chunk));
  }
  return parts.join("");
}
