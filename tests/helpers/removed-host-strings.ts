// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7) `nativeStrings: false` used to select the host-assisted semantic
 * profile (host `wasm:js-string` strings). #6979 removed that profile, so the
 * option is now a compile error thrown by `compile()` itself. Root tests that
 * once ran a host-string lane assert that error in its place.
 */
import { expect } from "vitest";

import { compile, type CompileOptions } from "../../src/index.js";

export async function expectHostStringsRemoved(source: string, options: CompileOptions = {}): Promise<void> {
  await expect(compile(source, { ...options, nativeStrings: false })).rejects.toThrow(
    /nativeStrings: false selected the host-assisted semantic profile, which #6979 removed/,
  );
}
