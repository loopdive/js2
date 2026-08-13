// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3765) A provably-numeric LOCAL gets an unboxed `f64` slot.
 *
 * #3683 S4a unboxed numeric FIELDS, #3754 unboxed numeric RETURNS; the local
 * was the third and last carrier still paying `__box_number` on write and
 * `__to_primitive` + `__unbox_number` on read. The tokenizer's
 *
 *     var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c;
 *
 * was paying three of its four per-character calls for that one `var`.
 *
 * The verdict is the whole-program fixpoint's grounded slot set, delivered as a
 * second admission route into #684's `UsageInference` — the DEFINITION-site
 * dual of its use-site proof. So the assertions here are about which of the two
 * routes admits a binding, and about the three facts the def-site proof does
 * NOT establish (capture, read-before-declaration, bigint), which must still
 * decline.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  applyNumericPropertyAnalysis,
  type NumericPropertyAnalysisTarget,
  type PropertyKindVerdicts,
} from "../src/codegen/numeric-property-analysis.js";
import { ts } from "../src/ts-api.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) One case here asserts that the numeric-locals KILL SWITCH restores
// the boxed carrier, and detects the boxed carrier by `call $__unbox_number`.
// The ToNumber fast paths (default ON since the tuned-set flip) replace exactly
// that call — with the fused `__to_number`, or with an inline i31 guard — so
// the marker disappears while the carrier is boxed as the kill switch intends.
// Pin the two ToNumber slices off so the marker keeps its meaning.
pinPerfFlags({ JS2WASM_FUSED_TONUMBER: "0", JS2WASM_SMI_FASTPATH: "0" });

async function build(source: string, env?: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await compile(source, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * The WAT printer emits `call <idx>` numerically and prints only a subset of
 * the type table, so names are recovered positionally from the `(func $name`
 * declaration order — the same technique as the #3754 suite.
 */
function readWat(wat: string) {
  const lines = wat.split("\n");
  const funcNames: string[] = [];
  const declLine = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*\(func \$(\S+)/);
    if (m) {
      funcNames.push(m[1]!);
      declLine.set(m[1]!, i);
    }
  }
  const bodyAt = (name: string): string => {
    const out: string[] = [];
    for (let i = declLine.get(name)! + 1; i < lines.length; i++) {
      if (/^\s*\(func \$/.test(lines[i]!)) break;
      out.push(lines[i]!.trim());
    }
    return out
      .join("\n")
      .replace(/\b(return_call|call) (\d+)\b/g, (_m, op, idx) => `${op} $${funcNames[Number(idx)] ?? idx}`);
  };
  return {
    body: (name: string): string => (declLine.has(name) ? bodyAt(name) : ""),
    /** Every typed-`this` twin body joined. */
    twins: (): string =>
      funcNames
        .filter((n) => /__typed_this$/.test(n))
        .map(bodyAt)
        .join("\n"),
    /** The declared wasm type of local `$name` in `fn` — "" when absent. */
    localType(fn: string, name: string): string {
      if (!declLine.has(fn)) return "";
      const m = bodyAt(fn).match(new RegExp("\\(local \\$" + name + " ([^)]*)\\)"));
      return m?.[1] ?? "";
    },
    /**
     * Declared types of local `$name` across the typed-`this` TWIN bodies only.
     * Scoped to twins deliberately: runtime helpers declare their own `$c`, and
     * a whole-module search finds one of those first.
     */
    twinLocalTypes(name: string): string[] {
      const re = new RegExp("\\(local \\$" + name + " ([^)]*)\\)");
      const out: string[] = [];
      for (const n of funcNames.filter((f) => /__typed_this$/.test(f))) {
        const m = bodyAt(n).match(re);
        if (m) out.push(m[1]!);
      }
      return out;
    },
  };
}

/** The tokenizer shape: `c`'s only use is `return c`, a hard bail for #684. */
const TOKENIZER = `
function Tok(input) { this.input = input; this.pos = 0; this.acc = 0; }
Tok.prototype.nextCode = function () {
  var c = this.input.charCodeAt(this.pos);
  this.pos = this.pos + 1;
  return c;
};
Tok.prototype.run = function () {
  while (this.pos < this.input.length) { this.acc = this.acc + this.nextCode(); }
  return this.acc;
};
function drive(s) { var t = new Tok(s); return t.run(); }
export function main() { return drive("hello world"); }
`;

describe("#3765 — a provably-numeric local gets an f64 slot", () => {
  it("gives the tokenizer's `var c` an f64 local in the typed twin", async () => {
    const { wat } = await build(TOKENIZER);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).toContain("f64");
  });

  it("removes the box/unbox calls that local was paying for", async () => {
    const { wat } = await build(TOKENIZER);
    const twins = readWat(wat!).twins();
    expect(twins).not.toMatch(/call \$__box_number/);
    expect(twins).not.toMatch(/call \$__to_primitive/);
    expect(twins).not.toMatch(/call \$__unbox_number/);
  });

  it("carries a grounded numeric-local proof into an untyped helper parameter", async () => {
    const result = await build(`
      function isAscii(c) { return c >= 0 && c <= 127; }
      function scan(input) {
        var c = input.charCodeAt(0);
        return isAscii(c);
      }
      export function main() { return scan("A"); }
    `);
    const { wat, binary } = result;
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs).toContain("scan");
    // DCE compacts the current type index while debug type labels retain
    // their allocation-time name, so `$type${index}` is not a stable lookup.
    // These operations can validate only when parameter zero is the grounded
    // f64 carrier. The single-use upper bound should also be rematerialized
    // instead of consuming another local, pinning the optimized no-boxing shape.
    const helperBody = readWat(wat!).body("isAscii");
    expect(helperBody).toMatch(/local\.get 0\s+f64\.const 0\s+f64\.ge/);
    expect(helperBody).toMatch(/local\.get 0\s+f64\.const 127\s+f64\.le/);
    expect(helperBody).not.toMatch(/call \$__(?:box_number|to_primitive|unbox_number)/);
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    expect((exports as { main: () => number }).main()).toBe(1);
  });

  it("keeps a grounded numeric local unboxed through a numeric switch", async () => {
    const { wat, binary } = await build(`
      function classify(input) {
        var ch = input.charCodeAt(0);
        switch (ch) {
          case 10: return 1;
          case 32: return 2;
          case 65: return 3;
          default: return 4;
        }
      }
      export function main() { return classify("A"); }
    `);
    const body = readWat(wat!).body("classify");
    expect(readWat(wat!).localType("classify", "ch")).toBe("f64");
    expect(body).toMatch(/f64\.eq/);
    expect(body).not.toMatch(/call \$__box_number/);
    expect(body).not.toMatch(/call \$__typeof_number/);
    expect(body).not.toMatch(/call \$__unbox_number/);
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    expect((exports as { main: () => number }).main()).toBe(3);
  });

  it("keeps an inferred numeric parameter unboxed through a numeric switch", async () => {
    const { wat, binary } = await build(`
      function classify(ch) {
        switch (ch) {
          case 10: return 1;
          case 32: return 2;
          case 65: return 3;
          default: return 4;
        }
      }
      export function main() { return classify("A".charCodeAt(0)); }
    `);
    const body = readWat(wat!).body("classify");
    expect(wat).toMatch(/\(func \$classify \(param f64\)/);
    expect(body).toMatch(/f64\.eq/);
    expect(body).not.toMatch(/call \$__box_number/);
    expect(body).not.toMatch(/call \$__typeof_number/);
    expect(body).not.toMatch(/call \$__unbox_number/);
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    expect((exports as { main: () => number }).main()).toBe(3);
  });

  it("is off under the kill switch, restoring the boxed carrier", async () => {
    const { wat } = await build(TOKENIZER, { JS2WASM_NUMERIC_LOCALS: "0" });
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).toContain("externref");
    // The three calls the promotion removes are all back.
    expect(w.twins()).toMatch(/call \$__box_number/);
    expect(w.twins()).toMatch(/call \$__unbox_number/);
  });

  it("still computes the same answer", async () => {
    for (const env of [undefined, { JS2WASM_NUMERIC_LOCALS: "0" }]) {
      const { binary } = await build(TOKENIZER, env);
      const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
      // "hello world" char-code sum.
      expect((exports as { main: () => number }).main()).toBe(1116);
    }
  });

  // --- the three facts the definition-site proof does NOT establish ---------

  it("declines a local captured by a nested closure (it lives in a ref cell)", async () => {
    const { wat } = await build(`
      function Tok(input) { this.input = input; this.pos = 0; }
      Tok.prototype.nextCode = function () {
        var c = this.input.charCodeAt(this.pos);
        this.pos = this.pos + 1;
        var get = function () { return c; };
        return get();
      };
      function drive(s) { var t = new Tok(s); return t.nextCode(); }
      export function main() { return drive("A"); }
    `);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).not.toContain("f64");
  });

  it("declines a local read before its own declaration", async () => {
    // `c` is read on a path that precedes the `var c = …` that would prove it
    // numeric. JS reads `undefined` there; an f64 slot would read 0/NaN.
    const { wat, binary } = await build(`
      function Tok(input) { this.input = input; this.pos = 0; this.flag = 0; }
      Tok.prototype.nextCode = function () {
        if (this.flag) { return c; }
        var c = this.input.charCodeAt(this.pos);
        this.pos = this.pos + 1;
        return c;
      };
      function drive(s) { var t = new Tok(s); return t.nextCode(); }
      export function main() { return drive("A"); }
    `);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).not.toContain("f64");
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    expect((exports as { main: () => number }).main()).toBe(65);
  });

  it("declines a self-referencing initializer (`var c = c + 1`)", async () => {
    const { wat } = await build(`
      function Tok(n) { this.n = n; }
      Tok.prototype.step = function () {
        var c = c + 1;
        return c;
      };
      function drive(n) { var t = new Tok(n); return t.step(); }
      export function main() { return drive(1); }
    `);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).not.toContain("f64");
  });

  it("declines a local whose definitions are not all numeric", async () => {
    const { wat } = await build(`
      function Tok(input) { this.input = input; this.pos = 0; this.flag = 0; }
      Tok.prototype.nextCode = function () {
        var c = this.input.charCodeAt(this.pos);
        if (this.flag) { c = "not a number"; }
        this.pos = this.pos + 1;
        return c;
      };
      function drive(s) { var t = new Tok(s); return t.nextCode(); }
      export function main() { return drive("A"); }
    `);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).not.toContain("f64");
  });

  it("declines a boolean local, which an f64 slot would stringify as 1/0", async () => {
    // The fixpoint's `isNumeric` deliberately answers TRUE for booleans: for a
    // FIELD that is fine, because #2847 brands boolean fields as i32 and the
    // property path defers to that brand via its `anyBoolean` filter. A local
    // has no brand path, so an f64 slot would make `${b}` print "1".
    // Regression: `coercion/tostring > standalone-O > template over any-boolean`.
    const { wat, binary } = await build(`
      function Tok(n) { this.n = n; }
      Tok.prototype.describe = function () {
        var b = this.n < 10;
        return "" + b;
      };
      function drive(n) { var t = new Tok(n); return t.describe(); }
      export function main() { return drive(1); }
    `);
    expect(readWat(wat!).twinLocalTypes("b")).not.toContain("f64");
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    // The interesting assertion is that it is "true", not "1".
    expect(typeof (exports as { main: () => unknown }).main()).not.toBe("number");
  });

  it("declines a pure definition cycle, which has no numeric evidence at all", async () => {
    // `numericSlots` is a GREATEST fixpoint, so `a` and `b` each keep the other
    // alive; both are `undefined` at runtime. The grounded (least-fixpoint) set
    // this consumer uses must reject both.
    const { wat } = await build(`
      function Tok(n) { this.n = n; }
      Tok.prototype.step = function () {
        var a = b;
        var b = a;
        return a;
      };
      function drive(n) { var t = new Tok(n); return t.step(); }
      export function main() { return drive(1); }
    `);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("a")).not.toContain("f64");
  });

  it("keeps the verdict per-slot, not per-name", async () => {
    // Two different `c`s: one provably numeric, one provably a string. A
    // name-keyed verdict would give them one answer; slot-keyed gives two.
    const { wat, binary } = await build(`
      function Tok(input) { this.input = input; this.pos = 0; }
      Tok.prototype.nextCode = function () {
        var c = this.input.charCodeAt(this.pos);
        this.pos = this.pos + 1;
        return c;
      };
      Tok.prototype.label = function () {
        var c = "tok:" + this.pos;
        return c;
      };
      function drive(s) { var t = new Tok(s); return t.nextCode() + t.label().length; }
      export function main() { return drive("A"); }
    `);
    const w = readWat(wat!);
    // The numeric one is promoted; the string one is not. Both are named `c`.
    const types = w.twinLocalTypes("c");
    expect(types).toContain("f64");
    expect(types.some((t) => t !== "f64")).toBe(true);
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    expect((exports as { main: () => number }).main()).toBe(70); // 65 + "tok:1".length
  });
});

describe("#3765 — carrier verdict application stays structural", () => {
  it("keeps field/return verdicts while the local kill switch withholds only the oracle", () => {
    const calls: PropertyKindVerdicts["isNumericLocal"][] = [];
    const target: NumericPropertyAnalysisTarget = {
      numericPropertyNames: new Set(),
      stringPropertyNames: new Set(),
      numericFunctionNames: new Set(),
      usageInference: {
        setNumericLocalOracle: (oracle) => calls.push(oracle),
      },
    };
    const sourceFile = ts.createSourceFile(
      "t.js",
      `
        function Box() { this.count = 1; this.label = "ok"; }
        function numericResult() { return 42; }
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const saved = process.env.JS2WASM_NUMERIC_LOCALS;
    process.env.JS2WASM_NUMERIC_LOCALS = "0";
    try {
      applyNumericPropertyAnalysis(target, {}, [sourceFile]);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NUMERIC_LOCALS");
      else process.env.JS2WASM_NUMERIC_LOCALS = saved;
    }
    expect(target.numericPropertyNames).toContain("count");
    expect(target.stringPropertyNames).toContain("label");
    expect(target.numericFunctionNames).toContain("numericResult");
    expect(calls).toHaveLength(0);
  });

  it("withholds the local oracle across the runtime-eval callable boundary", () => {
    const calls: PropertyKindVerdicts["isNumericLocal"][] = [];
    const target: NumericPropertyAnalysisTarget = {
      numericPropertyNames: new Set(),
      stringPropertyNames: new Set(),
      numericFunctionNames: new Set(),
      runtimeEvalCallableBoundaryEnabled: true,
      usageInference: {
        setNumericLocalOracle: (oracle) => calls.push(oracle),
      },
    };
    const sourceFile = ts.createSourceFile(
      "runtime-eval-provider.ts",
      `
        function Box() { this.count = 1; this.label = "ok"; }
        function numericResult() { return 42; }
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const saved = process.env.JS2WASM_NUMERIC_LOCALS;
    Reflect.deleteProperty(process.env, "JS2WASM_NUMERIC_LOCALS");
    try {
      applyNumericPropertyAnalysis(target, {}, [sourceFile]);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NUMERIC_LOCALS");
      else process.env.JS2WASM_NUMERIC_LOCALS = saved;
    }
    expect(target.numericPropertyNames).toContain("count");
    expect(target.stringPropertyNames).toContain("label");
    expect(target.numericFunctionNames).toContain("numericResult");
    expect(calls).toHaveLength(0);
  });
});

describe("#3765 — `<array>.join()` is a proven string producer", () => {
  // The chain the cross-engine benchmark actually exercises: its 35 KB subject
  // is `parts.join("")`, and without this clause `input` is not a proven string
  // carrier, so `input.charCodeAt(pos)` is not proven numeric, so the local is
  // not promoted — the whole chain failed on the exact shape it targets while a
  // plain string literal worked.
  const JOINED = `
    function Tok(input) { this.input = input; this.pos = 0; }
    Tok.prototype.nextCode = function () {
      var c = this.input.charCodeAt(this.pos);
      this.pos = this.pos + 1;
      return c;
    };
    const parts = ["A", "B"];
    const SRC = parts.join("");
    function drive(s) { var t = new Tok(s); return t.nextCode(); }
    export function main() { return drive(SRC); }
  `;

  it("promotes the local behind a joined subject", async () => {
    const { wat } = await build(JOINED);
    const w = readWat(wat!);
    expect(w.twinLocalTypes("c")).toContain("f64");
  });

  it("still computes the same answer", async () => {
    const { binary } = await build(JOINED);
    const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
    expect((exports as { main: () => number }).main()).toBe(65);
  });
});
