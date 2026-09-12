// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5372 — an `await` sitting inside an initializer / assignment / return
// expression of an async function (a conditional operand, `cond && await p`,
// an awaited call whose callee itself awaits, `return cond ? await a : b`)
// was not a suspension point: the linear planner rejected the statement, the
// CFG planner did not know the shape, and the whole function fell back to the
// legacy synchronous pass-through where `await` is an identity — the binding
// received the Promise OBJECT. marked's `parseMarkdown` async arm (the 10
// `Hooks.test.js` async tests) is exactly this shape.
//
// The fixtures are UNTYPED `.js` (a `: any` annotation routes to a different
// arm) in a two-file project, compiled and instantiated exactly as the dogfood
// worker does (`compileProject` + `buildCompiledImports` + `wrapExports`).
// Every row consumes its binding through string concatenation so a leaked
// Promise reads as `[object Promise]` instead of being flattened by the host
// `.then`.
//
// Parent (`cbd2f11dff`) counts, JS-host lane: 10 rows fail / 13 pass (the
// `r13` control validates on the parent because nothing drives it there).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";

const LIB = `export function later(v) {
  return new Promise((r) => setTimeout(() => r(v), 1));
}
export function tick() {
  return new Promise((r) => setTimeout(r, 1));
}
export async function laterAsync(v) {
  await tick();
  return v;
}
`;

const ROWS = `import { later, laterAsync, tick } from "./lib.js";

export const hooks = {
  async pre(x) {
    await tick();
    return "P" + x;
  },
};

export async function r1(cond) {
  const u = cond ? await later("A") : "B";
  return "[" + u + "]";
}
export async function r2(cond) {
  const u = cond ? "B" : await later("A");
  return "[" + u + "]";
}
export async function r3(cond) {
  const u = cond ? await laterAsync("A") : "B";
  return "[" + u + "]";
}
export async function r4(cond, fn) {
  const u = cond ? await fn("A") : "B";
  return "[" + u + "]";
}
export async function r5(cond) {
  const u = cond ? await hooks.pre("x") : "B";
  return "[" + u + "]";
}
export async function r6() {
  const u = await later("A");
  return "[" + u + "]";
}
export async function r7(cond) {
  let u = "B";
  if (cond) u = await later("A");
  return "[" + u + "]";
}

function syncLex(u, i) {
  return "L(" + u + "," + i + ")";
}
function syncLexInline(u, i) {
  return "LI(" + u + "," + i + ")";
}
function syncParse(p, i) {
  return "parse(" + p + ")";
}
function syncParseInline(p, i) {
  return "parseInline(" + p + ")";
}
async function provideLexer(e) {
  await tick();
  return e ? (u, i) => "AL(" + u + "," + i + ")" : (u, i) => "ALI(" + u + "," + i + ")";
}
export async function r8(cond, e) {
  const c = await (cond ? await provideLexer(e) : syncLex)("u", "i");
  return "[" + c + "]";
}
export async function r9(cond, e) {
  let u = cond ? await later("A") : "n",
    c = await (cond ? await provideLexer(e) : syncLex)(u, "i"),
    p = cond ? await later("P" + c) : c;
  return "[" + p + "]";
}
export async function r10(cond) {
  let flag = "no";
  const p = later("x").then(() => {
    flag = "yes";
  });
  cond && (await p);
  return flag;
}
export async function r11(cond) {
  const h = "h";
  return cond ? await later("R") : h;
}
export async function r12(cond) {
  let u;
  u = cond ? await later("A") : "B";
  return "[" + u + "]";
}
function getColorEnabled() {
  return true;
}
// hono getColorEnabledAsync: a BLOCK-bodied async IIFE inside the awaited
// operand. The host frame machine cannot re-compile that shape in a resume
// function (#6410, pre-existing on the linear path too), so the hoisting lane
// must leave the statement alone — the module has to stay VALID.
export async function r13(cond) {
  const isNoColor = cond ? await (async () => { return true; })() : !getColorEnabled();
  return "[" + isNoColor + "]";
}

export const markedHooks = {
  async preprocess(n) {
    await tick();
    return "pre(" + n + ")";
  },
  async provideLexer(e) {
    await tick();
    return (u, i) => "lex(" + u + ")";
  },
  processAllTokens(c) {
    return "tok(" + c + ")";
  },
  provideParser(e) {
    return syncParse;
  },
  async postprocess(h) {
    await tick();
    return "post(" + h + ")";
  },
};

export class Marked {
  constructor() {
    this.defaults = { hooks: null, async: true, walkTokens: null };
  }
  walkTokens(p, fn) {
    return [later(fn(p))];
  }
  use(opts) {
    this.defaults = { ...this.defaults, ...opts };
    return this;
  }
  parseMarkdown(e) {
    return (n, s) => {
      const i = { ...this.defaults, ...s };
      if (i.async)
        return (async () => {
          let u = i.hooks ? await i.hooks.preprocess(n) : n,
            c = await (i.hooks ? await i.hooks.provideLexer(e) : e ? syncLex : syncLexInline)(u, i),
            p = i.hooks ? await i.hooks.processAllTokens(c) : c;
          i.walkTokens && (await Promise.all(this.walkTokens(p, i.walkTokens)));
          let h = await (i.hooks ? await i.hooks.provideParser(e) : e ? syncParse : syncParseInline)(p, i);
          return i.hooks ? await i.hooks.postprocess(h) : h;
        })().catch((err) => "ERR:" + err.message);
      return syncLex(n, i);
    };
  }
}
export function parseWithHooks(md) {
  return new Marked().use({ hooks: markedHooks, walkTokens: (p) => p }).parseMarkdown(true)(md, {});
}
export function parseWithoutHooks(md) {
  return new Marked().parseMarkdown(true)(md, {});
}
`;

// The "also seen" shape from the issue: marked's async IIFE (with `.catch`)
// placed inside an ASYNC function that awaits it. On the parent this module
// does not even VALIDATE (`__async_resume_f…: not enough arguments on the
// stack for local.set`), so it lives in its own compiled module — every row
// here, controls included, fails on the parent.
const IIFE_ROWS = `import { tick } from "./lib.js";

function onError(e) {
  return "ERR:" + e.message;
}
function syncLex(u, i) {
  return "L(" + u + ")";
}
export const hooks = {
  async preprocess(n) { await tick(); return "pre(" + n + ")"; },
  async provideLexer(e) { await tick(); return (u, i) => "lex(" + u + ")"; },
  async postprocess(h) { await tick(); return "post(" + h + ")"; },
};
export function iifeInPlain(md) {
  return (async () => {
    await tick();
    return "<p>" + md + "</p>";
  })().catch(onError);
}
export async function iifeInAsync(md) {
  const p = (async () => {
    await tick();
    return "<p>" + md + "</p>";
  })().catch(onError);
  const html = await p;
  return html;
}
export async function asyncIifeOnly(md, hooks) {
  const i = { hooks };
  const p = (async () => {
    let u = i.hooks ? await i.hooks.preprocess(md) : md,
      c = await (i.hooks ? await i.hooks.provideLexer(true) : syncLex)(u, i);
    return i.hooks ? await i.hooks.postprocess(c) : c;
  })().catch(onError);
  const html = await p;
  return "<p>" + html + "</p>";
}
export function asyncIifeOnlyWithHooks(md) {
  return asyncIifeOnly(md, hooks);
}
`;

type Exports = Record<string, (...args: unknown[]) => unknown>;
type Compiled = Awaited<ReturnType<typeof compileProject>>;

const roots: string[] = [];
let compiled: Compiled;
let compiledIife: Compiled;

async function compileRows(tag: string, rows: string): Promise<Compiled> {
  const root = mkdtempSync(join(tmpdir(), `js2-5372-${tag}-`));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "lib.js"), LIB);
  writeFileSync(join(root, "rows.js"), rows);
  const result = await compileProject(join(root, "rows.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
    emitWat: false,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

beforeAll(async () => {
  compiled = await compileRows("rows", ROWS);
  expect(WebAssembly.validate(compiled.binary)).toBe(true);
  compiledIife = await compileRows("iife", IIFE_ROWS);
}, 180_000);

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Fresh instance per row so module-level state cannot leak between rows. */
async function instantiate(result: Compiled): Promise<Exports> {
  const deps: Record<string, unknown> = Object.create(null);
  Object.assign(deps, getWebHostConstructors());
  const imports = buildCompiledImports(result, deps) as Record<string, unknown> & {
    setInstance?: (i: WebAssembly.Instance) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, { signatures: result.exportSignatures }) as Exports;
}

/** Settle on the host via `.then`; a stranded frame reads as STRANDED rather than hanging the suite. */
async function settle(run: (m: Exports) => unknown, result: Compiled = compiled): Promise<string> {
  const m = await instantiate(result);
  return await Promise.race([
    Promise.resolve(run(m)).then(
      (value) => String(value),
      (error) => `rejected:${String((error as Error)?.message ?? error)}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("STRANDED"), 3000)),
  ]);
}

describe("#5372 await inside an initializer expression suspends (failing on the parent)", () => {
  it("cond ? await later('A') : 'B' [true] -> [A]", async () => {
    expect(await settle((m) => m.r1(true))).toBe("[A]");
  });
  it("cond ? 'B' : await later('A') [false] (await in the else branch) -> [A]", async () => {
    expect(await settle((m) => m.r2(false))).toBe("[A]");
  });
  it("cond ? await laterAsync('A') : 'B' (async fn callee) -> [A]", async () => {
    expect(await settle((m) => m.r3(true))).toBe("[A]");
  });
  it("cond ? await fn('A') : 'B' (any-typed callee param) -> [A]", async () => {
    expect(await settle((m) => m.r4(true, (x: unknown) => Promise.resolve(x)))).toBe("[A]");
  });
  it("await (cond ? await provideLexer(e) : syncLex)(u, i) (marked's nested form) [true,true]", async () => {
    expect(await settle((m) => m.r8(true, true))).toBe("[AL(u,i)]");
  });
  it("await (cond ? await provideLexer(e) : syncLex)(u, i) [true,false]", async () => {
    expect(await settle((m) => m.r8(true, false))).toBe("[ALI(u,i)]");
  });
  it("let u = cond ? await …, c = await (…)(u, i), p = cond ? await … : c (multi-declarator)", async () => {
    expect(await settle((m) => m.r9(true, true))).toBe("[PAL(A,i)]");
  });
  it("cond && (await p) as a statement suspends [true]", async () => {
    expect(await settle((m) => m.r10(true))).toBe("yes");
  });
  it("u = cond ? await later('A') : 'B' (assignment form) -> [A]", async () => {
    expect(await settle((m) => m.r12(true))).toBe("[A]");
  });
  it("marked parseMarkdown async arm with hooks", async () => {
    expect(await settle((m) => m.parseWithHooks("md"))).toBe("post(parse(tok(lex(pre(md)))))");
  });
});

describe("#5372 controls (passing on the parent too)", () => {
  it("cond ? await later('A') : 'B' [false] -> [B]", async () => {
    expect(await settle((m) => m.r1(false))).toBe("[B]");
  });
  it("cond ? 'B' : await later('A') [true] -> [B]", async () => {
    expect(await settle((m) => m.r2(true))).toBe("[B]");
  });
  it("cond ? await hooks.pre('x') : 'B' (object-literal async method) -> [Px]", async () => {
    expect(await settle((m) => m.r5(true))).toBe("[Px]");
  });
  it("await later('A') (no conditional) -> [A]", async () => {
    expect(await settle((m) => m.r6())).toBe("[A]");
  });
  it("let u = 'B'; if (cond) u = await later('A') -> [A]", async () => {
    expect(await settle((m) => m.r7(true))).toBe("[A]");
  });
  it("nested form with the non-awaiting arm taken [false]", async () => {
    expect(await settle((m) => m.r8(false, true))).toBe("[L(u,i)]");
  });
  it("multi-declarator with every non-awaiting arm taken [false]", async () => {
    expect(await settle((m) => m.r9(false, true))).toBe("[L(n,i)]");
  });
  it("cond && (await p) as a statement, cond false", async () => {
    expect(await settle((m) => m.r10(false))).toBe("no");
  });
  it("return cond ? await later('R') : h [true] -> R", async () => {
    expect(await settle((m) => m.r11(true))).toBe("R");
  });
  it("return cond ? await later('R') : h [false] -> h", async () => {
    expect(await settle((m) => m.r11(false))).toBe("h");
  });
  it("assignment form with the non-awaiting arm taken [false]", async () => {
    expect(await settle((m) => m.r12(false))).toBe("[B]");
  });
  it("block-bodied async IIFE in the awaited operand stays off the hoisting lane (#6410): module valid, false arm", async () => {
    expect(await settle((m) => m.r13(false))).toBe("[false]");
  });
  it("marked parseMarkdown async arm without hooks", async () => {
    expect(await settle((m) => m.parseWithoutHooks("md"))).toBe("parse(L(md,[object Object]))");
  });
});

describe("#5372 async IIFE with .catch inside an async function (invalid module on the parent)", () => {
  it("the module validates", () => {
    expect(WebAssembly.validate(compiledIife.binary)).toBe(true);
  });
  it("IIFE inside a plain function (marked's real shape)", async () => {
    expect(await settle((m) => m.iifeInPlain("a"), compiledIife)).toBe("<p>a</p>");
  });
  it("IIFE .catch inside an async function that awaits it", async () => {
    expect(await settle((m) => m.iifeInAsync("b"), compiledIife)).toBe("<p>b</p>");
  });
  it("marked-shaped IIFE inside an async function, with hooks", async () => {
    expect(await settle((m) => m.asyncIifeOnlyWithHooks("m"), compiledIife)).toBe("<p>post(lex(pre(m)))</p>");
  });
  it("marked-shaped IIFE inside an async function, no hooks", async () => {
    expect(await settle((m) => m.asyncIifeOnly("m", null), compiledIife)).toBe("<p>L(m)</p>");
  });
});
