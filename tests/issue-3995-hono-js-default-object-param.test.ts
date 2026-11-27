// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3995 — untyped JS object defaults must not close an arrow parameter's ABI.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#3995 Hono JavaScript default object parameter", () => {
  it("accepts a narrower caller-supplied property map", async () => {
    const result = await compileMulti(
      {
        "./entry.ts": `
          import { lookup } from "./lookup.js";
          export function test(): string { return lookup("m3u8", { m3u8: "application/vnd.apple.mpegurl" }); }
        `,
        "./lookup.js": `
          const defaults = { txt: "text/plain", html: "text/html" };
          export const lookup = (extension, values = defaults) => values[extension];
        `,
      },
      "./entry.ts",
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => string)()).toBe("application/vnd.apple.mpegurl");
  });
});
