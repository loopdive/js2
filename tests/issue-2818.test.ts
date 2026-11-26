// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";
import { runTest262File } from "./test262-runner.js";

/**
 * #2818 (carved from #2811 / parent #2669) — Bug C, class-method half: a
 * block-scoped `let`/`const` captured by a *class method* read null.
 *
 * Root cause (class-collection ordering): `compileClassesFromStatements`
 * (`src/codegen/declarations.ts`) recurses into control-flow carriers (block /
 * if / loop / switch / try / labeled bodies) WITHOUT forwarding `insideFunction`,
 * so a class textually nested in a block inside a function body was compiled
 * EAGERLY at module-collection time — before the enclosing block's `let`
 * initialised. Its method body then resolved the captured `let` to the
 * `ref.null.extern` graceful fallback and no `local.get; global.set
 * __captured_*` value-sync was emitted → the method read null.
 *
 * Fix (surgical, architect Work Item A/B): defer ONLY a control-flow-nested
 * class *declaration* that genuinely captures an enclosing block-scoped
 * `let`/`const` (mirroring `promoteAccessorCapturesToGlobals`' promote-or-skip
 * conditions). Such a class is re-compiled in-scope by
 * `compileNestedClassDeclaration` (reached from `compileStatement` for a class
 * declaration in ANY statement position), where the local is live and the
 * promotion channel fires. Class EXPRESSIONS and non-capturing classes stay on
 * the eager path — byte-identical to before — which is why this does NOT
 * reproduce the -471 `class/dstr` + `class/elements` regression of the broad
 * `insideFunction`-everywhere attempt (closed PR #2335).
 */

async function runNum(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as { test: () => number }).test();
}

async function runStr(source: string): Promise<string> {
  const result = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as { test: () => string }).test();
}

describe("#2818 — block-scoped let/const captured by a class method", () => {
  it("plain block: `{ let s='outer'; class C { m(){return s;} } new C().m() }` reads the let, not null", async () => {
    expect(
      await runStr(
        `export function test(): string {
           { let s = "outer"; class C { m(): string { return s; } } return new C().m(); }
         }`,
      ),
    ).toBe("outer");
  });

  it("numeric let capture", async () => {
    expect(
      await runNum(
        `export function test(): number {
           { let s = 42; class C { m(): number { return s; } } return new C().m(); }
         }`,
      ),
    ).toBe(42);
  });

  it("const capture", async () => {
    expect(
      await runNum(
        `export function test(): number {
           { const s = 7; class C { m(): number { return s; } } return new C().m(); }
         }`,
      ),
    ).toBe(7);
  });

  it("arrow inside the method reaches the captured let", async () => {
    expect(
      await runStr(
        `export function test(): string {
           { let s = "outer"; class C { m(): string { const g = () => s; return g(); } } return new C().m(); }
         }`,
      ),
    ).toBe("outer");
  });

  it("static method capture", async () => {
    expect(
      await runNum(
        `export function test(): number {
           { let s = 5; class C { static m(): number { return s; } } return C.m(); }
         }`,
      ),
    ).toBe(5);
  });

  it("constructor capture", async () => {
    expect(
      await runNum(
        `export function test(): number {
           { let s = 12; class C { v: number; constructor() { this.v = s; } } return new C().v; }
         }`,
      ),
    ).toBe(12);
  });

  it("param-default capture (#1161 extraNodes)", async () => {
    expect(
      await runNum(
        `export function test(): number {
           { let s = 13; class C { m(x: number = s): number { return x; } } return new C().m(); }
         }`,
      ),
    ).toBe(13);
  });

  it("mutation after capture is observed (shared global, #1672 sync ordering)", async () => {
    expect(
      await runNum(
        `export function test(): number {
           { let s = 1; class C { m(): number { return s; } } const c = new C(); s = 20; return c.m(); }
         }`,
      ),
    ).toBe(20);
  });

  // Control-flow carriers other than a bare block — all reached by
  // compileStatement, so the deferred capturer is re-compiled in-scope.
  it("if-block capture", async () => {
    expect(
      await runNum(
        `export function test(): number { if (true) { let s = 3; class C { m(): number { return s; } } return new C().m(); } return -1; }`,
      ),
    ).toBe(3);
  });

  it("for-loop body block capture", async () => {
    expect(
      await runNum(
        `export function test(): number { for (let i = 0; i < 1; i++) { let s = 4; class C { m(): number { return s; } } return new C().m(); } return -1; }`,
      ),
    ).toBe(4);
  });

  it("switch clause capture", async () => {
    expect(
      await runNum(
        `export function test(): number { switch (1) { case 1: { let s = 7; class C { m(): number { return s; } } return new C().m(); } default: return -1; } }`,
      ),
    ).toBe(7);
  });

  it("try-block capture", async () => {
    expect(
      await runNum(
        `export function test(): number { try { let s = 8; class C { m(): number { return s; } } return new C().m(); } catch { return -1; } }`,
      ),
    ).toBe(8);
  });

  it("nested block captures an outer-block let", async () => {
    expect(
      await runNum(
        `export function test(): number { let s = 11; { { class C { m(): number { return s; } } return new C().m(); } } }`,
      ),
    ).toBe(11);
  });

  // ---- Regression controls: must stay correct / unchanged ----

  it("fn-scope capture control still works (promotion already fired before)", async () => {
    expect(
      await runStr(
        `export function test(): string { let s = "outer"; class C { m(): string { return s; } } return new C().m(); }`,
      ),
    ).toBe("outer");
  });

  it("non-capturing block class declaration stays correct (eager path)", async () => {
    expect(
      await runNum(`export function test(): number { { class C { m(): number { return 14; } } return new C().m(); } }`),
    ).toBe(14);
  });

  it("non-capturing block class expression stays correct (eager path — the -471 shape)", async () => {
    expect(
      await runNum(
        `export function test(): number { { const C = class { m(): number { return 9; } }; return new C().m(); } }`,
      ),
    ).toBe(9);
  });

  it("shadowing: a method's own param does NOT capture the same-named outer let", async () => {
    expect(
      await runNum(
        `export function test(): number { { let s = 99; class C { m(s: number): number { return s; } } return new C().m(15); } }`,
      ),
    ).toBe(15);
  });
});

// The real test262 cluster this issue targets: the `meth-` / `gen-meth-` /
// `private-meth-` (+ `-static` / `-dflt`) members of ary-ptrn-rest-obj-prop-id
// under statements/class — a `let length = "outer"` captured by the method.
// (The `expressions/class` = `const C = class{}` variants remain a follow-up:
// deferring a class EXPRESSION is the closed-PR-#2335 -471 hazard and is out of
// scope here.)
const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262", "test");
const CLUSTER = [
  "language/statements/class/dstr/meth-ary-ptrn-rest-obj-prop-id.js",
  "language/statements/class/dstr/meth-static-ary-ptrn-rest-obj-prop-id.js",
  "language/statements/class/dstr/meth-dflt-ary-ptrn-rest-obj-prop-id.js",
  "language/statements/class/dstr/gen-meth-ary-ptrn-rest-obj-prop-id.js",
  "language/statements/class/dstr/private-meth-ary-ptrn-rest-obj-prop-id.js",
];

function test262Available(): boolean {
  try {
    readFileSync(join(TEST262_ROOT, CLUSTER[0]!), "utf8");
    return true;
  } catch {
    return false;
  }
}

describe.runIf(test262Available())("#2818 — class-method capture cluster (test262)", () => {
  for (const rel of CLUSTER) {
    it(rel, async () => {
      const res = await runTest262File(join(TEST262_ROOT, rel), "language");
      expect(res.status).toBe("pass");
    });
  }
});

/**
 * (#2818 standalone follow-up) A class with a base class (`extends …`) that
 * captures a block-scoped `let` must compile EAGERLY (as `origin/main` does),
 * never via the capture-defer path. The deferred, block-recompiled path lowers
 * the `super(...)` constructor invocation + captured-global read correctly in
 * the WasmGC/host lane but DESYNCS in the standalone lane, which regressed 6
 * standalone test262 files (`class X extends Iterator` /`extends Parent`
 * capturers). `classDeclCapturesNames` now returns false for any class with an
 * `extends` heritage clause, so derived-class capturers stay eager. Base-less
 * capturers (the genuine #2818 target) still defer and are fixed in both lanes.
 */
async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2818 — derived-class capturer stays eager (standalone lane)", () => {
  it("derived class method captures a block-`let` — standalone returns the mutated count", async () => {
    // Mirrors the `Iterator.prototype.*` `return-is-forwarded*` cluster shape:
    // a `let` mutated through a derived class's method, then read from outside.
    expect(
      await runStandalone(
        `export function test(): number {
           let count = 0;
           class Base { base(): void {} }
           class Derived extends Base { hit(): void { count = count + 1; } }
           const d = new Derived();
           d.hit(); d.hit(); d.hit();
           return count;
         }`,
      ),
    ).toBe(3);
  });

  it("derived-class constructor with super() captures a block-`let` — standalone", async () => {
    // Mirrors `super/call-spread-obj-getter-init`: a `let` mutated in a derived
    // constructor that calls super().
    expect(
      await runStandalone(
        `export function test(): number {
           let seen = 0;
           class Base { constructor() {} }
           class Derived extends Base { constructor() { super(); seen = seen + 1; } }
           new Derived(); new Derived();
           return seen;
         }`,
      ),
    ).toBe(2);
  });

  it("base-less block-`let` capturer still works standalone (the #2818 fix, unaffected)", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
           let s = 42;
           class C { get(): number { return s; } }
           return new C().get();
         }`,
      ),
    ).toBe(42);
  });
});
