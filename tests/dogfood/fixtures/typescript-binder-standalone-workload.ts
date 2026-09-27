// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Zero-argument exports keep the standalone binder oracle inside Wasm instead
// of attempting to pass JavaScript strings into a native-string ABI.
import { runCase } from "./typescript-binder-workload.js";

export function runConstLocal(): number {
  return runCase("const x = 1;\n");
}

export function runDuplicateLet(): number {
  return runCase(
    "let x;\n// biome-ignore lint/suspicious/noRedeclare: intentional binder diagnostic fixture\nlet x;\n",
  );
}
