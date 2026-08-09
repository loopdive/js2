// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { instantiateWasm } from "../../src/runtime.js";

export interface PlaygroundRuntimeImports {
  env: Record<string, Function>;
  string_constants: Record<string, WebAssembly.Global>;
  string_constants16: Record<string, WebAssembly.Global>;
  setInstance?: (instance: WebAssembly.Instance) => void;
}

/**
 * Instantiate with the exact constant Globals owned by one buildImports call,
 * then associate that same runtime with the branded instance.
 */
export async function instantiatePlaygroundModule(
  binary: BufferSource,
  imports: PlaygroundRuntimeImports,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const result = await instantiateWasm(binary, imports.env, imports.string_constants, imports.string_constants16);
  imports.setInstance?.(result.instance);
  return result;
}
