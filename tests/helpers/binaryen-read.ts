// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Parse a js2wasm binary with binaryen, with every Wasm feature enabled.
 *
 * ## Why this exists (#7014 issue-tests backlog)
 *
 * Since the Binaryen 132 upgrade (11c1ea8307, 2026-08-24) a bare
 * `binaryen.readBinary(bytes)` parses with the MVP feature set. A WasmGC module
 * whose rec groups are only distinct under the GC type system then fails with
 * `invalid type: distinct rec groups would be identical after binary writing
 * (to resolve this, use --enable-gc)` — the module is valid (V8 accepts it), the
 * READER was misconfigured. binaryen.js takes the feature mask as an optional
 * second `readBinary` argument (`_BinaryenModuleReadWithFeatures`); its
 * `index.d.ts` declares only the one-argument form, hence the cast.
 */
import binaryen from "binaryen";

type ReadBinaryWithFeatures = (data: Uint8Array, features: binaryen.Features) => binaryen.Module;

export function readBinaryAllFeatures(binary: Uint8Array): binaryen.Module {
  return (binaryen.readBinary as unknown as ReadBinaryWithFeatures)(binary, binaryen.Features.All);
}
