// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Finalize module-level caches after import-global indices have settled. */

import type { CodegenContext } from "./context/types.js";
import { hoistConstantBoxedNumbers } from "./const-box-hoist.js";
import { cacheDeclaredGlobalReads } from "./declared-global-cache.js";

export function finalizeModuleValueCaches(ctx: CodegenContext): void {
  cacheDeclaredGlobalReads(ctx);
  hoistConstantBoxedNumbers(ctx);
}
