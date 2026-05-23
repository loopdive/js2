// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1460 — Object.defineProperty / defineProperties descriptor fidelity.
//
// Phase 1 fixes:
//  - R1: ToBoolean coercion on writable/enumerable/configurable per ES §6.2.5.6
//        step 5.b. Previously the codegen only accepted `true`/`false` keyword
//        literals — non-boolean expressions (`0`, `-12345`, `null`, `""`,
//        identifiers, etc.) silently degraded to the unspecified default
//        (`false`), violating spec.
//  - R5: Non-object descriptor argument → TypeError (§6.2.5.5 step 1).
//  - R4: Mixed accessor + data attributes → TypeError (§6.2.5.6 step 4).

import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("#1460 — defineProperty descriptor fidelity (Phase 1)", () => {
  describe("R1 — ToBoolean coercion of attribute flags", () => {
    it("configurable: -12345 → true (ToBoolean(-12345) = true)", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, configurable: -12345 as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.configurable === true ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("writable: 0 → false", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, writable: 0 as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.writable === false ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it('enumerable: "yes" → true', async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, enumerable: "yes" as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.enumerable === true ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it('configurable: "" → false (empty string is falsy)', async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, configurable: "" as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.configurable === false ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("configurable: null → false", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, configurable: null as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.configurable === false ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("configurable: undefined → false", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, configurable: undefined as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.configurable === false ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("dynamic flag value via function call (runtime ToBoolean)", async () => {
      await assertEquivalent(
        `
        function makeTruthy(): any { return "non-empty"; }
        export function test(): number {
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, configurable: makeTruthy() as any });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.configurable === true ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("dynamic flag value via identifier (runtime ToBoolean = false)", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const flag: any = 0;
          const o: any = {};
          Object.defineProperty(o, "x", { value: 1, writable: flag });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.writable === false ? 1 : 0;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("R5 — Non-object descriptor argument throws TypeError", () => {
    it("numeric descriptor → TypeError", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          try {
            Object.defineProperty({} as any, "x", 0 as any);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : -1;
          }
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("string descriptor → TypeError", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          try {
            Object.defineProperty({} as any, "x", "foo" as any);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : -1;
          }
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("null descriptor → TypeError", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          try {
            Object.defineProperty({} as any, "x", null as any);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : -1;
          }
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });

  describe("R4 — Mixed accessor + data descriptors throw TypeError", () => {
    it("value + get → TypeError", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          try {
            Object.defineProperty({} as any, "x", { value: 1, get() { return 1; } } as any);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : -1;
          }
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("writable + set → TypeError", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          try {
            Object.defineProperty({} as any, "x", { writable: true, set(v: any) {} } as any);
            return 0;
          } catch (e: any) {
            return e instanceof TypeError ? 1 : -1;
          }
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });
});
