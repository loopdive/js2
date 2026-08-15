// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4461 — the native `$Map` struct (#1103a) is a real IR module-binding storage
// kind, so a standalone `Map` claims instead of reporting unrepresentable
// storage.
//
// What these tests protect:
//   - **Selector claim ⇔ lowering parity.** The failure mode this issue was
//     written to avoid is claiming the binding and then handing `from-ast` a
//     lowering that does not exist. So the tests do not stop at "it claimed":
//     they compile, instantiate, RUN, and compare against the same algorithm
//     evaluated in JS. A claim whose lowering is wrong fails here, not in a
//     conformance shard hours later.
//   - **Host-freedom.** The point of the native carrier is that standalone has
//     no JS host. The module is instantiated with an import object that RECORDS
//     any `env.*` lookup, so a regression reintroducing `__box_number` /
//     `__extern_is_undefined` / `__unbox_number` as imports is caught by name.
//   - **No worse than an already-supported binding kind.** The last test is a
//     DIFFERENTIAL, not a fixed expectation: the native-`$Map` binding must
//     behave the same as a plain `let total = 0` module binding under the same
//     call graph. That keeps the known prepared-component residual (see the
//     test's own comment) attributed to where it actually lives, and makes the
//     test self-updating when that residual is fixed.
import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";

const MEMO = `
const fibCache = new Map<number, number>();

function fibMemo(n: number): number {
  if (n < 2) return n;
  const hit = fibCache.get(n);
  if (hit !== undefined) return hit;
  const v = fibMemo(n - 1) + fibMemo(n - 2);
  fibCache.set(n, v);
  return v;
}

export function test(): number {
  let acc = 0;
  for (let n = 0; n < 20; n++) acc = acc + fibMemo(n);
  // Re-read a warm cache so the get-HIT arm runs after the set arm, not only
  // the miss arm a single cold call would exercise.
  acc = acc + fibMemo(19) + fibMemo(10);
  return acc;
}
`;

/** The same algorithm in JS — the oracle the compiled module must match. */
function expectedMemoSum(): number {
  const cache = new Map<number, number>();
  const fib = (n: number): number => {
    if (n < 2) return n;
    const hit = cache.get(n);
    if (hit !== undefined) return hit;
    const v = fib(n - 1) + fib(n - 2);
    cache.set(n, v);
    return v;
  };
  let acc = 0;
  for (let n = 0; n < 20; n++) acc = acc + fib(n);
  return acc + fib(19) + fib(10);
}

interface RunResult {
  readonly value: unknown;
  readonly hostImports: readonly string[];
  readonly outcomes: readonly IrObservedOutcome[];
}

async function compileStandalone(source: string): Promise<{ ok: boolean; outcomes: readonly IrObservedOutcome[] }> {
  const result = await compile(source, { fileName: "test.ts", trackIrOutcomes: true, target: "standalone" });
  return { ok: result.success, outcomes: result.irOutcomes ?? [] };
}

async function compileAndRun(source: string): Promise<RunResult> {
  const result = await compile(source, { fileName: "test.ts", trackIrOutcomes: true, target: "standalone" });
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const hostImports: string[] = [];
  // A Proxy that claims to have every key: instantiation succeeds regardless of
  // what is requested, and every request is recorded. A standalone module must
  // request nothing.
  const env = new Proxy(
    {},
    {
      get(_target, key: string) {
        hostImports.push(`env.${key}`);
        return () => undefined;
      },
      has: () => true,
    },
  );
  const { instance } = await WebAssembly.instantiate(result.binary, { env });
  const exported = (instance.exports as Record<string, () => unknown>).test;
  return { value: exported?.(), hostImports, outcomes: result.irOutcomes ?? [] };
}

function outcomeFor(outcomes: readonly IrObservedOutcome[], displayName: string): IrObservedOutcome {
  const found = outcomes.find((outcome) => outcome.displayName === displayName);
  if (!found) throw new Error(`no IR outcome for ${displayName} (have: ${outcomes.map((o) => o.displayName)})`);
  return found;
}

describe("#4461 native $Map module-binding storage", () => {
  it("claims fibMemo and <module-init> on the standalone lane", async () => {
    const run = await compileAndRun(MEMO);
    expect(outcomeFor(run.outcomes, "fibMemo").kind).toBe("emitted");
    expect(outcomeFor(run.outcomes, "<module-init>").kind).toBe("emitted");
  });

  it("runs the claimed units and matches JS — a claim implies a real lowering", async () => {
    const run = await compileAndRun(MEMO);
    expect(run.value).toBe(expectedMemoSum());
  });

  it("needs no JS host: the native carrier resolves every helper in-module", async () => {
    const run = await compileAndRun(MEMO);
    expect(run.hostImports).toEqual([]);
  });

  it("does not claim a Map whose keys are not numbers (adapter ABI ⇔ claim surface)", async () => {
    // The adapters are f64-keyed. A string-keyed Map must therefore REJECT
    // before claim rather than lower through a numeric coercion that would
    // corrupt SameValueZero hashing.
    const run = await compileAndRun(`
const names = new Map<string, number>();

function lookup(k: string): number {
  const hit = names.get(k);
  if (hit !== undefined) return hit;
  names.set(k, 1);
  return 0;
}

export function test(): number {
  return lookup("a") + lookup("a");
}
`);
    expect(outcomeFor(run.outcomes, "lookup").kind).toBe("unsupported");
    // Legacy still compiles it correctly — the reject is a demote, not a break.
    expect(run.value).toBe(1);
  });

  it("is no worse than an already-supported module binding under the same call graph", async () => {
    // A caller that pulls the binding's reader into its own prepared component
    // currently fails preparation for EVERY module-binding kind: the TDZ global
    // resolves to `module-init`, which is not a candidate terminal of the
    // caller's component (`source-global-outside-component`), and
    // `__new_ReferenceError` has no planned Program ABI identity. Measured on
    // this branch's merge base with the f64 control below, so it is a
    // pre-existing prepared-component limitation, not a native-`$Map` one.
    //
    // This is a DIFFERENTIAL assertion on purpose. Pinning "the map shape
    // fails" would go stale silently the day that limitation is fixed; pinning
    // "the map shape does whatever the f64 shape does" stays true either way,
    // and fails loudly if native-`$Map` ever becomes the WORSE of the two.
    const shared = `
export function test(): number {
  let acc = 0;
  for (let n = 0; n < 20; n++) acc = acc + step(n);
  return acc + step(19) + step(10);
}
`;
    const f64Control = await compileStandalone(
      `
let total = 0;

function step(n: number): number {
  if (n < 2) return n;
  total = total + n;
  return total;
}
${shared}`,
    );
    const nativeMap = await compileStandalone(
      `
const cache = new Map<number, number>();

function step(n: number): number {
  if (n < 2) return n;
  const hit = cache.get(n);
  if (hit !== undefined) return hit;
  cache.set(n, n);
  return n;
}
${shared}`,
    );
    expect(nativeMap.ok).toBe(f64Control.ok);
    expect(outcomeFor(nativeMap.outcomes, "step").kind).toBe(outcomeFor(f64Control.outcomes, "step").kind);
  });
});
