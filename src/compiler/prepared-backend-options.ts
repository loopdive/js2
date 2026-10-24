// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CompileOptions } from "../index.js";
import type { PreparedIrBackendOptions } from "../ir/program.js";
import { snapshotNativePromiseConfiguration } from "../shared/contracts/compile-runtime-options.js";
import { buildLinearOptions } from "./linear-options.js";

/** Translate captured public options without choosing defaults for absent Promise configuration. */
export function preparedBackendOptions(
  options: CompileOptions,
  backend: PreparedIrBackendOptions["backend"],
): PreparedIrBackendOptions {
  const target = options.target === "standalone" ? "standalone" : options.target === "wasi" ? "wasi" : "host";
  const nativePromise = snapshotNativePromiseConfiguration(options.nativePromise, { backend, target });
  return {
    ...(nativePromise === undefined ? {} : { nativePromise }),
    backend,
    target,
    sharedExceptionTag: options.sharedExceptionTag === true,
    utf8Storage: options.utf8Storage === true,
    sourceMap: options.sourceMap === true,
    moduleName: options.moduleName ?? "module",
    ...(backend === "linear" ? { linear: buildLinearOptions(options, undefined) } : {}),
  };
}
