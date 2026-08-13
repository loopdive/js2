// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4134 (second class) — a nested function that CALLS a capturing sibling but
// never mentions the captured names itself.
//
// Nested function declarations are lifted to module-level Wasm functions with
// their captures riding in as leading synthetic params. At a call site, the
// caller supplies the callee's captures by `local.get`-ing the DECLARING
// frame's slot (`nestedFuncCaptures` prepend, `call-identifier.ts`). When the
// caller is itself a lifted sibling, that slot does not exist in its frame —
// so the emitted index can point past the end of it and the whole module fails
// to validate:
//
//     local (local.get) index out of range — 31 (valid: [0, 15))
//
// Capture collection only looked at names the body references DIRECTLY, so a
// sibling that just calls the capturing function captured nothing. The fix
// takes the transitive closure over referenced capturing siblings.
//
// NON-VACUITY: measured against the unfixed base, `factory()` below emits
// `local.get 22` into a 3-slot frame and the compile FAILS at binary emit
// (`success: false`, no binary). The enclosing function needs enough locals to
// push the captured slots past the caller's frame — a two-local host does not
// reproduce, which is why the earlier synthetic attempts on this issue all
// compiled clean.
//
// Real-world origin: uri-js's UMD bundle (an ESLint dependency). Its factory
// body declares `SCHEMES` / `URI_PROTOCOL` / `NO_MATCH_IS_UNDEFINED` as locals,
// nested `parse`/`serialize` capture them, and sibling `normalize` / `resolve`
// / `equal` call `parse` without naming them. Before the fix that file produced
// three out-of-frame functions and no binary; after it, a valid 131 KB module.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

async function run(source: string): Promise<Record<string, unknown>> {
  const result = await compileMulti({ "./main.ts": source }, "./main.ts", { target: "gc" });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const imports = { ...(result.importObject as Record<string, Record<string, unknown>>) };
  for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
    const mod = (imports[imp.module] ??= {});
    if (mod[imp.name] !== undefined) continue;
    if (imp.kind === "function") mod[imp.name] = () => undefined;
    else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return instance.exports as Record<string, unknown>;
}

async function compileOnly(source: string): Promise<void> {
  const result = await compileMulti({ "./main.ts": source }, "./main.ts", { target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

/** Twenty locals ahead of the captured pair, so their slots land past any
 *  sibling's own frame. Fewer locals does NOT reproduce. */
const WIDE_HOST_PRELUDE = Array.from({ length: 20 }, (_, i) => `  const p${i} = ${i};`).join("\n");
const WIDE_HOST_SINK = Array.from({ length: 20 }, (_, i) => `p${i}`).join(" + ");

describe("#4134 — transitive captures through a nested sibling call", () => {
  it("materializes a transitive function-value cycle without recursive compiler construction", async () => {
    const exports = await run(`
function makeCycle(seed: number) {
  function dispatch(): number { return process(); }
  function process(): number { return resolve(); }
  function resolve(): number {
    const next = process;
    return next === process ? seed : 0;
  }
  const start = dispatch;
  return start;
}

const probeCycle = makeCycle(42);
export function main(): number { return probeCycle(); }
`);
    expect((exports.main as () => number)()).toBe(42);
  });

  it("materializes a cyclic function-value capture before a direct sibling call", async () => {
    const exports = await run(`
function recurse(count: number): number {
  function getF() { return f; }
  function f(_template: unknown, remaining: number): number {
    if (remaining === 0) return 42;
    const next = getF();
    return next(null, remaining - 1);
  }
  return f(null, count);
}

export function main(): number { return recurse(3); }
`);
    expect((exports.main as () => number)()).toBe(42);
  });

  it("a sibling that only CALLS the capturing function still gets the captures", async () => {
    const exports = await run(`
function factory(): number {
${WIDE_HOST_PRELUDE}
  const SCHEMES = 100;
  const TABLE = 200;

  function parse(v: number): number {
    return v + SCHEMES + TABLE;
  }

  // Never mentions SCHEMES or TABLE.
  function normalize(v: number): number {
    return parse(v) * 2;
  }

  const sink = ${WIDE_HOST_SINK};
  return normalize(1) + sink * 0;
}

export function main(): number { return factory(); }
`);
    // node: parse(1) = 301, normalize(1) = 602.
    expect((exports.main as () => number)()).toBe(602);
  });

  it("holds through a two-hop chain (caller → caller → capturer)", async () => {
    const exports = await run(`
function factory(): number {
${WIDE_HOST_PRELUDE}
  const BASE = 7;

  function inner(v: number): number { return v + BASE; }
  function middle(v: number): number { return inner(v) * 2; }
  function outer(v: number): number { return middle(v) + 1; }

  const sink = ${WIDE_HOST_SINK};
  return outer(3) + sink * 0;
}

export function main(): number { return factory(); }
`);
    // node: inner(3) = 10, middle(3) = 20, outer(3) = 21.
    expect((exports.main as () => number)()).toBe(21);
  });

  it("two siblings calling the same capturer both stay in range", async () => {
    const exports = await run(`
function factory(): number {
${WIDE_HOST_PRELUDE}
  const A = 5;
  const B = 11;

  function capture(v: number): number { return v * A + B; }
  function first(v: number): number { return capture(v); }
  function second(v: number): number { return capture(v) + capture(v); }

  const sink = ${WIDE_HOST_SINK};
  return first(2) + second(3) + sink * 0;
}

export function main(): number { return factory(); }
`);
    // node: capture(2) = 21, capture(3) = 26 -> 21 + 52 = 73.
    expect((exports.main as () => number)()).toBe(73);
  });

  it("threads an ancestor sibling's capture through a nested descendant", async () => {
    const exports = await run(`
function factory(): number {
${WIDE_HOST_PRELUDE}
  const STATE = 42;

  function getState(): number { return STATE; }

  // subscribe is a sibling of getState, so it receives STATE as a
  // transitive capture. observeState is one lexical level deeper and also
  // has to receive STATE before it can forward the call to getState.
  function subscribe(): number {
    function observeState(): number { return getState(); }
    return observeState();
  }

  const sink = ${WIDE_HOST_SINK};
  return subscribe() + sink * 0;
}

export function main(): number { return factory(); }
`);
    expect((exports.main as () => number)()).toBe(42);
  });

  it("threads a sibling's capture through a returned function expression", async () => {
    const exports = await run(`
function factory(): number {
${WIDE_HOST_PRELUDE}
  const STATE = 41;

  function readState(): number { return STATE; }
  function makeReader() {
    return function (): number { return readState() + 1; };
  }

  const sink = ${WIDE_HOST_SINK};
  const callback = makeReader();
  return callback() + sink * 0;
}

export function main(): number { return factory(); }
`);
    expect((exports.main as () => number)()).toBe(42);
  });

  it("keeps a transitive sibling function value inside a returned closure frame", async () => {
    await compileOnly(`
function factory(): number {
${WIDE_HOST_PRELUDE}
  const STATE = 40;

  function finish(): number { return STATE + 2; }
  function dispatch(): number { return finish.call(null); }
  function makeReader() {
    return function (): number { return dispatch(); };
  }

  const sink = ${WIDE_HOST_SINK};
  const callback = makeReader();
  return callback() + sink * 0;
}

export function main(): number { return factory(); }
`);
  });
});
