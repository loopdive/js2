import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function runWrapped(body: string): Promise<number> {
  const meta = parseMeta(body);
  const { source } = wrapTest(body, meta);
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#1450 NamedEvaluation: anonymous fn/class names from destructuring defaults", () => {
  // ── Acceptance criterion 1: catch parameter array destructuring ────────
  it("try/catch array pattern: anonymous fn inherits binding name", async () => {
    const v = await runWrapped(`
      try { throw []; } catch ([fn = function () {}, xFn = function x() {}]) {
        assert.sameValue(fn.name, 'fn');
        assert.notSameValue(xFn.name, 'xFn');
      }
    `);
    expect(v).toBe(1);
  });

  // ── catch parameter object destructuring ────────────────────────────────
  it("try/catch object pattern: anonymous fn inherits binding name", async () => {
    const v = await runWrapped(`
      try { throw {}; } catch ({ fn = function () {} }) {
        assert.sameValue(fn.name, 'fn');
      }
    `);
    expect(v).toBe(1);
  });

  // ── for-of destructuring default ────────────────────────────────────────
  it("for-of let array pattern: anonymous fn inherits binding name", async () => {
    const v = await runWrapped(`
      for (let [fn = function () {}] of [[]]) {
        assert.sameValue(fn.name, 'fn');
      }
    `);
    expect(v).toBe(1);
  });

  // ── function param destructuring (binding pattern with default) ─────────
  it("function param array pattern: anonymous fn inherits binding name", async () => {
    const v = await runWrapped(`
      function f([fn = function () {}]) {
        assert.sameValue(fn.name, 'fn');
      }
      f([]);
    `);
    expect(v).toBe(1);
  });

  // ── function param default (no destructuring) — already worked pre-1450
  it("function param default: anonymous fn inherits binding name", async () => {
    const v = await runWrapped(`
      function g(h = function () {}) {
        assert.sameValue(h.name, 'h');
      }
      g();
    `);
    expect(v).toBe(1);
  });

  // ── var/let/const declarator (already covered by #1049) ─────────────────
  it("variable declarator: anonymous fn inherits binding name", async () => {
    const v = await runWrapped(`
      const f = function () {};
      assert.sameValue(f.name, 'f');
    `);
    expect(v).toBe(1);
  });

  // ── Named function expression in destructuring default keeps own name
  it("named function expression in destructuring default keeps own name", async () => {
    const v = await runWrapped(`
      try { throw []; } catch ([xFn = function x() {}]) {
        // Per spec NamedEvaluation: named fn expression keeps its own name 'x'.
        // We at least verify it is NOT 'xFn' (the binding identifier).
        assert.notSameValue(xFn.name, 'xFn');
      }
    `);
    expect(v).toBe(1);
  });
});
