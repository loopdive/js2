// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4736 — host Promise.resolve must expose a Wasm object-literal thenable to
// the native Promise implementation. The standalone Promise carrier already
// performs this assimilation natively; the host import must preserve the same
// thenable callback and fulfilled-value identity without wrapping ordinary
// object resolutions.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const CASES = [
  // Regression: a Wasm object-literal thenable must fulfill with `value`, not
  // with the opaque thenable carrier itself.
  "built-ins/Promise/resolve/resolve-thenable.js",
  // Identity control: a non-thenable object must pass through unchanged.
  "built-ins/Promise/resolve/resolve-non-thenable.js",
  "built-ins/Promise/resolve/arg-non-thenable.js",
  // Scheduling/receiver control for a foreign thenable.
  "built-ins/Promise/resolve/S25.Promise_resolve_foreign_thenable_2.js",
] as const;

describe("#4736 host Promise.resolve thenable assimilation", () => {
  for (const file of CASES) {
    it(`${file} passes in the host lane`, async () => {
      const result = await runTest262File(resolve("test262/test", file), "built-ins/Promise", 60_000);
      expect(result.status, result.error).toBe("pass");
    }, 90_000);

    it(`${file} remains passing in the standalone lane`, async () => {
      const result = await runTest262File(resolve("test262/test", file), "built-ins/Promise", 60_000, "standalone");
      expect(result.status, result.error).toBe("pass");
    }, 90_000);
  }
});
