// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5367 — `await Promise.all(<call args>)` INLINE yielded a default-initialised
// tuple struct (`{"_0":null,"_1":null}`) or an empty array, and the pending
// promises' continuations never ran. The host-lane activation gate
// (`asyncFnNeedsHostDrive`) carried a #1796-era carve-out that kept a lone
// `await Promise.<combinator>(...)` on the legacy identity path "because the
// combinator already returns a real Promise" — but with a resume binding that
// path delivers the un-awaited Promise object coerced into the STATIC awaited
// type, and the body never suspends. Binding the promise to a local first
// (`const p = Promise.all(…); await p`) never hit the carve-out, which is why
// the via-local form was correct all along. This is the whole of hono
// `src/utils/concurrent.test.ts`.
//
// Untyped `.js` two-file project, compiled and instantiated like the dogfood
// worker. Every row pins the resolved VALUES (not just `length`) and the
// continuation log where the ladder demands it.
//
// Parent (`cbd2f11dff`) counts, JS-host lane: 5 rows fail / 3 pass.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";

const LIB = `export function tick() {
  return new Promise((r) => setTimeout(r, 1));
}
`;

const ROWS = `import { tick } from "./lib.js";

export async function p1() {
  return await Promise.resolve(1);
}
export async function p2() {
  const p = Promise.all([Promise.resolve(1), Promise.resolve(2)]);
  const r = await p;
  return JSON.stringify(r) + "|" + r.length + "|" + r[0];
}
export async function p3() {
  const r = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
  return JSON.stringify(r) + "|" + r.length + "|" + r[0];
}
export async function p4() {
  const ps = [Promise.resolve(1), Promise.resolve(2)];
  const r = await Promise.all(ps);
  return JSON.stringify(r) + "|" + r.length + "|" + r[0];
}
let seen = [];
let gate = null;
const fn = async (i) => {
  seen.push("s" + i);
  await gate;
  seen.push("e" + i);
  return i;
};
export async function p5() {
  seen = [];
  gate = tick();
  const r = await Promise.all([7, 8].map((i) => fn(i)));
  return JSON.stringify(r) + "|" + seen.join("|");
}
export async function p6() {
  seen = [];
  gate = tick();
  const a = fn(7);
  const b = fn(8);
  const x = await a;
  const y = await b;
  return x + "," + y + "|" + seen.join("|");
}
export async function p7() {
  seen = [];
  gate = tick();
  const r = await Promise.all([fn(0), fn(1)]);
  return JSON.stringify(r) + "|" + seen.join("|");
}
export async function p8() {
  const running = new Set();
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const f = async (i) => {
    running.add(i);
    await promise;
    running.delete(i);
    return i;
  };
  const jobs = new Array(3).fill(0).map((_, i) => () => f(i));
  const expected = new Array(3).fill(0).map((_, i) => i);
  const resultPromises = jobs.map((job) => job());
  const before = running.size;
  resolve?.();
  const results = await Promise.all(resultPromises);
  return before + "|" + running.size + "|" + JSON.stringify(results) + "|" + JSON.stringify(expected);
}
`;

type Exports = Record<string, (...args: unknown[]) => unknown>;

const roots: string[] = [];
let compiled: Awaited<ReturnType<typeof compileProject>>;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "js2-5367-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "lib.js"), LIB);
  writeFileSync(join(root, "rows.js"), ROWS);
  compiled = await compileProject(join(root, "rows.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
    emitWat: false,
    deferTopLevelInit: true,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(compiled.binary)).toBe(true);
}, 120_000);

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Fresh instance per row: an un-driven row's dangling frames must not leak into the next row's log. */
async function instantiate(): Promise<Exports> {
  const deps: Record<string, unknown> = Object.create(null);
  Object.assign(deps, getWebHostConstructors());
  const imports = buildCompiledImports(compiled, deps) as Record<string, unknown> & {
    setInstance?: (i: WebAssembly.Instance) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(compiled.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, { signatures: compiled.exportSignatures }) as Exports;
}

async function settle(run: (m: Exports) => unknown): Promise<string> {
  const m = await instantiate();
  return await Promise.race([
    Promise.resolve(run(m)).then(
      (value) => String(value),
      (error) => `rejected:${String((error as Error)?.message ?? error)}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("STRANDED"), 3000)),
  ]);
}

describe("#5367 await Promise.all(...) inline (failing on the parent)", () => {
  it("await Promise.all([Promise.resolve(1), Promise.resolve(2)]) -> [1,2]|2|1", async () => {
    expect(await settle((m) => m.p3())).toBe("[1,2]|2|1");
  });
  it("await Promise.all(psVariable) -> [1,2]|2|1", async () => {
    expect(await settle((m) => m.p4())).toBe("[1,2]|2|1");
  });
  it("await Promise.all([7,8].map(fn)) resolves AND the continuations run", async () => {
    expect(await settle((m) => m.p5())).toBe("[7,8]|s7|s8|e7|e8");
  });
  it("await Promise.all([fn(0), fn(1)]) -> [0,1]|s0|s1|e0|e1", async () => {
    expect(await settle((m) => m.p7())).toBe("[0,1]|s0|s1|e0|e1");
  });
  it("hono createPool shape: results resolve and the pool drains", async () => {
    expect(await settle((m) => m.p8())).toBe("3|0|[0,1,2]|[0,1,2]");
  });
});

describe("#5367 controls (passing on the parent too)", () => {
  it("await Promise.resolve(1) -> 1", async () => {
    expect(await settle((m) => m.p1())).toBe("1");
  });
  it("const p = Promise.all([...]); await p (via-local, anti-vacuity) -> [1,2]|2|1", async () => {
    expect(await settle((m) => m.p2())).toBe("[1,2]|2|1");
  });
  it("sequential await a; await b -> 7,8|s7|s8|e7|e8", async () => {
    expect(await settle((m) => m.p6())).toBe("7,8|s7|s8|e7|e8");
  });
});
