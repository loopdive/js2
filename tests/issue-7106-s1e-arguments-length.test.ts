// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S1e — `arguments.length` in a top-level JS function (propertyHelper's
// `assert(arguments.length > 2, …)` guard) ships an IR body: `dyn.arguments_length`
// reads and clears the call site's published count at function entry exactly as
// legacy's arguments prologue does, so a legacy caller passing fewer or more
// arguments than the formals is observed correctly.

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

describe("#7106 S1e — arguments.length through dyn.arguments_length", () => {
  it("observes the actual argument count from legacy callers (under-, exact and over-arity)", async () => {
    const result = await compile(
      `
        /** @param {object} a @param {object} b @param {object} c @param {object} d */
        function count(a, b, c, d) { return arguments.length; }
        /** @param {object} obj @param {string|symbol} name @param {object} desc @param {object} [options] */
        function guarded(obj, name, desc, options) { return arguments.length > 2; }
        export function ok() {
          var n = 0;
          if (count({}) === 1) n += 1;
          if (count({}, {}) === 2) n += 2;
          if (count({}, {}, {}, {}) === 4) n += 4;
          if (count({}, {}, {}, {}, {}, {}) === 6) n += 8;
          if (guarded({}, "p") === false) n += 16;
          if (guarded({}, "p", undefined) === true) n += 32;
          return n;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1e-count.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["count", "guarded"]),
    );
    expect(await call(result.binary, "ok")).toBe(63);
  });

  it("reads the count at entry, before a nested call can clobber it", async () => {
    const result = await compile(
      `
        function inner(x, y, z) { return arguments.length; }
        function outer(a, b) {
          var k = inner(1);
          return arguments.length * 10 + k;
        }
        export function ok() { return outer(7) === 11 ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1e-entry.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("inner");
    // `outer` directly calls an arguments-reading local function; the IR
    // direct-call plan publishes no __argc yet, so the selector keeps it legacy.
    expect(irBodies(result)).not.toContain("outer");
    expect(await call(result.binary, "ok")).toBe(1);
  });

  it("leaves every other `arguments` use to legacy", async () => {
    const result = await compile(
      `
        function first() { return arguments[0]; }
        function shadowed(arguments) { return arguments.length; }
        function nested() { function g() { return arguments.length; } return g(1, 2); }
        export function ok() { return first(3) === 3 && shadowed("ab") === 2 && nested() === 2 ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1e-other.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result)).not.toContain("first");
    expect(irBodies(result)).not.toContain("nested");
    expect(await call(result.binary, "ok")).toBe(1);
  });
});
