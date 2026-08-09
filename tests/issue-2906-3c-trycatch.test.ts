// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2906 slice 3c — try/CATCH-around-await on the host-free async drive machine.
//
// `try { …await… } catch (e) { … }` could not be driven: `planLinearAwaits`
// rejects any try with a catch clause, so the shape fell to the AG0 one-level
// unwrap and the catch never observed a rejection (the rejected `$Promise`'s
// reason field was read as the VALUE — silently wrong). 3c adds:
//   - a CFG producer (`planTryCatchCfg`) lowering the bounded shape — pre
//     statements, one top-level try/catch (no finally), post statements, each
//     chunk linear-canonical with awaits allowed (including INSIDE the catch);
//   - `AsyncHandlerRegion.catchState`: the region's catch chain entry;
//   - the ROUTED dispatcher: `block { loop { try { chain } catch { route } } }`
//     — an abrupt completion raised while the region is active (a rejected
//     in-try await re-thrown by the resume prelude, or a synchronous throw in
//     an in-try lead) becomes a STATE TRANSITION into the catch chain (reason
//     bound to the catch param local + spill, MODE consumed, `br` re-dispatch).
//     A throw with no active region falls to the pre-3c reject tail; plans
//     without a catchState keep the pre-3c dispatcher BYTE-IDENTICALLY.
//
// Native (wasi/standalone-carrier) drive lane only — the host lane keeps its
// current shapes byte-identically (`allowTryCatch: !info.host`).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

type Target = "wasi" | "standalone";

/** Compile + instantiate; kick the async fn, drain microtasks, read the side channel. */
async function driveCap(src: string, target: Target = "wasi"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // Some throw paths pull the wasi fd_write error sink — stub it; no JS host.
  const imports = { wasi_snapshot_preview1: { fd_write: () => 0, proc_exit: () => {} } };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const ex = instance.exports as {
    kick: () => number;
    getCap: () => number;
    __drain_microtasks?: () => void;
  };
  ex.kick();
  ex.__drain_microtasks?.();
  return ex.getCap();
}

describe("#2906 3c — try/catch-around-await drive (wasi lane)", () => {
  it("verify-first: a rejected in-try await enters the catch with the reason bound", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.reject(new Error("boom"));
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("a fulfilled in-try await takes the try continuation (catch not entered)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(7);
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1007);
  });

  it("pre-try await delivers, rejection on the 2nd (in-try) await routes", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  const a = await Promise.resolve(3);
  try {
    const b = await Promise.reject(new Error("y"));
    cap = (a as number) + (b as number);
  } catch (e) {
    cap = (a as number) + 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(45);
  });

  it("the catch body may itself await (catch chain suspends + resumes)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("z"));
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(8);
    cap = 42 + (r as number);
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(50);
  });

  it("post statements after the try run on the catch path too (join state)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("q"));
    cap = 1;
  } catch (e) {
    cap = 42;
  }
  const t = await Promise.resolve(100);
  cap = cap + (t as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(142);
  });

  it("a SYNCHRONOUS throw in an in-try lead routes to the catch (not reject)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
function boom(): number { throw new Error("sync"); }
async function f(): Promise<void> {
  try {
    const a = await Promise.resolve(1);
    cap = boom() + (a as number);
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("a throw INSIDE the catch body rejects the result promise (no route loop)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("a"));
  } catch (e) {
    cap = 5;
    throw new Error("b");
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(5);
  });

  it("catch WITHOUT a binding routes (reason dropped)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("nobind"));
    cap = 1;
  } catch {
    cap = 77;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(77);
  });

  it("locals crossing the try + a post await survive (widened frame spills)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  let acc: number = 5;
  try {
    const x = await Promise.resolve(10);
    acc = acc + (x as number);
  } catch (e) {
    acc = -1;
  }
  const y = await Promise.resolve(100);
  cap = acc + (y as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(115);
  });

  it("GENUINELY-PENDING rejection routes on resume (reject step adapter → prelude re-throw → route)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(1).then((v: number) => { throw new Error("later"); });
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("GENUINELY-PENDING fulfil keeps the try continuation", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(1).then((v: number) => v + 4);
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1005);
  });

  it("pending rejection + await inside the catch after routing", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.resolve(1).then((v: number) => { throw new Error("later"); });
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(1).then((v: number) => v + 7);
    cap = 42 + (r as number);
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(50);
  });
});

// #2906 3c-ii — return-through-finally + sibling regions.
//
// (a) `return v` INSIDE a `try { …await… } finally { F }` was rejected by
//     `planLinearAwaits` (return-through-finally), demoting the whole fn to
//     AG0. The native lane now admits it (`allowReturnInTry`): the return
//     hook evaluates the operand, replays the region's await-free finalizer
//     (region local reset first — a throw in the finally must not re-enter
//     the region; a `return` in the finally overrides, §14.15.3), THEN
//     settles. Normal/throw paths keep their existing inline/reject-route
//     replay byte-identically.
// (b) SIBLING try/catch regions: the 3c producer generalizes to any number of
//     sequential top-level `try/catch`es — one handler region each (dense ids,
//     own catchState), the shared route dispatching by the region-id local.
describe("#2906 3c-ii — return-through-finally + sibling regions (wasi lane)", () => {
  it("return-through-finally: the finalizer runs BEFORE the settle, value kept", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    const x = await Promise.resolve(5);
    return (x as number) + 100;
  } finally {
    flag = 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1105); // 105 + finally-flag observed at settle time
  });

  it("conditional return inside the try replays the finalizer on the taken branch", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(n: number): Promise<number> {
  try {
    const x = await Promise.resolve(n);
    if ((x as number) > 3) { return 77; }
    return 1;
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const a = await f(5);
  cap = (a as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1077); // finalizer ran exactly once
  });

  it("normal-completion finally stays on the inline path", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(4);
    cap = x as number;
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(104);
  });

  it("throw-path finally stays on the reject-route replay", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("r"));
    cap = 1;
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(100);
  });

  it("sibling regions: two sequential try/catches route to their own catch", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("a"));
  } catch (e) {
    cap = 1;
  }
  try {
    await Promise.reject(new Error("b"));
  } catch (e) {
    cap = cap + 10;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(11);
  });

  it("sibling regions: first fulfils, second rejects — only the second catch runs", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const a = await Promise.resolve(100);
    cap = a as number;
  } catch (e) {
    cap = -1;
  }
  try {
    await Promise.reject(new Error("b"));
  } catch (e2) {
    cap = cap + 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(142);
  });

  // (#2906 3c-ii-b) `return await P` inside try/finally — the settleSent
  // terminator replays the region's finalizer BEFORE fulfilling (the value
  // sits stably in SENT; the finalizer cannot await). linearPlanToCfg drops
  // the inline tail for isReturnAwait states, so the replay is the ONLY run.
  it("return await inside try/finally: finalizer exactly once, before the settle (sync fulfil)", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    return await Promise.resolve(42);
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1042);
  });

  it("return await inside try/finally: genuinely-pending fulfil replays once on resume", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    return await Promise.resolve(41).then((v: number) => v + 1);
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1042);
  });

  it("return await inside try/finally: a rejection still replays via the reject route", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    return await Promise.reject(new Error("x"));
  } finally {
    flag = flag + 1;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return flag; }`),
    ).toBe(1);
  });

  it("leads before the return-await run once; finalizer once", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    const a = await Promise.resolve(10);
    return await Promise.resolve((a as number) + 42);
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1052);
  });
});

// #2906 3c-ii-b — COMBINED try/catch/finally regions. A combined group mints
// TWO handler regions: the catch region (catchState + the finalizer — covers
// the TRY chunk: abrupt → catch, `return`/`return await` → finalizer replay
// then settle) and a finally-only region (finalizer, no catchState — covers
// the CATCH chunk: a throw there replays the finalizer in the reject route, a
// `return` there replays it via the hook). Normal completions run the
// finalizer as inline handler-0 leads at the try/catch exits. Producer-only:
// every emitter mechanism (route, reject-tail replay, return hook, settleSent
// replay) already handles the two regions generically.
describe("#2906 3c-ii-b — combined try/catch/finally (wasi lane)", () => {
  it("fulfil path: catch skipped, finalizer once", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.resolve(4);
    cap = x as number;
  } catch (e) {
    cap = -1;
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(104);
  });

  it("rejection: catch runs, then the finalizer", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("x"));
    cap = 1;
  } catch (e) {
    cap = 42;
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(142);
  });

  it("a throw INSIDE the catch replays the finalizer before rejecting", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("a"));
  } catch (e) {
    cap = 5;
    throw new Error("b");
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(105);
  });

  it("return inside the TRY runs the finalizer once, before the settle", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    const x = await Promise.resolve(50);
    return x as number;
  } catch (e) {
    return -1;
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1050);
  });

  it("return inside the CATCH runs the finalizer once, before the settle", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    await Promise.reject(new Error("y"));
    return 1;
  } catch (e) {
    return 42;
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1042);
  });

  it("an await INSIDE the catch suspends/resumes; finalizer after", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("z"));
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(8);
    cap = 42 + (r as number);
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(150);
  });

  it("a REJECTED await inside the catch replays the finalizer before rejecting", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("p"));
    cap = 1;
  } catch (e) {
    await Promise.reject(new Error("q"));
    cap = 2;
  } finally {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(100);
  });

  it("return await inside the TRY: finalizer once via the settleSent replay", async () => {
    expect(
      await driveCap(`let cap: number = 0;
let flag: number = 0;
async function f(): Promise<number> {
  try {
    return await Promise.resolve(77);
  } catch (e) {
    return -1;
  } finally {
    flag = flag + 1;
  }
}
async function g(): Promise<void> {
  const v = await f();
  cap = (v as number) + flag * 1000;
}
export function kick(): number { g() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(1077);
  });
});

// #2906 3c-iii — NESTED try/catch regions. The producer lowers try blocks
// RECURSIVELY: an inner group's region carries `parent`, and its CATCH chunk
// is tagged with the ENCLOSING region id — so an abrupt in the inner catch
// escalates to the outer catch through the SAME flat id-dispatch route (the
// parent chain is encoded statically in the handler tags; no dynamic walk).
// Bounded: nested regions are finalizer-free (validateAsyncCfg enforces);
// combined try/catch/finally groups stay depth-0 with pure try bodies.
describe("#2906 3c-iii — nested try/catch regions (wasi lane)", () => {
  it("inner catch handles; outer catch untouched", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    try {
      await Promise.reject(new Error("inner"));
      cap = 1;
    } catch (e) {
      cap = 42;
    }
  } catch (e2) {
    cap = -1;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(42);
  });

  it("a throw in the INNER CATCH escalates to the OUTER catch", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    try {
      await Promise.reject(new Error("inner"));
      cap = 1;
    } catch (e) {
      cap = 42;
      throw new Error("re");
    }
  } catch (e2) {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(142);
  });

  it("a REJECTED await in the inner catch escalates to the outer catch", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    try {
      await Promise.reject(new Error("inner"));
      cap = 1;
    } catch (e) {
      cap = 42;
      await Promise.reject(new Error("re2"));
      cap = 2;
    }
  } catch (e2) {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(142);
  });

  it("an abrupt in the outer try AFTER the inner group hits the outer catch", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    try {
      const a = await Promise.resolve(5);
      cap = a as number;
    } catch (e) {
      cap = -1;
    }
    await Promise.reject(new Error("outer"));
    cap = 1;
  } catch (e2) {
    cap = cap + 100;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(105);
  });

  it("fulfil-through both levels with pre/mid/post leads and a post await", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  cap = 5;
  try {
    const a = await Promise.resolve(0);
    try {
      const b = await Promise.resolve(20);
      cap = cap + (b as number);
    } catch (e) {
      cap = -1;
    }
  } catch (e2) {
    cap = -2;
  }
  const t = await Promise.resolve(100);
  cap = cap + (t as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(125);
  });

  it("three levels deep: the innermost catch handles", async () => {
    expect(
      await driveCap(`let cap: number = 0;
async function f(): Promise<void> {
  try {
    try {
      try {
        await Promise.reject(new Error("deep"));
        cap = 1;
      } catch (e) {
        cap = 7;
      }
    } catch (e2) {
      cap = -1;
    }
  } catch (e3) {
    cap = -2;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`),
    ).toBe(7);
  });
});

describe("#2906 3c — try/catch-around-await drive (standalone carrier lane)", () => {
  it("the core rejection→catch case drives on standalone too", async () => {
    expect(
      await driveCap(
        `let cap: number = 0;
async function f(): Promise<void> {
  try {
    const x = await Promise.reject(new Error("boom"));
    cap = (x as number) + 1000;
  } catch (e) {
    cap = 42;
  }
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`,
        "standalone",
      ),
    ).toBe(42);
  });

  it("catch-with-await + post-join drives on standalone", async () => {
    expect(
      await driveCap(
        `let cap: number = 0;
async function f(): Promise<void> {
  try {
    await Promise.reject(new Error("z"));
    cap = 1;
  } catch (e) {
    const r = await Promise.resolve(8);
    cap = 42 + (r as number);
  }
  const t = await Promise.resolve(100);
  cap = cap + (t as number);
}
export function kick(): number { f() as any; return 0; }
export function getCap(): number { return cap; }`,
        "standalone",
      ),
    ).toBe(150);
  });
});
