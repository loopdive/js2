// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (split from the IR vector element keys change) — the shared grow-store
// helper `__vec_elem_set_<vecTypeIdx>` filled an f64 grow gap with zeroes on gc,
// and on standalone without hole presence, so an index past the old length
// read back as `0`. Legacy's inline store marks the same gap (#4491 T8/T11).
// Legacy reaches the helper through `__extern_set` / `__vec_dp_value`, so the
// gap is observable with the IR off as well as on.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Target = "gc" | "standalone";
type Result = Awaited<ReturnType<typeof compile>>;

const TARGETS: readonly Target[] = ["standalone", "gc"];

async function instantiate(result: Result): Promise<WebAssembly.Instance> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  (result.importObject as { __setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(instance);
  return instance;
}

/** Each row is 1 when the gap answers as node does; main's helper fails the first seven. */
const GAP_OBSERVERS: Record<string, string> = {
  read: `a[1] === undefined`,
  readAny: `o[2] === undefined`,
  typeofGap: `typeof o[1] === "undefined"`,
  nullish: `(o[1] ?? 7) === 7`,
  join: `a.join() === "1.5,,,2"`,
  json: `JSON.stringify(a) === "[1.5,null,null,2]"`,
  includes: `a.includes(undefined as any)`,
  length: `a.length === 4`,
  indexOf: `a.indexOf(undefined as any) === -1`,
};

const observerSource = Object.entries(GAP_OBSERVERS)
  .map(
    ([name, test]) => `export function ${name}(): number {
      const a: number[] = [1.5];
      const o: any = a;
      o[3] = 2;
      return ${test} ? 1 : 0;
    }`,
  )
  .join("\n");

describe("#7106 — an f64 grow gap holds a marker, not zeroes", () => {
  it("node agrees with every observer row", () => {
    const a: number[] = [1.5];
    const o: any = a;
    o[3] = 2;
    const answers = Object.values(GAP_OBSERVERS).map((test) =>
      new Function("a", "o", `return ${test.replaceAll(" as any", "")};`)(a, o),
    );
    expect(answers.every(Boolean)).toBe(true);
  });

  for (const target of TARGETS) {
    for (const experimentalIR of [false, true]) {
      it(`a gap written through an any alias reads as absent (${target}, ${experimentalIR ? "IR" : "legacy"})`, async () => {
        const result = await compile(observerSource, {
          fileName: "test.ts",
          experimentalIR,
          ...(target === "standalone" ? { target: "standalone" as const } : {}),
        });
        const exports = (await instantiate(result)).exports as Record<string, () => number>;
        const answers = Object.fromEntries(Object.keys(GAP_OBSERVERS).map((name) => [name, exports[name]!()]));
        expect(answers).toEqual(Object.fromEntries(Object.keys(GAP_OBSERVERS).map((name) => [name, 1])));
      }, 60_000);
    }

    it(`an IR store past the length leaves the gap undefined, NaN to a numeric consumer (${target})`, async () => {
      // Was 1: the gap read back as 0.
      const result = await compile(
        `export function gap(): number { const a: number[] = [1]; a[3] = 3; return a[1] + 1; }`,
        {
          fileName: "test.ts",
          trackIrOutcomes: true,
          ...(target === "standalone" ? { target: "standalone" as const } : {}),
        },
      );
      expect((result.irOutcomes ?? []).find((o) => o.displayName === "gap")?.irBodyEmitted).toBe(true);
      expect(((await instantiate(result)).exports.gap as () => number)()).toBeNaN();
    }, 60_000);
  }
});
