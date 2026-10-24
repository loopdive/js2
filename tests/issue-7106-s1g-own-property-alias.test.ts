// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 item 1 (S1g) — propertyHelper's uncurried Object.prototype aliases
// (`var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty)`,
// likewise `__propertyIsEnumerable`) called with two arguments lower to
// `dyn.own_property` (an i32 bool over the dynamic carrier) on the host-free
// lanes. The call is exactly boolean: as a logical operand, under `!`, as a
// `var` initializer used in a condition, and nested through `&&`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

const ALIASES = `
  var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
`;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 S1g — uncurried Object.prototype predicate aliases", () => {
  it("lowers the alias calls as booleans in logical, negated, local and nested positions", async () => {
    const result = await compile(
      `${ALIASES}
        /** @param {object} desc @param {string|symbol} k */
        function both(desc, k) { return __hasOwnProperty(desc, k) && __propertyIsEnumerable(desc, k); }
        /** @param {object} o @param {string|symbol} n */
        function absent(o, n) { return !__hasOwnProperty(o, n); }
        /** @param {object} o @param {string|symbol} n */
        function had(o, n) { var hadValue = __hasOwnProperty(o, n); if (hadValue) { return true; } return false; }
        /** @param {object} o @param {string|symbol} n */
        function enumerable(o, n) {
          var stringCheck = false;
          if (typeof n === "string") { stringCheck = true; }
          return stringCheck && __hasOwnProperty(o, n) && __propertyIsEnumerable(o, n);
        }
        export function ok() {
          var hidden = Object.create(null);
          Object.defineProperty(hidden, "h", { value: 1, enumerable: false });
          var n = 0;
          if (both({ a: 1 }, "a") === true && both({}, "a") === false && both(hidden, "h") === false) n += 1;
          if (absent({ a: 1 }, "a") === false && absent({}, "a") === true) n += 2;
          if (had({ a: 1 }, "a") === true && had({}, "a") === false) n += 4;
          if (enumerable({ a: 1 }, "a") === true && enumerable(hidden, "h") === false && enumerable({}, "a") === false) n += 8;
          return n;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1g-aliases.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(irBodies(result)).toEqual(expect.arrayContaining(["both", "absent", "had", "enumerable"]));
    expect(await call(result.binary, "ok")).toBe(15);
  });

  it("keeps a shadowed or reassigned alias, and a one-argument call, on legacy before claim", async () => {
    const result = await compile(
      `${ALIASES}
        var __hasOwnProperty2 = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
        __hasOwnProperty2 = function () { return true; };
        /** @param {object} o @param {string|symbol} n */
        function shadowed(o, n) { var __hasOwnProperty = function () { return true; }; return __hasOwnProperty(o, n) && true; }
        /** @param {object} o @param {string|symbol} n */
        function reassigned(o, n) { return __hasOwnProperty2(o, n) && true; }
        /** @param {object} o */
        function unary(o) { return __hasOwnProperty(o) && true; }
        export function ok() {
          // reassigned is only asserted to stay on legacy: legacy's own
          // certified-alias lowering answers the module-level reassignment
          // its way, and this slice does not change that.
          reassigned({}, "a");
          return shadowed({}, "a") === true && unary({}) === false ? 1 : 0;
        }
      `,
      { ...OPTIONS, fileName: "issue-7106-s1g-aliases-negative.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of ["shadowed", "reassigned", "unary"]) expect(irBodies(result)).not.toContain(name);
    expect(await call(result.binary, "ok")).toBe(1);
  });
});
