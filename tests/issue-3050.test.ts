// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3050 — generator `.throw()` resumption through try/catch/finally.
 *
 * The native generator state machine now models TRY-REGIONS: catch across a
 * yield, a finally that itself yields, abrupt-completion routing (§27.5.3.4
 * GeneratorResumeAbrupt threaded through the §14.15 try model), and runtime
 * exceptions raised inside try-part states. In the JS-HOST lane these shapes
 * route natively too (the eager buffer provably cannot express them — the
 * body already ran at creation), gated on a conservative use-site safety walk;
 * everything else keeps the eager path.
 *
 * Also covered: capturing NESTED generators (captures ride as leading
 * synthetic params; mutable captures as shared ref cells), the dedicated done
 * state (trailing statements after the last yield must not re-run on
 * post-completion `.next()`), and the eager-outer/native-inner `yield*` mix
 * (the safety walk keeps the inner eager so delegation still works).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, target?: "standalone"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...(target ? { target } : {}) });
  if (!r.success) throw new Error(r.errors[0]?.message ?? "compile error");
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

const YIELD_IN_FINALLY_THROW = `
var unreachable = 0;
function* g() {
  yield 1;
  try {
    yield 2;
  } finally {
    yield 3;
    unreachable += 1;
  }
  yield 4;
}
export function test(): number {
  const iter = g();
  iter.next(); iter.next(); iter.next(); // suspended at yield 3 (in finally)
  let threw = 0;
  try { iter.throw(new Error("boom")); } catch (e) { threw = 1; }
  // spec: the throw replaces the completion; the REST of the finally is
  // skipped (unreachable stays 0) and the error propagates.
  return unreachable * 10 + threw; // 1
}
`;

const CATCH_ROUTING = `
function* g() {
  try {
    yield 1;
    throw new Error("inside");
  } catch (e) {
    yield 2;
  }
  yield 3;
}
export function test(): number {
  const iter = g();
  let acc = 0;
  acc = acc * 10 + (iter.next().value as number); // 1
  acc = acc * 10 + (iter.next().value as number); // 2 (throw routed to catch)
  acc = acc * 10 + (iter.next().value as number); // 3 (catch fell through)
  return acc; // 123
}
`;

const THROW_INTO_CATCH = `
function* g() {
  try {
    yield 1;
  } catch (e) {
    yield e;
  }
}
export function test(): number {
  const iter = g();
  iter.next(); // suspended at yield 1 (inside try-with-catch)
  const r = iter.throw(42); // .throw at the yield enters the catch, binding e
  return (r.value as number) * 10 + (r.done ? 1 : 0); // 420
}
`;

const TRAILING_STATEMENTS_DONE_STATE = `
var trailing = 0;
function* g() {
  yield 1;
  trailing += 1;
}
export function test(): number {
  const iter = g();
  iter.next(); // 1
  iter.next(); // completes; trailing runs ONCE
  iter.next(); // post-completion: must NOT re-run trailing
  iter.next();
  return trailing; // 1
}
`;

const CAPTURING_NESTED = `
export function test(): number {
  var count = 0;
  function* g() {
    try {
      yield 1;
    } finally {
      yield 2;
      count += 10; // write-through to the enclosing frame via the shared cell
    }
  }
  const iter = g();
  iter.next();
  iter.next(); // suspended at yield 2 (in finally)
  iter.next(); // finishes the finally: count += 10 runs
  count += 1;
  return count; // 11
}
`;

const FOR_OF_CONSUMER = `
function* g(): Generator<number> {
  try {
    yield 1;
    yield 2;
  } catch (e) {
    yield 99;
  }
  yield 3;
}
export function test(): number {
  let sum = 0;
  for (const x of g()) sum += x;
  return sum; // 6
}
`;

// The eager OUTER delegates to the try-region INNER: the use-site safety walk
// must keep the inner on the eager path (a native inner's state struct is not
// host-iterable), so delegation still yields every value.
const EAGER_OUTER_NATIVE_INNER_MIX = `
function* inner(): Generator<number> {
  try { yield 1; yield 2; } catch (e) { yield 99; }
}
function* outer(): Generator<number> {
  yield 0;
  yield* inner();
  yield 3;
}
export function test(): number {
  let acc = 0;
  for (const x of outer()) acc = acc * 10 + x + 1;
  return acc; // digits 1,2,3,4 -> 1234
}
`;

describe("#3050 — generator .throw() through try-regions", () => {
  it("throw at a yield INSIDE a finally skips the rest of the finally (host lane)", async () => {
    expect(await run(YIELD_IN_FINALLY_THROW)).toBe(1);
  });

  it("throw at a yield INSIDE a finally skips the rest of the finally (standalone)", async () => {
    expect(await run(YIELD_IN_FINALLY_THROW, "standalone")).toBe(1);
  });

  it("a runtime throw inside the try block routes to the catch's states", async () => {
    expect(await run(CATCH_ROUTING)).toBe(123);
  });

  it("a runtime throw inside the try block routes to the catch's states (standalone)", async () => {
    expect(await run(CATCH_ROUTING, "standalone")).toBe(123);
  });

  it(".throw() at a yield inside try-with-catch enters the catch, binding the error", async () => {
    expect(await run(THROW_INTO_CATCH)).toBe(420);
  });

  it(".throw() at a yield inside try-with-catch enters the catch (standalone)", async () => {
    expect(await run(THROW_INTO_CATCH, "standalone")).toBe(420);
  });

  it("trailing statements after the last yield do not re-run post-completion (standalone)", async () => {
    expect(await run(TRAILING_STATEMENTS_DONE_STATE, "standalone")).toBe(1);
  });

  it("capturing nested generator: mutable capture writes through to the enclosing frame", async () => {
    expect(await run(CAPTURING_NESTED)).toBe(11);
  });

  it("for-of drives a host-lane native try-region generator natively", async () => {
    expect(await run(FOR_OF_CONSUMER)).toBe(6);
  });

  it("eager outer yield* over a try-region inner still delegates every value (safety walk)", async () => {
    expect(await run(EAGER_OUTER_NATIVE_INNER_MIX)).toBe(1234);
  });
});
