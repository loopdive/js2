// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4122) An UNRESOLVABLE assignment is not a cross-domain assignment.
 *
 * `bindingHasMixedAssignmentCarrier` demoted a binding to the boxed `externref`
 * carrier whenever `oracle.staticJsTypeOf` of any assignment was `"mixed"` —
 * which is the oracle's answer for *cannot resolve*, not for *proven to cross
 * domains*. That read absence of evidence as evidence of mixing, and boxed every
 * numeric accumulator fed by a dynamically-dispatched call.
 *
 * The demotion itself is right for the hazard it was written for (#3961: an i32
 * boolean slot destroys a later string assignment by coercing it to
 * truthiness), so the tests below pin BOTH directions: the accumulator unboxes,
 * and every genuinely cross-domain binding still boxes.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

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

/** Body of `fn` with numeric call targets resolved back to names. */
function bodyOf(wat: string, fn: string): string {
  const lines = wat.split("\n");
  const names: string[] = [];
  const declLine = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*\(func \$(\S+)/);
    if (m) {
      names.push(m[1]!);
      declLine.set(m[1]!, i);
    }
  }
  const start = declLine.get(fn);
  if (start === undefined) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\(func \$/.test(lines[i]!)) break;
    out.push(lines[i]!.trim());
  }
  return out.join("\n").replace(/\bcall (\d+)\b/g, (_m, idx) => `call $${names[Number(idx)] ?? idx}`);
}

function localType(body: string, name: string): string {
  return body.match(new RegExp("\\(local \\$" + name + " ([^)]*)\\)"))?.[1] ?? "";
}

/** The cross-engine `method` axis shape, which the regression cost ~3.5x. */
const ACCUMULATOR = `
function P(v){ this.v = v; }
P.prototype.inc = function(){ this.v = this.v + 1; return this.v; };
function benchMethod(){
  var p = new P(0);
  var s = 0;
  for (var i = 0; i < 1000; i++) { s = s + p.inc(); }
  return s;
}
export function main(){ return benchMethod(); }
`;

describe("#4122 — an unresolvable assignment does not demote a proven-numeric slot", () => {
  it("keeps the accumulator in an f64 local", async () => {
    const { wat } = await build(ACCUMULATOR);
    expect(localType(bodyOf(wat!, "benchMethod"), "s")).toBe("f64");
  });

  it("emits no unboxing in the accumulator loop", async () => {
    const { wat } = await build(ACCUMULATOR);
    expect(bodyOf(wat!, "benchMethod")).not.toMatch(/call \$__unbox_number/);
  });

  it("is off under the kill switch, restoring the boxed carrier", async () => {
    const { wat } = await build(ACCUMULATOR, { JS2WASM_MIXED_CARRIER_NUMERIC: "0" });
    const body = bodyOf(wat!, "benchMethod");
    expect(localType(body, "s")).toBe("externref");
    expect(body).toMatch(/call \$__unbox_number/);
  });

  it("computes the same sum either way", async () => {
    for (const env of [undefined, { JS2WASM_MIXED_CARRIER_NUMERIC: "0" }]) {
      const { binary } = await build(ACCUMULATOR, env);
      const { exports } = await WebAssembly.instantiate(await WebAssembly.compile(binary!), {});
      // sum of 1..1000
      expect((exports as { main: () => number }).main()).toBe(500500);
    }
  });

  // --- the #3961 hazard the demotion exists for: these must still box --------

  it.each([
    ["boolean then string", `let b = true; b = "s"; return typeof b;`, "b"],
    ["number then string", `let n = 1; n = "s"; return typeof n;`, "n"],
    ["number then boolean", `let n = 1; n = true; return typeof n;`, "n"],
  ])("still boxes a genuinely cross-domain binding (%s)", async (_label, body, name) => {
    const { wat } = await build(`function f(){ ${body} }\nexport function main(){ return f(); }`);
    expect(localType(bodyOf(wat!, "f"), name)).toBe("externref");
  });

  it("still boxes when the unresolvable slot is NOT provably numeric", async () => {
    // `q()` is not in `numericFunctions` (it can return a string), so the slot
    // has no numeric proof and the conservative demotion must stand.
    const { wat } = await build(`
      function Q(){}
      Q.prototype.q = function(c){ return c ? "s" : 1; };
      function f(o){ let n = 1; n = o.q(1); return n; }
      export function main(){ return f(new Q()); }
    `);
    expect(localType(bodyOf(wat!, "f"), "n")).toBe("externref");
  });
});

describe("#4122 — the grounded slot verdict admits self-reference", () => {
  it("proves an accumulator whose own value feeds its update", async () => {
    // `s = s + <numeric>` cannot be proven by a plain least fixpoint: proving
    // `s` numeric requires `s` numeric. The verdict assumes the slot while
    // judging its own definitions, then re-checks groundedness without the
    // assumption.
    const { wat } = await build(ACCUMULATOR);
    expect(localType(bodyOf(wat!, "benchMethod"), "s")).toBe("f64");
  });

  it("does not admit a self-justifying binding with no independent evidence", async () => {
    // `var s = s + 1` reads the slot before anything writes it. JS says NaN;
    // an f64 carrier would read 0. The groundedness re-check must reject it.
    const { wat } = await build(`
      function f(){ var s = s + 1; return s; }
      export function main(){ return f(); }
    `);
    const t = localType(bodyOf(wat!, "f"), "s");
    expect(t).not.toBe("f64");
  });

  it("does not admit a mutual definition cycle", async () => {
    const { wat } = await build(`
      function f(){ var a = b; var b = a; return a; }
      export function main(){ return f(); }
    `);
    expect(localType(bodyOf(wat!, "f"), "a")).not.toBe("f64");
  });
});
