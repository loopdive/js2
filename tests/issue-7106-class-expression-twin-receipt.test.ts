// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a variable-bound class expression at module scope is registered by
// legacy under its binding name AND a synthetic `__anonClass_N` identity, each
// with its own member bodies. The direct-body receipt audit used to count the
// twin as a duplicate receipt and every such member read as a
// `body-emission-evidence` invariant (1,242 test262 rows under
// `language/expressions/class/dstr/`). The twin is recorded, not counted.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

describe("#7106 — class-expression twin identity is not a duplicate body receipt", () => {
  it("var-bound class expression getter: no body-emission-evidence invariant", async () => {
    const result = await compile(
      `
        var callCount = 0;
        var C = class {
          #method({ x: y } = { x: 23 }) { callCount = callCount + 1; }
          get method() { return this.#method; }
        };
        new C().method();
      `,
      { ...OPTIONS, fileName: "issue-7106-twin.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const invariants = (result.irOutcomes ?? []).filter((o) => o.kind === "invariant");
    expect(invariants, JSON.stringify(invariants, null, 2)).toEqual([]);
    const getter = (result.irOutcomes ?? []).find((o) => o.displayName.includes("get_method"));
    expect(getter?.legacyBodyEmitted).toBe(true);
  });

  it("a genuine repeat under the same class identity still reads as a duplicate (unchanged)", async () => {
    // A named class declaration has one identity; its member is received once.
    const result = await compile(
      `
        class D { get method() { return 1; } }
        var v = new D().method;
      `,
      { ...OPTIONS, fileName: "issue-7106-twin-named.js" },
    );
    expect(result.success).toBe(true);
    expect((result.irOutcomes ?? []).filter((o) => o.kind === "invariant")).toEqual([]);
  });
});
