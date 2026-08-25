// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// #4688 — standalone object-literal `super` value reads. The two upstream
// rows are pinned through the real Test262 runner because their harness and
// deferred top-level initialization are part of the reproducing shape.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const SUPER_ROWS = [
  "language/expressions/super/prop-dot-obj-val.js",
  "language/expressions/super/prop-expr-obj-val.js",
] as const;

describe.skipIf(!TEST262_AVAILABLE)("#4688 — exact standalone residual rows", () => {
  for (const rel of SUPER_ROWS) {
    it(rel, { timeout: 60_000 }, async () => {
      const result = await runTest262File(join(TEST262_ROOT, "test", rel), "issue-4688", 30_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }

  it("keeps the adjacent poisoned-__proto__ control passing", { timeout: 60_000 }, async () => {
    const result = await runTest262File(
      join(TEST262_ROOT, "test/language/expressions/super/call-poisoned-underscore-proto.js"),
      "issue-4688",
      30_000,
      "standalone",
    );
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });
});

describe("#4688 — borrowed method home object and call-time receiver", () => {
  it("uses the captured home for the base and borrowed this for an inherited getter", async () => {
    const source = `
      var proto = { get value() { return (this as any).marker; } };
      var home = {
        marker: "home",
        method() { return super.value; },
        ordinary() { return this.marker; }
      };
      Object.setPrototypeOf(home, proto);
      var borrowedReceiver = { marker: "borrowed" };
      var borrowed = home.method;
      export function borrowedHome(): number {
        // Function#call is the supported receiver-install path. Reflect.apply
        // remains an existing standalone refusal/trap outside #4688 (#2046).
        return borrowed.call(borrowedReceiver) === "borrowed" ? 1 : 0;
      }
      export function directHome(): number {
        return home.method() === "home" ? 1 : 0;
      }
      export function directOrdinary(): number {
        return home.ordinary() === "home" ? 1 : 0;
      }
    `;
    const result = await compile(source, { fileName: "issue-4688-borrowed.ts", target: "standalone" });
    expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
    if (!result.success) return;

    const imports = (result.imports ?? []).map((entry) => `${entry.module}::${entry.name}`);
    expect(imports).not.toContain("env::__extern_get");
    expect(imports).not.toContain("env::__reflect_get");

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(instance.exports.borrowedHome?.()).toBe(1);
    expect(instance.exports.directHome?.()).toBe(1);
    expect(instance.exports.directOrdinary?.()).toBe(1);
  });
});
