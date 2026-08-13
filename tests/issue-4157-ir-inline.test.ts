// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) IR-level inliner for user code — behaviour must be identical with the
 * flag ON and OFF, and the binary must be BYTE-identical to the legacy compiler
 * when the flag is `0`.
 *
 * The inliner is **default ON** since the tuned-set flip (`src/perf-flags.ts`),
 * so the byte-identity guarantee moved from *absence* to *an explicit
 * off-token*; `report` is now compared against `=0` rather than against unset,
 * because unset mutates.
 *
 * The constructs here are the ones the rewrite can get wrong (see
 * `src/codegen/ir-inline.ts`): closure captures, recursion, loop-carried
 * control flow with `break`/`continue`, early `return` from inside nested
 * blocks, and `this`-binding through a method call. A wrong inline in any of
 * them is a SILENT miscompile, so each is pinned by value rather than by
 * "compiles".
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const FLAG = "JS2WASM_IR_INLINE";

afterEach(() => {
  delete process.env[FLAG];
});

async function build(source: string): Promise<Uint8Array> {
  const r = await compile(source, {
    fileName: "inline-probe.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize: 0,
  });
  if (!r.binary?.length) throw new Error(`compile failed: ${JSON.stringify((r.errors ?? []).slice(0, 2))}`);
  return r.binary;
}

async function run(source: string): Promise<number> {
  const binary = await build(source);
  const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  return (exports.probe as () => number)();
}

const PROBES: { name: string; source: string; expected: number }[] = [
  {
    name: "closure captures survive local renumbering",
    source: `
      function makeAdder(a: number) {
        let acc = a;
        return function (b: number): number { acc = acc + b; return acc; };
      }
      export function probe(): number {
        const add = makeAdder(10);
        return add(1) + add(2) + add(3);
      }`,
    // 11 + 13 + 16
    expected: 40,
  },
  {
    name: "recursion is not flattened into the caller",
    source: `
      function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
      export function probe(): number { return fib(15); }`,
    expected: 610,
  },
  {
    name: "early return from a nested block becomes the right branch target",
    source: `
      function classify(n: number): number {
        for (let i = 0; i < 10; i++) {
          if (i === n) {
            if (i % 2 === 0) return i * 100;
            return i * 10;
          }
          if (i > 6) break;
        }
        return -1;
      }
      export function probe(): number {
        return classify(4) + classify(5) + classify(9);
      }`,
    // 400 + 50 + (-1)
    expected: 449,
  },
  {
    name: "loop-carried break/continue keep their labels",
    source: `
      function sum(): number {
        let total = 0;
        for (let i = 0; i < 20; i++) {
          if (i % 3 === 0) continue;
          if (i > 15) break;
          total = total + i;
        }
        return total;
      }
      export function probe(): number { return sum(); }`,
    // 1+2+4+5+7+8+10+11+13+14 (multiples of 3 skipped, loop broken at i=16)
    expected: 75,
  },
  {
    name: "this-binding is preserved through a method call",
    source: `
      class Counter {
        n: number = 0;
        step(k: number): number { this.n = this.n + k; return this.n; }
        total(): number { return this.step(1) + this.step(2) + this.step(3); }
      }
      export function probe(): number { return new Counter().total(); }`,
    // 1 + 3 + 6
    expected: 10,
  },
  {
    name: "constant arguments do not corrupt a shared callee",
    source: `
      function pick(flag: number, a: number, b: number): number { return flag !== 0 ? a : b; }
      export function probe(): number {
        let acc = 0;
        for (let i = 0; i < 5; i++) acc = acc + pick(1, 7, 9) + pick(0, 7, 9) + pick(i % 2, 100, 1);
        return acc;
      }`,
    // 5*(7+9) + (1 + 100 + 1 + 100 + 1)
    expected: 283,
  },
];

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("#4157 IR-level inliner", () => {
  test("`=0` is byte-identical to the base compiler, and `report` mutates nothing", async () => {
    process.env[FLAG] = "0";
    const a = await build(PROBES[0].source);
    process.env[FLAG] = "off";
    expect(sha(await build(PROBES[0].source)), "`off` must be the same off-token as `0`").toBe(sha(a));

    process.env[FLAG] = "report";
    // `report` analyses and prints but must not mutate the module — so it lands
    // on the OFF bytes even though it sets `enabled`.
    expect(sha(await build(PROBES[0].source))).toBe(sha(a));
  });

  test("unset runs the `on` preset, and a modifier-only spec does not disable it", async () => {
    process.env[FLAG] = "0";
    const off = sha(await build(PROBES[2].source));
    delete process.env[FLAG];
    const unset = sha(await build(PROBES[2].source));
    process.env[FLAG] = "on";
    const on = sha(await build(PROBES[2].source));
    expect(unset, "unset must inline — the pass is default ON").not.toBe(off);
    expect(unset).toBe(on);
    // `verbose` selects no RULE. Before the flip that meant "off"; now it means
    // "the default set, plus the modifier you asked for".
    process.env[FLAG] = "verbose";
    expect(sha(await build(PROBES[2].source))).toBe(on);
  });

  test("an enabled rule actually changes the binary", async () => {
    process.env[FLAG] = "0";
    const off = await build(PROBES[2].source);
    process.env[FLAG] = "on";
    const on = await build(PROBES[2].source);
    expect(sha(on)).not.toBe(sha(off));
  });

  for (const probe of PROBES) {
    test(`${probe.name} — flag OFF`, async () => {
      process.env[FLAG] = "0";
      expect(await run(probe.source)).toBe(probe.expected);
    });
    test(`${probe.name} — flag ON`, async () => {
      process.env[FLAG] = "on";
      expect(await run(probe.source)).toBe(probe.expected);
    });
    test(`${probe.name} — shipped default (unset)`, async () => {
      delete process.env[FLAG];
      expect(await run(probe.source)).toBe(probe.expected);
    });
  }
});
