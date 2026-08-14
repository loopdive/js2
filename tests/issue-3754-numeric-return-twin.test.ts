// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3754 — the NUMERIC-RETURN twin.
 *
 * A fnctor prototype method is written with an untyped receiver
 * (`P.prototype.inc = function () { return this.v + 1; }`), so the checker
 * types `this` as `any`, so the return is `any`, so the typed twin's wasm
 * result lowered to `externref`. Inside the twin `this` is a
 * `(ref $__fnctor_P)` whose numeric fields are physical `f64` slots (#3683
 * S4a) — the value was already an f64 and got boxed purely to satisfy a
 * signature derived from the DECLARATION rather than from the body.
 *
 * The caller then paid for that box on the way back in. The `method` axis
 * emitted, per iteration:
 *
 *     call $__dc_P_inc_0_g
 *     call $__to_primitive
 *     call $__unbox_number
 *     f64.add
 *
 * where the arithmetic itself is the single `f64.add`.
 *
 * Four things had to change together or the module fails validation, and the
 * tests below pin each one:
 *
 *  1. the twin is declared `results: [f64]` when the whole-program fixpoint
 *     proved its returns numeric;
 *  2. `reserveDirectCallTrampoline`'s results follow the twin (otherwise the
 *     fill sees a signature disagreement and silently degrades EVERY
 *     devirtualized site to the legacy dispatcher — green, but pointless);
 *  3. the legacy degradation arm unboxes once, so both arms of a guarded
 *     trampoline yield the same wasm result type;
 *  4. the generic body's shim can no longer `return_call` across differing
 *     results — it becomes `call` + box + `return`.
 *
 * The load-bearing tests here are the NEGATIVE ones: a method with mixed
 * returns, a bare `return;`, and a body that falls off the end must all keep
 * the boxed ABI, because each of those returns `undefined` on some path and an
 * f64 result cannot represent it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) One case asserts the call site literally calls `$__dc_P_inc_0_g`.
// The IR inliner's adapter rule inlines `__dc_*` trampolines UNCONDITIONALLY
// (that is rule 3, its cheapest and most reliable win), so the call is gone
// while the twin's f64 result type — what this file actually tests, and what
// every other assertion here reads — is unchanged. Pin the inliner off.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

/**
 * The `method` axis shape, verbatim from `benchmarks/cross-engine/axes-core.js`:
 * a write-once fnctor prototype method called in a loop from an INNER function,
 * behind a thin exported wrapper.
 *
 * The inner/exported split is load-bearing, not cosmetic. `new P(0)` inside an
 * exported function is a construction the escape gate cannot close over, so no
 * `__dc_*` trampoline is reserved at all and there is nothing for these tests
 * to observe. Keeping the benchmark's own shape is also what makes these pins
 * describe the thing that was actually measured.
 */
function methodAxis(
  method: string,
  body = "var s = 0; for (var i = 0; i < 20; i++) { s = s + p.inc(); } return s;",
): string {
  return `
    function P(v) { this.v = v; }
    P.prototype.inc = ${method};
    function inner() {
      var p = new P(0);
      ${body}
    }
    export function run() { return inner(); }
  `;
}

async function build(src: string, env?: Record<string, string>) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env ?? {})) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const result = await compile(src, { fileName: "axes.mjs", skipSemanticDiagnostics: true, target: "standalone" });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary)), "standalone stays host-free").toEqual(
      [],
    );
    return result;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A resolved view of one module's WAT.
 *
 * Call targets are printed as numeric indices (`call 206`), so every body is
 * returned with those rewritten back to `call $name`.
 *
 * The DECLARED result type is deliberately not read here. A func's `(type N)`
 * is an index into the full type space, and the WAT printer emits only a subset
 * of it (84 lines for indices reaching 106), so nothing in the text can be
 * indexed by N. The trampoline's own `(local $__dc_res <type>)` — which the
 * fill allocates directly FROM its declared result — is the readable stand-in,
 * and the instruction shapes below pin the rest.
 */
function readWat(wat: string) {
  const lines = wat.split("\n");
  const funcNames: string[] = [];
  const funcDeclLine = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const fn = lines[i]!.match(/^\s*\(func \$(\S+)/);
    if (fn) {
      funcNames.push(fn[1]!);
      funcDeclLine.set(fn[1]!, i);
    }
  }
  const bodyAt = (name: string): string => {
    const out: string[] = [];
    for (let i = funcDeclLine.get(name)! + 1; i < lines.length; i++) {
      if (/^\s*\(func \$/.test(lines[i]!)) break;
      out.push(lines[i]!.trim());
    }
    return out
      .join("\n")
      .replace(/\b(return_call|call) (\d+)\b/g, (_m, op, idx) => `${op} $${funcNames[Number(idx)] ?? idx}`);
  };
  return {
    has: (name: string): boolean => funcDeclLine.has(name),
    /** The body of `name`, or `""` when the module has no such function. */
    body: (name: string): string => (funcDeclLine.has(name) ? bodyAt(name) : ""),
    /** Every typed-`this` twin's body joined — the twin set is small and the
     *  assertions are about what NONE / ALL of them do. */
    twinBodies: (): string =>
      funcNames
        .filter((n) => /__typed_this$/.test(n))
        .map(bodyAt)
        .join("\n"),
    /** The wasm type of the trampoline's result local — `""` when void. */
    trampolineResultType: (name: string): string =>
      funcDeclLine.has(name) ? (bodyAt(name).match(/\(local \$__dc_res (.*)\)/)?.[1] ?? "") : "",
  };
}

describe("#3754 — numeric-return twins", () => {
  it("the twin returns f64 and no longer boxes on the way out", async () => {
    const { wat } = await build(methodAxis("function () { this.v = this.v + 1; return this.v; }"));
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("f64");
    // The trailing `__box_number` this issue is named for is gone.
    expect(readWat(wat!).twinBodies()).not.toMatch(/call \$__box_number/);
  });

  it("the trampoline's result follows the twin's (point 2 — else the fill degrades)", async () => {
    const { wat } = await build(methodAxis("function () { this.v = this.v + 1; return this.v; }"));
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("f64");
  });

  it("the call site consumes the f64 directly — no __to_primitive / __unbox_number", async () => {
    const { wat } = await build(methodAxis("function () { this.v = this.v + 1; return this.v; }"));
    const run = readWat(wat!).body("inner");
    expect(run).toMatch(/call \$__dc_P_inc_0_g/);
    // These two calls per iteration are exactly what #3754's profile measured.
    expect(run).not.toMatch(/call \$__to_primitive/);
    expect(run).not.toMatch(/call \$__unbox_number/);
  });

  it("produces the same value as the boxed ABI (the kill-switch differential)", async () => {
    const src = methodAxis("function () { this.v = this.v + 1; return this.v; }");
    const on = await build(src);
    const off = await build(src, { JS2WASM_NUMERIC_TWINS: "0" });
    // Pin that the switch really does change the lowering — a differential over
    // two identical modules would prove nothing.
    expect(readWat(off.wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("externref");
    const run = async (r: typeof on) =>
      ((await WebAssembly.instantiate(r.binary, {})).instance.exports as { run(): number }).run();
    expect(await run(on)).toBe(await run(off));
    expect(await run(on)).toBe(210); // 1+2+…+20
  });

  it("a dynamic (non-devirtualized) call still reaches the same value through the shim", async () => {
    // `q` is an `any` the receiver-flow analysis cannot pin, so this call goes
    // through the GENERIC body — i.e. across the `call`+box+`return` shim that
    // replaced the tail call (point 4). If the shim were ill-typed the module
    // would not validate; if it forgot to box, this would read NaN.
    const { binary } = await build(`
      function P(v) { this.v = v; }
      P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
      function opaque(o) { return o.inc(); }
      function inner() {
        var p = new P(40);
        var viaShim = opaque(p);
        return viaShim + p.inc();
      }
      export function run() { return inner(); }
    `);
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(41 + 42);
  });

  // ── negative cases: each of these returns `undefined` on some path ─────────

  it("a MIXED-return method keeps the boxed ABI", async () => {
    const { wat, binary } = await build(`
      function P(v) { this.v = v; }
      P.prototype.inc = function () { this.v = this.v + 1; if (this.v > 2) { return "x"; } return this.v; };
      function inner() { var p = new P(0); var a = p.inc(); var b = p.inc(); var c = p.inc(); return c === "x" ? a + b : 0; }
      export function run() { return inner(); }
    `);
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("externref");
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1 + 2);
  });

  it("a BARE `return;` keeps the boxed ABI", async () => {
    const { wat } = await build(`
      function P(v) { this.v = v; }
      P.prototype.inc = function () { if (this.v > 100) { return; } this.v = this.v + 1; return this.v; };
      function inner() { var p = new P(0); return p.inc(); }
      export function run() { return inner(); }
    `);
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("externref");
  });

  it("a body that can FALL OFF THE END keeps the boxed ABI", async () => {
    // Falling off the end is `return undefined`, which an f64 result cannot
    // represent — `ownReturnExpressions`' definite-return precondition is what
    // rules it out, and this pins that it still does.
    const { wat } = await build(`
      function P(v) { this.v = v; }
      P.prototype.inc = function () { if (this.v < 100) { this.v = this.v + 1; return this.v; } };
      function inner() { var p = new P(0); return p.inc(); }
      export function run() { return inner(); }
    `);
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("externref");
  });

  it("a STRING-returning method is not refined, and keeps its value", async () => {
    const { wat, binary } = await build(`
      function P(v) { this.v = v; }
      P.prototype.inc = function () { return "n" + this.v; };
      function inner() { var p = new P(7); return p.inc() === "n7" ? 1 : 0; }
      export function run() { return inner(); }
    `);
    // Declines for a SECOND, independent reason worth pinning: concatenation
    // gives this method a declared return of `(ref null $AnyString)`, not the
    // `externref` the refinement requires. So the fixpoint's numeric verdict is
    // never even consulted — the gate rejects anything already carrying a
    // native return type, since there is no box there to remove.
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toMatch(/^\(ref null \d+\)$/);
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });

  it("a same-named method elsewhere that returns a non-number demotes BOTH", async () => {
    // The fixpoint's verdict is keyed on the method NAME across the whole
    // program, so one non-numeric `inc` anywhere disqualifies every `inc`. That
    // is the conservative direction; pin it so a future name-scoping change is
    // a deliberate decision rather than a silent one.
    const { wat, binary } = await build(`
      function P(v) { this.v = v; }
      P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
      function Q(s) { this.s = s; }
      Q.prototype.inc = function () { return "q"; };
      function inner() { var p = new P(0); var q = new Q(""); return q.inc() === "q" ? p.inc() : 0; }
      export function run() { return inner(); }
    `);
    expect(readWat(wat!).trampolineResultType("__dc_P_inc_0_g")).toBe("externref");
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(1);
  });
});
