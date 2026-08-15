// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2660 M3) The runtime edge from a FUNCTION VALUE to its prototype object,
 * under `--target standalone`.
 *
 * The prototype object of a user function constructor already exists, and
 * `new F()` instances already link to it — what was missing was the edge from
 * the function VALUE, because the object is keyed by a COMPILE-TIME name
 * (`ctx.fnctorPrototypeObject` / `ctx.protoGlobals`). Every dynamic consumer —
 * `k["prototype"]`, and §7.3.20 `Get(C, "prototype")` inside
 * `__instanceof_dynamic` — therefore answered `undefined` / the conservative
 * `false`. See `src/codegen/closure-prototype-edge.ts`.
 *
 * Every case asserts BOTH halves of the contract, the way
 * `es5-standalone-instanceof.test.ts` does: the ANSWER, and a ZERO-import
 * binary. A right answer that reintroduces a host import is still refused by
 * the #2961 leak guard, so the import count is part of the contract.
 *
 * The three REFUSAL cases at the end are the load-bearing ones. This edge is
 * identity-keyed precisely so it can never answer a wrong `true`, and an arrow
 * function must keep answering `undefined` for `.prototype` (§15.3).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Outcome {
  result: number;
  imports: string[];
}

/** Compile a standalone SCRIPT, run `__module_init`, read `result`. */
async function run(body: string): Promise<Outcome> {
  const source = `var result = -1;\n${body}\nexport function test(): number { return result as number; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "issue-2660-m3.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((i: unknown) =>
    typeof i === "string" ? i : `${(i as { module: string }).module}::${(i as { name: string }).name}`,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  const result = (instance.exports as Record<string, () => number>).test();
  return { result, imports };
}

/**
 * A fnctor the #2660 S1 escape gate approves, i.e. one whose `new F()` site is
 * classified `reconstruct`. Without the dynamic instance read the gate answers
 * `keep-static`, no per-fnctor prototype global is minted, and there is nothing
 * for the edge to point at — so this prelude is not decoration, it is the
 * precondition the whole substrate is gated on.
 */
const APPROVED_FNCTOR = `function F(){}\nF.prototype = {q:7};\nvar c:any = new F();\nvar dynRead:any = c["q"];\n`;

describe("#2660 M3 — the closure → prototype runtime edge", () => {
  it("answers a dynamic `f['prototype']` read with the prototype object", async () => {
    // Measured before this change: `undefined`. The STATIC `F.prototype` read
    // answered `{q:7}` at the same time — one property, two disjoint stores.
    const o = await run(
      `${APPROVED_FNCTOR}var K:any = F;\nvar p = K["prototype"];\nresult = (p && p.q === 7) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("the dynamic read and the static read are the SAME object", async () => {
    // Identity, not just equality of contents. This is the invariant the whole
    // #2660 substrate rests on: ONE prototype object per function, which is also
    // the object `new F()` seeds into the instance's `$proto`.
    const o = await run(
      `function F(){}\nvar staticRead:any = (F as any).prototype;\nvar K:any = F;\nresult = (K["prototype"] === staticRead) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("`new F() instanceof K` is true for a variable RHS (§7.3.20 through the edge)", async () => {
    // The residual #2916 names as its single remaining dependency. `K` is an
    // `any`-typed binding, so every static instanceof rule declines and the
    // fully-dynamic `__instanceof_dynamic` helper must do `Get(C, "prototype")`
    // on a closure value. Measured before: `false`.
    const o = await run(`${APPROVED_FNCTOR}var K:any = F;\nresult = (c instanceof K) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("`({}) instanceof K` stays FALSE — the edge answers membership, not identity", async () => {
    // The wrong-`true` guard. A fresh object is not in F.prototype's chain, and
    // the edge must not turn "I found the prototype" into "the value is an
    // instance". Same program as the case above, different LHS.
    const o = await run(`${APPROVED_FNCTOR}var K:any = F;\nresult = (({}) instanceof K) ? 1 : 0;`);
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("an own `prototype` write WINS over the compile-time edge (§7.3.20 step 5)", async () => {
    // `K.prototype = undefined` lands in the closure's own-property bag (#3468)
    // and is the program's explicit state, so `instanceof` must throw a
    // TypeError rather than fall back to the compile-time prototype object.
    // Consulting the edge first would turn a right answer into a wrong one.
    const o = await run(
      `${APPROVED_FNCTOR}var K:any = F;\nK.prototype = undefined;\n` +
        `try { ({}) instanceof K; result = 0; } catch (e) { result = (e instanceof TypeError) ? 1 : 5; }`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("a `new Function` value with `prototype = undefined` throws a catchable TypeError", async () => {
    // `language/expressions/instanceof/S15.3.5.3_A2_T2` — measured fail→pass.
    // The RHS is a runtime callable with no compile-time prototype global at
    // all, so this is the OWN-BAG half of the arm, not the edge half.
    const o = await run(
      `var FACTORY:any = new Function;\nFACTORY.prototype = undefined;\nvar obj:any = {};\n` +
        `try { obj instanceof FACTORY; result = 0; } catch (e) { result = (e instanceof TypeError) ? 1 : 5; }`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("a `new Function` value with a STRING `prototype` throws a catchable TypeError", async () => {
    // `S15.3.5.3_A2_T6` — measured fail→pass. A present-but-non-object
    // `prototype` is §7.3.20 step 5, distinct from an absent one; the arm's
    // `__hasOwnProperty` gate is what separates the two.
    const o = await run(
      `var FACTORY:any = new Function;\nFACTORY.prototype = "error";\n` +
        `try { (function(){}) instanceof FACTORY; result = 0; } catch (e) { result = (e instanceof TypeError) ? 1 : 5; }`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  // ── REFUSALS ────────────────────────────────────────────────────────────
  // A missed conversion is a missed conversion; a wrong `true`, a wrong throw
  // or a spurious `.prototype` is a correctness regression.

  it("an ARROW function still has NO `prototype` (§15.3)", async () => {
    // The edge is a table of singletons the compiler minted, not a rule about
    // "callable values", so an arrow is absent from it by construction rather
    // than by an ad-hoc exclusion. Compiled alongside an approved fnctor so the
    // edge table is definitely non-empty and the arm is definitely emitted.
    const o = await run(
      `var a:any = () => 1;\n${APPROVED_FNCTOR}result = (typeof a["prototype"] === "undefined") ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("an unrelated function value does NOT resolve another function's prototype", async () => {
    // Two approved fnctors in one module: the `ref.eq` identity match must pick
    // exactly one. A name-shaped or type-shaped lookup would confuse them.
    const o = await run(
      `function F(){}\nF.prototype = {q:7};\nfunction G(){}\nG.prototype = {q:9};\n` +
        `var cf:any = new F();\nvar cg:any = new G();\nvar r1:any = cf["q"];\nvar r2:any = cg["q"];\n` +
        `var KF:any = F;\nvar KG:any = G;\n` +
        `result = (KF["prototype"].q === 7 && KG["prototype"].q === 9 && (cf instanceof KG) === false) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("a non-callable object RHS still throws, and a plain object still has no `prototype`", async () => {
    // Regression pin for the two arms this change reorganised: the §7.3.20
    // step-1 codegen throw (`es5-standalone-instanceof.test.ts` owns the full
    // set) and the `$Object` receiver path, which must not acquire a
    // `prototype` from the edge.
    const o = await run(
      `${APPROVED_FNCTOR}var o:any = {};\nvar threw = 0;\n` +
        `try { ({}) instanceof o; } catch (e) { threw = (e instanceof TypeError) ? 1 : 0; }\n` +
        `result = (threw === 1 && typeof o["prototype"] === "undefined") ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("a module with no user constructor is unaffected", async () => {
    // The arm builders return an empty instruction list when the edge table is
    // empty, so `__closure_prop_get` keeps its exact previous body AND local
    // list. Behavioural half of that claim; the byte-identity half is the
    // gc/host compile-diff recorded in the issue file.
    const o = await run(`function f(){}\n(f as any).x = 41;\nresult = ((f as any).x as number) + 1;`);
    expect(o.result).toBe(42);
    expect(o.imports).toEqual([]);
  });
});
