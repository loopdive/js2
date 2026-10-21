// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 item 1 (S1f) — the global `undefined` as a VALUE (propertyHelper's
// `assert.sameValue(originalDesc, undefined, …)`, `var v = undefined`,
// `d || undefined`) is the dynamic carrier's undefined (#7104 `dyn.undefined`)
// in a call argument, a local initializer and a logical-value operand. Equality
// (`x === undefined`) and return positions already had their own arms.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 S1f — the global undefined as a dynamic value", () => {
  it("passes undefined as a call argument, binds it to a local, and selects it through `||`", async () => {
    const result = await compile(
      `
        function same(a, b) { return a === b; }
        /** @param {object} o */
        function arg(o) { return same(o, undefined); }
        /** @param {object} o */
        function local(o) { var v = undefined; return v === o; }
        /** @param {object} o @param {object} d */
        function pick(o, d) { return d || undefined; }
        export function ok() {
          var n = 0;
          if (arg(undefined) === true) n += 1;
          if (arg(1) === false) n += 2;
          if (local(undefined) === true) n += 4;
          if (local("x") === false) n += 8;
          if (pick({}, 0) === undefined) n += 16;
          if (pick({}, 5) === 5) n += 32;
          return n;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1f-undefined.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["arg", "local", "pick"]),
    );
    expect(await call(result.binary, "ok")).toBe(63);
  });

  it("a shadowed `undefined` is an ordinary binding, not the carrier's undefined", async () => {
    const result = await compile(
      `
        function same(a, b) { return a === b; }
        /** @param {object} o */
        function shadow(o) { var undefined = 7; return same(o, undefined); }
        export function ok() { return shadow(7) === true && shadow(8) === false ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1f-shadow.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(await call(result.binary, "ok")).toBe(1);
  });
});

describe("#7106 S1f — `fn.call(undefined, …)` on a direct callable stays on legacy before claim", () => {
  it("refuses the invocation method ahead of the function-object member arm and prepares no dynamic runtime", async () => {
    // The host-import-policy `functionCall` probe, compiled with the compiler's
    // default (native-first) options: before this guard the selector claimed
    // `run`, the dynamic member-call lowering produced a DYNAMIC result for an
    // f64 declaration, and the claim demoted at verify with the dynamic runtime
    // (3 string imports) already prepared into the module.
    const result = await compile(
      `
        function add(value: number): number { return value + 1; }
        export function run(): number { return add.call(undefined, 6); }
        export function runApply(): number { return add.apply(undefined, [8]); }
      `,
      { fileName: "s1f-function-call-probe.ts", trackIrOutcomes: true },
    );
    expect(result.success).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.hostImportInventory ?? []).toEqual([]);
    expect(irBodies(result)).not.toContain("run");
    expect(irBodies(result)).not.toContain("runApply");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(7);
    expect((instance.exports.runApply as () => number)()).toBe(9);
  });
});
