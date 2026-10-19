// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ExternClassInfo } from "./context/types.js";
import type { WasmModule } from "../ir/types.js";

/** Keep exact provider prefixes, including multiple namespaces sharing a leaf. */
export function usedExternClassMetadata(
  classes: ReadonlyMap<string, ExternClassInfo>,
  imports: WasmModule["imports"],
): WasmModule["externClasses"] {
  const names = imports.map((entry) => entry.name);
  const seen = new Map<string, ExternClassInfo>();
  const result: WasmModule["externClasses"] = [];
  for (const info of classes.values()) {
    if (!names.some((name) => name.startsWith(`${info.importPrefix}_`))) continue;
    const prior = seen.get(info.importPrefix);
    if (prior) {
      if (prior.className !== info.className || prior.namespacePath.join(".") !== info.namespacePath.join(".")) {
        throw new Error(`Ambiguous external class import prefix: ${info.importPrefix}`);
      }
      continue;
    }
    seen.set(info.importPrefix, info);
    result.push({
      importPrefix: info.importPrefix,
      namespacePath: info.namespacePath,
      className: info.className,
      constructorParams: info.constructorParams,
      methods: info.methods,
      properties: info.properties,
    });
  }
  return result;
}
