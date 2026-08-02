// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 — algorithms.ts whole-component slice: the four capabilities that let
// the `js/algorithms.ts` call-component (main → fibIter/fibMemo/joinNums/
// binarySearch/quicksort) claim atomically on the IR path.
//
//   C1  statement-level `if` (+else) inside body buffers, and early `return`
//       from inside a C-style loop (`early.return` → Wasm `return`).
//   C2  element store `arr[i] = v` via the on-demand `__vec_elem_set_<t>`
//       helper (full legacy parity: null-guard, grow-on-OOB, length update).
//   C3  module-scope `const m = new Map()` receiver — TDZ-checked
//       `global.get $__mod_<m>` branded `extern:Map`, `.get`/`.set` through
//       the extern method-call machinery, strict undefined-compare, and the
//       `__box_number`/`__unbox_number` coercion arms (JS-host lane).
//   C4  the #1804 array-literal-under-C-loop guard retired (the slice-12
//       buffer machinery already materializes the constructed vec into a
//       local before the loop op), plus call-arg `ref → ref_null` widening
//       and statement-position void direct calls.
//
// Every case asserts legacy/IR observable equality AND (where marked) that
// the IR path was genuinely exercised — bytes must differ from the
// `experimentalIR: false` compile, so a silent legacy demote fails the test
// (the vacuous-pass hazard).
import { describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

interface RunResult {
  value: unknown;
  binary: Uint8Array;
  postClaim: unknown[];
  logs: string[];
  irOutcomes: readonly IrObservedOutcome[];
}

async function compileRun(source: string, fn: string, args: unknown[], experimentalIR: boolean): Promise<RunResult> {
  const logs: string[] = [];
  const r = await compile(source, { experimentalIR, trackFallbacks: true, trackIrOutcomes: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  built.env.console_log_string = (v: unknown) => logs.push(String(v));
  built.env.console_log_number = (v: unknown) => logs.push(String(v));
  built.env.console_log_bool = (v: unknown) => logs.push(String(!!v));
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  const f = (instance.exports as Record<string, unknown>)[fn];
  if (typeof f !== "function") throw new Error(`export ${fn} missing`);
  return {
    value: (f as (...a: unknown[]) => unknown)(...args),
    binary: r.binary,
    postClaim: r.irPostClaimErrors ?? [],
    logs,
    irOutcomes: r.irOutcomes ?? [],
  };
}

/**
 * Assert legacy and IR agree on the observable result, the IR compile has
 * ZERO post-claim demotions, and (when `expectClaimed`) the IR path was
 * genuinely taken (bytes differ — not a vacuous legacy-vs-legacy pass).
 */
async function expectParity(
  source: string,
  fn: string,
  args: unknown[],
  expected: unknown,
  opts: { expectClaimed?: boolean } = {},
): Promise<RunResult> {
  const legacy = await compileRun(source, fn, args, false);
  const ir = await compileRun(source, fn, args, true);
  expect(legacy.value, "legacy value").toStrictEqual(expected);
  expect(ir.value, "IR value matches legacy").toStrictEqual(legacy.value);
  expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  if (opts.expectClaimed !== false) {
    expect(
      Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0,
      "IR path exercised (bytes differ from legacy)",
    ).toBe(true);
  }
  return ir;
}

describe("#2856 C1 — if / early-return inside body buffers", () => {
  it("if (no else) inside a for body", async () => {
    await expectParity(
      `export function main(): number {
         let s = 0;
         for (let i = 0; i < 10; i++) { if (i % 2 === 0) s = s + i; }
         return s;
       }`,
      "main",
      [],
      20,
    );
  });

  it("if/else inside a while body (binary search halving)", async () => {
    await expectParity(
      `function bs(arr: number[], target: number): number {
         let lo = 0;
         let hi = arr.length - 1;
         while (lo <= hi) {
           const mid = (lo + hi) >> 1;
           const v = arr[mid];
           if (v === target) return mid;
           if (v < target) { lo = mid + 1; } else { hi = mid - 1; }
         }
         return -1;
       }
       export function main(): number {
         const sorted = [1, 3, 5, 8, 13, 21, 34, 55, 89, 144];
         return bs(sorted, 13) * 100 + bs(sorted, 34) * 10 + (bs(sorted, 7) + 1);
       }`,
      "main",
      [],
      460,
    );
  });

  it("early value return from inside a while loop", async () => {
    await expectParity(
      `function firstAbove(arr: number[], limit: number): number {
         let i = 0;
         while (i < arr.length) {
           if (arr[i] > limit) return arr[i];
           i++;
         }
         return -1;
       }
       export function main(): number {
         const xs = [3, 9, 4, 17, 2];
         return firstAbove(xs, 8) * 1000 + firstAbove(xs, 100);
       }`,
      "main",
      [],
      8999,
    );
  });

  it("early bare return from a loop in a void function", async () => {
    await expectParity(
      `let seen = 0;
       function scan(n: number): void {
         for (let i = 0; i < n; i++) {
           if (i === 3) return;
           seen = seen + 1;
         }
       }
       export function main(): number {
         scan(10);
         return seen;
       }`,
      "main",
      [],
      3,
      // `seen` is a module-scope mutable binding — scan/main stay legacy;
      // the point is behavior stays correct (no claim expected).
      { expectClaimed: false },
    );
  });

  it("early return inside try/finally stays on legacy (finally must run)", async () => {
    // The selector must NOT claim an early return under a finally — a Wasm
    // `return` would skip the inlined finally. Behavior parity is the bar.
    await expectParity(
      `function f(n: number): number {
         let cleanup = 0;
         for (let i = 0; i < n; i++) {
           try {
             if (i === 1) return 100 + cleanup;
           } finally {
             cleanup = cleanup + 1;
           }
         }
         return cleanup;
       }
       export function main(): number { return f(5); }`,
      "main",
      [],
      101,
      { expectClaimed: false },
    );
  });
});

describe("#2856 C2 — element store arr[i] = v", () => {
  it("in-place swap writes (quicksort) — whole component claims", async () => {
    const ir = await expectParity(
      `function quicksort(arr: number[], lo: number, hi: number): void {
         if (lo >= hi) return;
         const pivot = arr[hi];
         let i = lo - 1;
         for (let j = lo; j < hi; j++) {
           if (arr[j] <= pivot) {
             i++;
             const tmp = arr[i];
             arr[i] = arr[j];
             arr[j] = tmp;
           }
         }
         const tmp = arr[i + 1];
         arr[i + 1] = arr[hi];
         arr[hi] = tmp;
         const p = i + 1;
         quicksort(arr, lo, p - 1);
         quicksort(arr, p + 1, hi);
       }
       export function main(): number {
         const unsorted = [5, 2, 8, 1, 9, 3, 7, 4, 6, 0];
         quicksort(unsorted, 0, unsorted.length - 1);
         let acc = 0;
         for (let i = 0; i < 10; i++) { acc = acc * 10 + unsorted[i]; }
         return acc;
       }`,
      "main",
      [],
      123456789,
    );
    const componentNames = ["quicksort", "main"];
    const outcomes = new Map(ir.irOutcomes.map((outcome) => [outcome.displayName, outcome]));
    for (const name of componentNames) {
      expect(outcomes.get(name), `${name} is emitted once through prepared IR`).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(new Set(componentNames.map((name) => outcomes.get(name)?.preparedComponentId)).size).toBe(1);
  });

  it("growing store — write past the end grows capacity and length", async () => {
    await expectParity(
      `export function main(): number {
         const a = [9];
         for (let i = 0; i < 6; i++) { a[i] = i + 1; }
         return a.length * 1000000 + a[0] * 10 + a[5];
       }`,
      "main",
      [],
      6000016,
    );
  });

  it("store through a param (possibly-null vec) round-trips", async () => {
    await expectParity(
      `function w(a: number[], i: number, v: number): number { a[i] = v; return a[i]; }
       export function main(): number { const xs = [1, 2, 3]; return w(xs, 1, 42); }`,
      "main",
      [],
      42,
    );
  });

  it("reassigned vector locals and parameters remain prepared slot values", async () => {
    const ir = await expectParity(
      `function sum(arr: number[]): number {
         let total = 0;
         for (let i = 0; i < arr.length; i++) {
           total += arr[i];
           if (i === 1) arr = [9, 9];
         }
         return total;
       }
       export function main(): number {
         let xs: number[] = [1, 2, 3, 4];
         const result = sum(xs);
         xs = [7, 8];
         return result * 100 + xs[1];
       }`,
      "main",
      [],
      308,
    );
    const outcomes = new Map(ir.irOutcomes.map((outcome) => [outcome.displayName, outcome]));
    for (const name of ["sum", "main"]) {
      expect(outcomes.get(name), `${name} is emitted once through prepared IR`).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
  });
});

describe("#2856 C3 — module-scope Map + strict undefined-compare (JS-host lane)", () => {
  it("memoized fib through a module-scope Map claims and agrees", async () => {
    await expectParity(
      `const cache = new Map<number, number>();
       function memo(n: number): number {
         if (n < 2) return n;
         const hit = cache.get(n);
         if (hit !== undefined) return hit;
         const v = memo(n - 1) + memo(n - 2);
         cache.set(n, v);
         return v;
       }
       export function main(): number { return memo(30); }`,
      "main",
      [],
      832040,
    );
  });

  it("mixed front-ends share the Map storage slot (IR writer, legacy reader)", async () => {
    // `reader` uses a labeled block — a direct-only statement kind, so it
    // stays on the LEGACY front-end while `writer` claims on the IR path.
    // The two are separate exports with no local caller (a shared local
    // `main` would contagion-demote writer alongside reader), driven from
    // the harness: the value written by the IR-compiled function must be
    // read back by the legacy-compiled one through the SAME `__mod_shared`
    // global (storage-slot parity).
    const src = `const shared = new Map<number, number>();
       export function writer(k: number, v: number): number {
         let i = 0;
         while (i < 1) { shared.set(k, v); i++; }
         return i;
       }
       export function reader(k: number): number {
         outer: {
           const hit = shared.get(k);
           if (hit !== undefined) return hit;
         }
         return -1;
       }`;
    for (const experimentalIR of [false, true]) {
      const r = await compile(src, { experimentalIR, trackFallbacks: true });
      expect(r.success).toBe(true);
      const built = buildImports(r.imports, ENV_STUB, r.stringPool);
      const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
      imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      built.setExports?.(instance.exports as Record<string, Function>);
      const ex = instance.exports as Record<string, (...a: number[]) => number>;
      ex.writer!(7, 4200);
      expect(ex.reader!(7), `read-back (${experimentalIR ? "IR" : "legacy"})`).toBe(4200);
      expect(ex.reader!(8), `missing key (${experimentalIR ? "IR" : "legacy"})`).toBe(-1);
      if (experimentalIR) {
        expect(r.irPostClaimErrors ?? []).toStrictEqual([]);
        // writer genuinely claimed: its IR compile must differ from legacy.
        const legacyR = await compile(src, { experimentalIR: false });
        expect(Buffer.compare(Buffer.from(legacyR.binary), Buffer.from(r.binary)) !== 0, "writer claimed").toBe(true);
      }
    }
  });

  it("strict undefined-compare folds on an f64 operand (matches legacy)", async () => {
    await expectParity(
      `function f(x: number): number {
         if (x !== undefined) return 1;
         return 0;
       }
       export function main(): number { return f(5); }`,
      "main",
      [],
      1,
      // Whether this claims depends on TypeMap details; the bar is parity.
      { expectClaimed: false },
    );
  });
});

describe("#2856 C4 — array literal + C-style loop (retired #1804 guard)", () => {
  it("constructed vec read inside a for body", async () => {
    await expectParity(
      `export function main(): number {
         const a = [1, 2, 3, 4];
         let s = 0;
         for (let i = 0; i < 4; i++) { s = s + a[i]; }
         return s;
       }`,
      "main",
      [],
      10,
    );
  });

  it("constructed vec read in a while cond", async () => {
    await expectParity(
      `export function main(): number {
         const a = [10, 20, 0, 5];
         let i = 0;
         let s = 0;
         while (a[i] > 0) { s = s + a[i]; i++; }
         return s;
       }`,
      "main",
      [],
      30,
    );
  });

  it("vec constructed inside the loop body (fresh per iteration)", async () => {
    await expectParity(
      `export function main(): number {
         let s = 0;
         for (let i = 0; i < 3; i++) {
           const a = [i, i * 2, i * 3];
           s = s + a[0] + a[1] + a[2];
         }
         return s;
       }`,
      "main",
      [],
      18,
    );
  });

  it("literal-after-loop passed as a ref arg into a ref_null param", async () => {
    await expectParity(
      `function g(xs: number[]): number { let t = 0; for (const x of xs) { t += x; } return t; }
       export function main(): number {
         let acc = 0;
         for (let n = 0; n < 3; n++) { acc = acc + n; }
         const sorted = [1, 3, 5];
         return acc + g(sorted) + sorted.length;
       }`,
      "main",
      [],
      15,
    );
  });

  it("nested loops + do-while over a constructed vec", async () => {
    await expectParity(
      `export function main(): number {
         const a = [1, 2, 3];
         let s = 0;
         for (let i = 0; i < 3; i++) {
           let j = 0;
           while (j < 3) { s = s + a[i] * a[j]; j++; }
         }
         let k = 0;
         do { s = s + a[k]; k++; } while (k < 3);
         return s;
       }`,
      "main",
      [],
      42,
    );
  });
});

describe("#2856 — whole algorithms.ts component end-to-end", () => {
  // A trimmed copy of website/playground/examples/js/algorithms.ts (the gate
  // corpus file): the five-function call-component must claim atomically and
  // produce console output identical to legacy.
  const ALGORITHMS = `
    function fibIter(n: number): number {
      let a = 0;
      let b = 1;
      for (let i = 0; i < n; i++) {
        const next = a + b;
        a = b;
        b = next;
      }
      return a;
    }
    const fibCache = new Map<number, number>();
    function fibMemo(n: number): number {
      if (n < 2) return n;
      const hit = fibCache.get(n);
      if (hit !== undefined) return hit;
      const v = fibMemo(n - 1) + fibMemo(n - 2);
      fibCache.set(n, v);
      return v;
    }
    function binarySearch(arr: number[], target: number): number {
      let lo = 0;
      let hi = arr.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = arr[mid];
        if (v === target) return mid;
        if (v < target) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return -1;
    }
    function quicksort(arr: number[], lo: number, hi: number): void {
      if (lo >= hi) return;
      const pivot = arr[hi];
      let i = lo - 1;
      for (let j = lo; j < hi; j++) {
        if (arr[j] <= pivot) {
          i++;
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }
      }
      const tmp = arr[i + 1];
      arr[i + 1] = arr[hi];
      arr[hi] = tmp;
      const p = i + 1;
      quicksort(arr, lo, p - 1);
      quicksort(arr, p + 1, hi);
    }
    function joinNums(arr: number[]): string {
      let s = "";
      for (let i = 0; i < arr.length; i++) {
        if (i > 0) s = s + ",";
        s = s + arr[i].toString();
      }
      return s;
    }
    export function main(): void {
      console.log("fib(10) iter = " + fibIter(10).toString() + " memo = " + fibMemo(10).toString());
      const sorted = [1, 3, 5, 8, 13, 21, 34, 55, 89, 144];
      console.log("indexOf(13) = " + binarySearch(sorted, 13).toString());
      console.log("indexOf(7)  = " + binarySearch(sorted, 7).toString());
      const unsorted = [5, 2, 8, 1, 9, 3, 7, 4, 6, 0];
      quicksort(unsorted, 0, unsorted.length - 1);
      console.log("after = [" + joinNums(unsorted) + "]");
    }`;

  it("console output identical, component claimed, zero demotions", async () => {
    const legacy = await compileRun(ALGORITHMS, "main", [], false);
    const ir = await compileRun(ALGORITHMS, "main", [], true);
    expect(ir.postClaim).toStrictEqual([]);
    expect(ir.logs).toStrictEqual(legacy.logs);
    expect(ir.logs.length).toBeGreaterThan(0);
    expect(ir.logs[ir.logs.length - 1]).toBe("after = [0,1,2,3,4,5,6,7,8,9]");
    expect(Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0, "IR path exercised").toBe(true);
    expect(WebAssembly.validate(ir.binary)).toBe(true);
  });

  it("standalone / wasi compiles stay clean (host-gated Map arm defers)", async () => {
    for (const extra of [{ target: "standalone" as const }, { target: "wasi" as const }]) {
      const r = await compile(ALGORITHMS, { experimentalIR: true, trackFallbacks: true, ...(extra as object) });
      expect(r.success, `compile ok under ${JSON.stringify(extra)}`).toBe(true);
      expect(r.irPostClaimErrors ?? []).toStrictEqual([]);
    }
  });
});
