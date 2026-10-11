// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6780 — `await` of a statically-resolved operand did not suspend.
//
// `asyncFnNeedsHostDrive` declined every async body whose awaits were all
// "statically resolved" (`await null`, `await 1`, `await Promise.resolve()`),
// so the body compiled to the synchronous pass-through and ran straight past
// the await: code after the CALL SITE observed state that JS only reaches
// after the continuation ran. §27.7.5.3 Await always resumes on a later job,
// whatever the operand, so the host engine now drives these bodies like any
// other, and a body it still cannot drive (an await inside a loop) refuses
// with a compile error instead of silently reordering.
//
// Every case runs the SAME TypeScript source through Node (type-stripped) and
// asserts the wasm log order equals Node's, plus the literal expected order so
// a harness drift cannot make both sides agree on something wrong.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const LOG_PRELUDE = `
const out: string[] = [];
function log(s: string): void { out.push(s); }
`;

async function runWasm(src: string): Promise<string> {
  const result = await compile(src, { fileName: "issue-6780.ts" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return (await (instance.exports.run as () => Promise<string>)()) as string;
}

async function runNode(src: string): Promise<string> {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports: Record<string, unknown> = {};
  new Function("exports", "module", js.outputText)(exports, { exports });
  return await (exports.run as () => Promise<string>)();
}

async function expectSameOrder(body: string, expected: string): Promise<void> {
  const src = LOG_PRELUDE + body;
  const node = await runNode(src);
  expect(node).toBe(expected);
  expect(await runWasm(src)).toBe(node);
}

/** One async fn `af` that sets `shared` around a single await of `operand`. */
function singleAwait(operand: string, extra = ""): string {
  return `
let shared = 0;
${extra}
async function af(): Promise<number> { shared = 1; const x = await ${operand}; shared = 2; return shared; }
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`;
}

const SUSPENDED = "after-call shared=1,resolved v=2 shared=2";

describe("#6780 — an await of a settled operand still yields a microtask turn (host gc lane)", () => {
  it("issue probe: arrow `await null` returns to the caller before the continuation", async () => {
    await expectSameOrder(
      `
let shared = 0;
const af = async (): Promise<number> => { shared = 1; await null; shared = 2; return shared; };
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`,
      SUSPENDED,
    );
  });

  it("sibling ordering: three `await null` bodies run all first halves, then all second halves", async () => {
    await expectSameOrder(
      `
async function af1(): Promise<void> { log("af1-a"); await null; log("af1-b"); }
async function af2(): Promise<void> { log("af2-a"); await null; log("af2-b"); }
async function af3(): Promise<void> { log("af3-a"); await null; log("af3-b"); }
export async function run(): Promise<string> {
  const p1 = af1(); const p2 = af2(); const p3 = af3();
  log("sync-end");
  await p1; await p2; await p3;
  return out.join(",");
}
`,
      "af1-a,af2-a,af3-a,sync-end,af1-b,af2-b,af3-b",
    );
  });

  it("`await undefined`", async () => {
    await expectSameOrder(singleAwait("undefined"), SUSPENDED);
  });

  it("`await 1` (the settled value is delivered to the binding)", async () => {
    await expectSameOrder(
      `
let shared = 0;
async function af(): Promise<number> { shared = 1; const x = await 1; shared = 2 + x; return shared; }
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`,
      "after-call shared=1,resolved v=3 shared=3",
    );
  });

  it("`await Promise.resolve(1)`", async () => {
    await expectSameOrder(
      `
let shared = 0;
async function af(): Promise<number> { shared = 1; const x = await Promise.resolve(1); shared = 2 + x; return shared; }
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`,
      "after-call shared=1,resolved v=3 shared=3",
    );
  });

  it("`await Promise.resolve()`", async () => {
    await expectSameOrder(singleAwait("Promise.resolve()"), SUSPENDED);
  });

  it("`await (async () => 1)()`", async () => {
    await expectSameOrder(
      `
let shared = 0;
async function af(): Promise<number> { shared = 1; const x = await (async () => 1)(); shared = 2 + x; return shared; }
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`,
      "after-call shared=1,resolved v=3 shared=3",
    );
  });

  it("function expression with `await 0`", async () => {
    await expectSameOrder(
      `
let shared = 0;
const af = async function (): Promise<number> { shared = 1; await 0; shared = 2; return shared; };
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`,
      SUSPENDED,
    );
  });

  it("settled awaits inside `if` and `try` suspend too", async () => {
    await expectSameOrder(
      `
let shared = 0;
async function inIf(c: boolean): Promise<number> { shared = 1; if (c) { await null; } shared = 2; return shared; }
async function inTry(): Promise<number> {
  shared = 10;
  try { await null; shared = 20; } catch (e) { shared = -1; }
  return shared;
}
export async function run(): Promise<string> {
  const p = inIf(true);
  log("if after-call shared=" + shared);
  log("if resolved v=" + (await p));
  const q = inTry();
  log("try after-call shared=" + shared);
  log("try resolved v=" + (await q));
  return out.join(",");
}
`,
      "if after-call shared=1,if resolved v=2,try after-call shared=10,try resolved v=20",
    );
  });

  it("a settled await after a real one still takes its own turn", async () => {
    await expectSameOrder(
      `
let shared = 0;
async function g(): Promise<number> { return 5; }
async function af(): Promise<number> {
  shared = 1;
  const x = await g();
  shared = 2;
  await null;
  shared = 3 + x;
  return shared;
}
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  await null;
  log("tick1 shared=" + shared);
  await null;
  log("tick2 shared=" + shared);
  log("resolved v=" + (await p) + " shared=" + shared);
  return out.join(",");
}
`,
      "after-call shared=1,tick1 shared=2,tick2 shared=8,resolved v=8 shared=8",
    );
  });

  it("forward references: a caller compiled before its driven callee reads the settled value, not NaN", async () => {
    // `run` is declared (and compiled) BEFORE `af` / `real`. The callee's
    // Promise result must be registered at declaration time; before #6780 a
    // driven callee's result type was rewritten only when its body compiled,
    // so the earlier caller unboxed the Promise to NaN (real awaits included).
    await expectSameOrder(
      `
export async function run(): Promise<string> {
  const v = await af(3);
  log("af+1=" + (v + 1));
  const r = await real(4);
  log("real+1=" + (r + 1));
  const all = await Promise.all([af(1), real(2)]);
  log("all=" + all.join("/"));
  return out.join(",");
}
async function af(n: number): Promise<number> { await null; return n * 2; }
async function g(): Promise<number> { return 0; }
async function real(n: number): Promise<number> { await g(); return n * 2; }
`,
      "af+1=7,real+1=9,all=2/4",
    );
  });

  it("a ZERO-await async function still runs synchronously up to its return", async () => {
    await expectSameOrder(
      `
let shared = 0;
async function af(): Promise<number> { shared = 1; log("in-body"); shared = 2; return shared; }
export async function run(): Promise<string> {
  const p = af();
  log("after-call shared=" + shared);
  const v = await p;
  log("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}
`,
      "in-body,after-call shared=2,resolved v=2 shared=2",
    );
  });
});

describe("#6780 — a body of settled awaits the engine cannot drive refuses instead of reordering", () => {
  async function errorsOf(src: string): Promise<string[]> {
    const result = await compile(src, { fileName: "issue-6780.ts" });
    return result.errors.map((e) => e.message);
  }

  it("refuses a top-level declaration with `await null` inside a loop", async () => {
    const errors = await errorsOf(`
let shared = 0;
async function af(): Promise<number> {
  for (let i = 0; i < 2; i++) { shared = shared + 1; await null; }
  return shared;
}
export async function run(): Promise<number> { return await af(); }
`);
    expect(errors.some((m) => m.includes("#6780") && m.includes("already-settled operand"))).toBe(true);
  });

  it("refuses an arrow with `await 0` inside a loop", async () => {
    const errors = await errorsOf(`
const af = async (): Promise<number> => {
  let k = 0;
  while (k < 2) { k = k + 1; await 0; }
  return k;
};
export async function run(): Promise<number> { return await af(); }
`);
    expect(errors.some((m) => m.includes("#6780"))).toBe(true);
  });

  it("does not widen the refusal to bodies with a REAL suspension (#3587/#6504 scope)", async () => {
    const errors = await errorsOf(`
async function g(): Promise<number> { return 1; }
async function af(): Promise<number> {
  let s = 0;
  for (let i = 0; i < 2; i++) { s = s + (await g()); }
  return s;
}
export async function run(): Promise<number> { return await af(); }
`);
    expect(errors.filter((m) => m.includes("#6780"))).toEqual([]);
  });

  it("does not refuse populations the engine never claims at any operand (methods, nested declarations)", async () => {
    const errors = await errorsOf(`
class C { async m(): Promise<number> { for (let i = 0; i < 2; i++) { await null; } return 1; } }
export async function run(): Promise<number> {
  async function inner(): Promise<number> { for (let i = 0; i < 2; i++) { await null; } return 2; }
  return (await new C().m()) + (await inner());
}
`);
    expect(errors.filter((m) => m.includes("#6780"))).toEqual([]);
  });
});
