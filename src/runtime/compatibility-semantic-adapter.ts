// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ImportIntent } from "../index.js";

/**
 * (#6979) The compatibility semantic providers (host strings, dynamic language
 * operations, Proxy creation) are retired with the host-semantic lane; only the
 * `date` host-accelerator intents (#6978) still bind here.
 */
export function resolveCompatibilitySemanticImport(intent: ImportIntent): Function | undefined {
  switch (intent.type) {
    case "date_new":
      return () => new Date();
    case "date_method":
      return (date: any) => date[intent.method]();
    default:
      return undefined;
  }
}
