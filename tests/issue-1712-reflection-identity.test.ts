// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { assertEquivalent } from "./equivalence/helpers.js";
import { runTest262File } from "./test262-runner.js";

const PROPERTY_HELPER_CASES = [
  "built-ins/RegExp/prototype/test/name.js",
  "built-ins/Math/abs/name.js",
  "built-ins/Math/abs/length.js",
  "built-ins/Math/abs/prop-desc.js",
  "built-ins/Array/isArray/name.js",
  "built-ins/Object/getOwnPropertyNames/name.js",
] as const;

const HOST_REALM_NULL_RECEIVER_CASES = [
  "language/eval-code/indirect/realm.js",
  "language/types/reference/get-value-prop-base-primitive-realm.js",
  "language/types/reference/put-value-prop-base-primitive-realm.js",
] as const;

const HOST_CLOSURE_ARGC_CASES = [
  "built-ins/Promise/all/invoke-then.js",
  "built-ins/Promise/allSettled/invoke-then.js",
  "built-ins/Promise/race/invoke-then.js",
] as const;

describe("#1712 standalone reflection identity", () => {
  it("keeps builtin metadata, closed shapes, and namespace reflection exact", async () => {
    const result = await compile(
      `
        const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
        const valueOf = Function.prototype.call.bind(Object.prototype.valueOf);
        const ownNames = Object.getOwnPropertyNames;
        const getDescriptor = Object.getOwnPropertyDescriptor;

        export function run(): number {
          const desc: any = Object.getOwnPropertyDescriptor(RegExp.prototype.test, "name");
          if (desc === undefined || desc.value !== "test") return 1;
          if (desc.writable !== false || desc.enumerable !== false || desc.configurable !== true) return 2;
          if (!hasOwn(desc, "value") || hasOwn(desc, "missing") || valueOf(desc) !== desc) return 3;

          const directNames: any = Object.getOwnPropertyNames(desc);
          const storedNames: any = ownNames(desc);
          for (const names of [directNames, storedNames]) {
            if (names.length !== 4) return 4;
            if (
              names[0] !== "value" ||
              names[1] !== "writable" ||
              names[2] !== "enumerable" ||
              names[3] !== "configurable"
            ) return 5;
          }

          const first = { zebra: 1, alpha: 2 };
          const second = { first: 3, second: 4 };
          const firstNames: any = ownNames(first);
          const secondNames: any = Object.getOwnPropertyNames(second);
          if (firstNames.length !== 2 || firstNames[0] !== "zebra" || firstNames[1] !== "alpha") return 6;
          if (secondNames.length !== 2 || secondNames[0] !== "first" || secondNames[1] !== "second") return 7;
          if (
            !hasOwn(first, "zebra") ||
            hasOwn(first, "first") ||
            !hasOwn(second, "first") ||
            hasOwn(second, "zebra")
          ) return 8;
          if ((first as any).zebra !== 1 || (second as any).first !== 3) return 9;

          if (!hasOwn(Math, "abs") || hasOwn(Math, "definitelyMissing")) return 10;
          const mathNames: any = ownNames(Math);
          if (mathNames.length < 2 || mathNames[0] !== "abs" || mathNames[1] !== "acos") return 11;
          const absDesc: any = getDescriptor(Math, "abs");
          if (
            absDesc === undefined ||
            absDesc.writable !== true ||
            absDesc.enumerable !== false ||
            absDesc.configurable !== true
          ) return 12;

          if (!hasOwn(Object, "keys") || !hasOwn(Object, "getOwnPropertyNames") || hasOwn(Object, "nope")) return 13;
          const keysDesc: any = getDescriptor(Object, "keys");
          if (
            keysDesc === undefined ||
            keysDesc.writable !== true ||
            keysDesc.enumerable !== false ||
            keysDesc.configurable !== true
          ) return 14;

          const dynamic: any = {};
          Object.defineProperty(dynamic, "field", {
            value: 10,
            writable: true,
            enumerable: true,
            configurable: false,
          });
          const dynamicDesc: any = getDescriptor(dynamic, "field");
          if (dynamicDesc === undefined || !hasOwn(dynamicDesc, "writable")) return 15;
          const directDynamicDesc: any = Object.getOwnPropertyDescriptor(dynamic, "field");
          if (directDynamicDesc === undefined || !hasOwn(directDynamicDesc, "writable")) return 16;
          if (
            dynamicDesc.value !== 10 ||
            dynamicDesc.writable !== true ||
            dynamicDesc.enumerable !== true ||
            dynamicDesc.configurable !== false
          ) return 17;

          let accessorValue = 21;
          const accessor: any = {};
          const getter = function(): number { return accessorValue; };
          const setter = function(value: number): void { accessorValue = value; };
          Object.defineProperty(accessor, "field", {
            get: getter,
            set: setter,
            enumerable: false,
            configurable: true,
          });
          const accessorDesc: any = getDescriptor(accessor, "field");
          if (
            accessorDesc === undefined ||
            accessorDesc.get !== getter ||
            accessorDesc.set !== setter ||
            accessorDesc.enumerable !== false ||
            accessorDesc.configurable !== true
          ) return 18;

          const frozen: any = {};
          Object.defineProperty(frozen, "field", {
            value: 30,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          Object.freeze(frozen);
          const frozenDesc: any = getDescriptor(frozen, "field");
          if (
            frozenDesc === undefined ||
            frozenDesc.value !== 30 ||
            frozenDesc.writable !== false ||
            frozenDesc.enumerable !== true ||
            frozenDesc.configurable !== false
          ) return 19;

          const sealed: any = {};
          Object.defineProperty(sealed, "field", {
            value: 40,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          Object.seal(sealed);
          const sealedDesc: any = getDescriptor(sealed, "field");
          if (
            sealedDesc === undefined ||
            sealedDesc.value !== 40 ||
            sealedDesc.writable !== true ||
            sealedDesc.enumerable !== false ||
            sealedDesc.configurable !== false
          ) return 20;

          const deleted: any = {};
          Object.defineProperty(deleted, "field", {
            value: 50,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          delete deleted.field;
          if (getDescriptor(dynamic, "missing") !== undefined) return 21;
          if (getDescriptor(deleted, "field") !== undefined) return 22;
          return 0;
        }
      `,
      {
        fileName: "issue-1712-reflection-identity.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(0);
  });

  it.each([
    {
      name: "defineProperty",
      source: `
        const define = Object.defineProperty;
        const get = Object.getOwnPropertyDescriptor;
        const unrelatedBefore = Math.abs;
        export function run(): number {
          const obj: any = {};
          define(obj, "field", { value: 11, writable: false, enumerable: true, configurable: true });
          const direct: any = Object.getOwnPropertyDescriptor(obj, "field");
          const stored: any = get(obj, "field");
          if (direct === undefined || stored === undefined) return 1;
          if (direct.value !== 11 || stored.value !== 11 || stored.writable !== false) return 2;
          obj.field = 99;
          if (obj.field !== 11) return 3;
          const unrelatedAfter = Math.pow;
          return 0;
        }
      `,
    },
    {
      name: "defineProperties",
      source: `
        const defineMany = Object.defineProperties;
        const get = Object.getOwnPropertyDescriptor;
        const unrelatedBefore = Math.abs;
        export function run(): number {
          const obj: any = {};
          defineMany(obj, {
            first: { value: 21, writable: true, enumerable: true, configurable: true },
            second: { value: 22, writable: false, enumerable: false, configurable: true },
          });
          const first: any = get(obj, "first");
          const second: any = Object.getOwnPropertyDescriptor(obj, "second");
          if (first === undefined || second === undefined) return 1;
          if (first.value !== 21 || first.writable !== true || second.value !== 22 || second.writable !== false) return 2;
          obj.second = 99;
          if (obj.second !== 22) return 3;
          const unrelatedAfter = Math.pow;
          return 0;
        }
      `,
    },
    {
      name: "freeze",
      source: `
        const freeze = Object.freeze;
        const get = Object.getOwnPropertyDescriptor;
        const unrelatedBefore = Math.abs;
        export function run(): number {
          const obj: any = {};
          Object.defineProperty(obj, "field", { value: 31, writable: true, enumerable: true, configurable: true });
          freeze(obj);
          const direct: any = Object.getOwnPropertyDescriptor(obj, "field");
          const stored: any = get(obj, "field");
          if (direct === undefined || stored === undefined) return 1;
          if (direct.writable !== false || stored.writable !== false || stored.configurable !== false) return 2;
          const unrelatedAfter = Math.pow;
          return 0;
        }
      `,
    },
    {
      name: "seal",
      source: `
        const seal = Object.seal;
        const get = Object.getOwnPropertyDescriptor;
        const unrelatedBefore = Math.abs;
        export function run(): number {
          const obj: any = {};
          Object.defineProperty(obj, "field", { value: 41, writable: true, enumerable: false, configurable: true });
          seal(obj);
          const direct: any = Object.getOwnPropertyDescriptor(obj, "field");
          const stored: any = get(obj, "field");
          if (direct === undefined || stored === undefined) return 1;
          if (direct.writable !== true || stored.writable !== true || stored.configurable !== false) return 2;
          const unrelatedAfter = Math.pow;
          return 0;
        }
      `,
    },
    {
      name: "getOwnPropertyDescriptor",
      source: `
        const get = Object.getOwnPropertyDescriptor;
        const unrelatedBefore = Math.abs;
        export function run(): number {
          const obj: any = {};
          Object.defineProperty(obj, "field", { value: 51, writable: false, enumerable: true, configurable: false });
          const stored: any = get(obj, "field");
          const direct: any = Object.getOwnPropertyDescriptor(obj, "field");
          if (stored === undefined || direct === undefined) return 1;
          if (stored.value !== direct.value || stored.writable !== direct.writable || stored.configurable !== false) return 2;
          const unrelatedAfter = Math.pow;
          return 0;
        }
      `,
    },
  ])("keeps stored $name on one order-independent descriptor provider", async ({ name, source }) => {
    const result = await compile(source, {
      fileName: `issue-1712-stored-${name}.ts`,
      target: "standalone",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(0);
  });

  it("stamp-dispatches JSDoc descriptor unions while keeping classes nominal", async () => {
    const result = await compile(
      `
        const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);

        /**
         * @param {PropertyDescriptor|undefined} desc
         * @returns {number}
         */
        function inspect(desc) {
          if (desc === undefined) return 1;
          if (hasOwn(desc, "configurable") && desc.configurable !== false) return 2;
          if (hasOwn(desc, "writable") && desc.writable !== false) return 3;
          if (desc.get !== undefined) return 4;
          return 0;
        }

        class Expected {
          constructor() {
            this.flag = true;
          }
        }
        class Other {
          constructor() {
            this.flag = true;
          }
        }

        /**
         * @param {Expected|undefined} value
         * @returns {boolean}
         */
        function readExpected(value) {
          if (value === undefined) return false;
          return value.flag;
        }

        export function run() {
          // Same JSDoc union boundary, two exact object-literal shapes whose
          // leading boolean slots are structurally canonicalisable.
          if (inspect({ configurable: false }) !== 0) return 1;
          if (inspect({ writable: false, value: 10 }) !== 0) return 2;
          if (inspect(undefined) !== 1) return 3;

          // A class receiver remains nominal: a different same-field class
          // must not be accepted by structural field-name dispatch.
          let threw = false;
          try {
            readExpected(/** @type {any} */ (new Other()));
          } catch {
            threw = true;
          }
          if (!threw) return 4;
          return 0;
        }
      `,
      {
        allowJs: true,
        fileName: "issue-1712-structural-jsdoc.js",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(0);
  });

  it.each(PROPERTY_HELPER_CASES)(
    "passes the faithful propertyHelper path for %s",
    { timeout: 60_000 },
    async (relative) => {
      const result = await runTest262File(
        resolve("test262/test", relative),
        "issue-1712-reflection",
        60_000,
        "standalone",
      );
      expect(result.status, result.error ?? result.reason).toBe("pass");
    },
  );
});

describe("#1712 host null-receiver boundary", () => {
  it("preserves host Object.freeze identity and closed-struct field reads", async () => {
    await assertEquivalent(
      `
        export function run(): number {
          const obj = { value: 42 };
          const frozen = Object.freeze(obj);
          return frozen === obj && frozen.value === 42 ? 1 : 0;
        }
      `,
      [{ fn: "run", args: [] }],
    );
  });

  it("preserves host defineProperty return, value, and redefine semantics", async () => {
    await assertEquivalent(
      `
        export function run(): number {
          const obj: any = {};
          const first = Object.defineProperty(obj, "value", {
            value: 10,
            writable: true,
            configurable: true,
          });
          const second = Object.defineProperty(obj, "value", {
            value: 42,
            writable: false,
            configurable: false,
          });
          return first === obj && second === obj && obj.value === 42 ? 1 : 0;
        }
      `,
      [{ fn: "run", args: [] }],
    );
  });

  it.each(HOST_REALM_NULL_RECEIVER_CASES)(
    "keeps backup-cast recovery out of the host lane for %s",
    { timeout: 60_000 },
    async (relative) => {
      const result = await runTest262File(resolve("test262/test", relative), "issue-1712-host-realm", 60_000);
      expect(result.status).toBe("fail");
      expect(result.error).toContain("TypeError: Cannot access property on null or undefined");
      expect(result.error).not.toContain("dereferencing a null pointer");
    },
  );

  it.each(HOST_CLOSURE_ARGC_CASES)(
    "keeps standalone actual-argc preservation out of the host lane for %s",
    { timeout: 60_000 },
    async (relative) => {
      const result = await runTest262File(resolve("test262/test", relative), "issue-1712-host-argc", 60_000);
      expect(result.status, result.error ?? result.reason).toBe("pass");
    },
  );
});
