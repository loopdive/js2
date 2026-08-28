// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import { executeIndirectEval } from "../../src/interp/index.js";
import { loadAcorn, parse } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

const parser = (source: string): unknown => parse(source);

describe("runtime-eval object methods and accessors", () => {
  it("evaluates computed method keys before installing callable methods", () => {
    const globalObject = Object.create(globalThis);
    expect(
      executeIndirectEval(
        parser,
        `
          var log = "";
          var key = (log += "k", "sum");
          var object = {
            base: 40,
            [key](value) { return this.base + value; },
            observed: (log += "v"),
          };
          object.sum(2) + (log === "kv" ? 0 : 100);
        `,
        globalObject,
      ),
    ).toBe(42);
  });

  it("creates enumerable configurable getter/setter pairs with inferred names", () => {
    const globalObject = Object.create(globalThis);
    const object = executeIndirectEval(
      parser,
      `
        globalThis.reads = 0;
        globalThis.writes = 0;
        ({
          get next() {
            globalThis.reads = globalThis.reads + 1;
            return this._value;
          },
          set next(value) {
            globalThis.writes = globalThis.writes + 1;
            this._value = value;
          },
        });
      `,
      globalObject,
    );

    expect(globalObject.reads).toBe(0);
    object.next = 7;
    expect(globalObject.writes).toBe(1);
    expect(object.next).toBe(7);
    expect(globalObject.reads).toBe(1);

    const descriptor = Object.getOwnPropertyDescriptor(object, "next");
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.configurable).toBe(true);
    expect(descriptor?.get?.name).toBe("get next");
    expect(descriptor?.set?.name).toBe("set next");
  });

  it("propagates a nested next getter exception from a computed iterator method", () => {
    const globalObject = Object.create(globalThis);
    const iterable = executeIndirectEval(
      parser,
      `
        ({
          [Symbol.iterator]() {
            return {
              get next() {
                throw new TypeError("boom");
              },
            };
          },
        });
      `,
      globalObject,
    );

    const iterator = iterable[Symbol.iterator]();
    expect(() => iterator.next).toThrow("boom");
  });

  it("lets sequence consumers read next once and reuse the returned callback", () => {
    const globalObject = Object.create(globalThis);
    const iterable = executeIndirectEval(
      parser,
      `
        globalThis.nextReads = 0;
        globalThis.index = 0;
        ({
          [Symbol.iterator]() {
            return {
              get next() {
                globalThis.nextReads = globalThis.nextReads + 1;
                if (globalThis.nextReads > 1) throw new Error("next getter called twice");
                return () => {
                  globalThis.index = globalThis.index + 1;
                  if (globalThis.index === 1) return { done: false, value: 1 };
                  if (globalThis.index === 2) return { done: false, value: 2 };
                  return { done: true, value: undefined };
                };
              },
            };
          },
        });
      `,
      globalObject,
    );

    const iterator = iterable[Symbol.iterator]();
    const next = iterator.next;
    expect(next()).toEqual({ done: false, value: 1 });
    expect(next()).toEqual({ done: false, value: 2 });
    expect(next()).toEqual({ done: true, value: undefined });
    expect(globalObject.nextReads).toBe(1);
  });

  it("updates a member reference once for prefix and postfix expressions", () => {
    const globalObject = Object.create(globalThis);
    expect(
      executeIndirectEval(
        parser,
        `
          globalThis.reads = 0;
          globalThis.keyReads = 0;
          var object = {
            value: 40,
            get next() { globalThis.reads++; return this.value; },
            set next(value) { globalThis.reads++; this.value = value; },
          };
          var key = () => (globalThis.keyReads++, "next");
          var old = object[key()]++;
          var current = ++object.next;
          old + current + globalThis.reads + globalThis.keyReads;
        `,
        globalObject,
      ),
    ).toBe(87);
  });
});
