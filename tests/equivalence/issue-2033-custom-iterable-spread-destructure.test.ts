// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2033 — spread of a user-defined iterable (object with `[Symbol.iterator]()`)
 * must consult the iterator protocol, exactly like for-of.
 *
 * Before this fix `[...obj]` fell into the generic vec-struct spread path and
 * read the iterator-closure field as an i32 length → invalid wasm
 * (`i32.add expected i32, found struct.get of type externref`). It now drains
 * the iterator via `__iterator` / `__iterator_next` (the same JS-host bridge
 * for-of uses) into a vec.
 *
 * `assertEquivalent` runs the compiled wasm with the host iterator bridge and
 * compares the result against Node.
 */
import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

const ITERABLE = `
  const obj = {
    [Symbol.iterator]() {
      let i = 0;
      const data = [10, 20, 30];
      return {
        next: () =>
          i < data.length ? { value: data[i++], done: false } : { value: 0, done: true },
      };
    },
  };
`;

describe("#2033 — spread of a custom iterable", () => {
  it("[...obj] sums the yielded values (was invalid wasm)", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const a = [...obj];
        return a[0] + a[1] + a[2];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("[...obj].length equals the number of yielded values", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const a = [...obj];
        return a.length;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread mixed with literal elements preserves order and count", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const a = [1, ...obj, 2];
        // 1 + 10 + 20 + 30 + 2 = 63; length 5
        return a.length * 1000 + a[0] + a[1] + a[2] + a[3] + a[4];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread feeds for-of identically (round-trip through the protocol)", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        let s = 0;
        for (const x of [...obj]) s += x;
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("#2033 — array-destructuring a custom iterable", () => {
  it("const [a, b] = obj reads the first two yielded values (was NaN)", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const [a, b] = obj;
        return a + b;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("const [a, b, c] = obj reads all three in order", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const [a, b, c] = obj;
        return a * 100 + b * 10 + c;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("binding default fires when the iterator is exhausted (OOB → undefined)", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const [a, b, c, d = 99] = obj;
        return d;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("skipped first element still advances the iterator", async () => {
    await assertEquivalent(
      `export function test(): number {
        ${ITERABLE}
        const [, second, third] = obj;
        return second * 10 + third;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
