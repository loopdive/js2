// #5380 — `TimeDuration.fdiv`'s `for (; !equal(s, ZERO) && c.length < 50; )`
// never terminated in the compiled `@js-temporal/polyfill`, so
// `ZonedDateTime.prototype.hoursInDay` HUNG (a synchronous Wasm loop the
// runner's timeout cannot interrupt) once #5378 made the offset finite.
//
// STEP-1 ANSWER (measured 2026-09-07, both lanes). The `c.length < 50` bound
// was never the problem and neither was the seam: the length-bounded push loop,
// the braceless `for` whose body is one comma sequence, and the parenthesised
// destructuring assignment to outer `let`s all answered correctly in the
// single-module AND the linked-provider lane. What hung was one function BELOW
// the loop:
//
//   JSBI's `toString(i = 10)` reached `__toStringBasePowerOfTwo` with radix
//   `NaN` instead of `10`. There `n = popcount(NaN - 1) = 0`, so the digit loop
//   `for (u = s >>> n - d; 0 !== u; ) u >>>= n` shifts by ZERO and `u` never
//   changes — an infinite loop with no allocation, i.e. a pure spin.
//
// The radix was NaN because **the host class-method bridge dropped the callee's
// default parameter for a numeric formal**. Those bridges have an
// `(externref, …externref) -> externref` ABI, and `class-method-host-bridge.ts`
// pads an under-applied call with real JS `undefined`; unboxing that to `f64`
// yields a quiet NaN, indistinguishable from a deliberately passed `NaN`, so
// the callee's prologue check (`argc-missing OR sNaN sentinel`) never fired.
//
// The fix converts an incoming `undefined` into the SAME omitted-argument
// sentinel (`0x7FF00000DEADC0DE`) the closure bridges and the statically-omitted
// arm already use — for a DEFAULTED formal only, so no other bridge argument
// moves. `f(undefined)` now runs the default too, which is what §10.2.11
// requires and what the fast closed-dispatch arm also got wrong.
//
// WHY IT ONLY BIT SOME SHAPES: a single class whose method name nothing else
// declares is served by the in-Wasm closed dispatcher, which synthesises the
// constant default itself and was always right. A second declaration of the
// name, a mixed arity, `extends Array`, or a builtin method name like
// `toString` pushes the call to the host bridge — which is why JSBI (one class,
// `extends Array`, method named `toString`) hit it and a toy class did not.
//
// EVERY loop probe below carries an ITERATION CAP, so a regression FAILS with a
// "RUNAWAY" value instead of hanging the test runner.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";
import { setupTemporalPolyfill } from "./dogfood/setup-temporal-polyfill.mjs";

/**
 * Provider side. Three groups:
 *
 *  1. the loop shapes the issue suspected (`push`/`length`, comma-sequence
 *     body, destructuring assignment to outer `let`s) — controls that were
 *     ALREADY green and must stay green;
 *  2. the actual primitive, with no Temporal and no JSBI: a defaulted numeric
 *     formal reached through a dynamic (`any`-receiver) method call, in each of
 *     the receiver shapes that route to the host bridge;
 *  3. explicit `undefined`, which must also run the default.
 */
const PROVIDER_SOURCE = `
// ── (1) the bounded loop shapes, each with a runaway guard ────────────────
export function pushLengthLoop() {
  const c = [];
  let g = 0;
  for (; c.length < 50; ) { c.push(1); if (++g > 400) return "RUNAWAY:" + g + ":len=" + c.length; }
  return "len=" + c.length + ",iters=" + g;
}
export function fdivShapeLoop(total, div) {
  // The polyfill's own shape: braceless \`for\`, ONE comma-sequence body, a
  // parenthesised destructuring assignment rebinding the outer \`let\`s.
  let q, r = total % div;
  const c = [];
  let g = 0;
  for (; r !== 0 && c.length < 50 && ++g <= 400; ) r = r * 10, ({ q, r } = { q: Math.floor(r / div), r: r % div }), c.push(Math.abs(q));
  return g > 400 ? "RUNAWAY:" + g : "len=" + c.length + "," + c.join("");
}

// ── (2) the primitive: a defaulted numeric formal, dynamic receiver ───────
class Single { radix(i = 10) { return "S:" + i; } }
class Twin { radix(i = 10) { return "T:" + i; } }
class Other { radix(a, b) { return "O:" + a + b; } }
class ArraySub extends Array { toString(i = 10) { return "A:" + i; } }
class Builtin { toString(i = 10) { return "B:" + i; } }

function dynRadix(x) { return x.radix(); }
function dynToString(x) { return x.toString(); }
function dynRadixUndefined(x) { return x.radix(undefined); }

export function twoDeclarations() { return dynRadix(new Twin()); }
export function mixedArity() { return dynRadix(new Single()); }
export function arraySubclassToString() { return dynToString(new ArraySub(1)); }
export function builtinNameToString() { return dynToString(new Builtin()); }
export function staticCall() { return new Twin().radix(); }
export function otherArity() { return new Other(1, 2).radix(3, 4); }

// ── (3) explicit undefined must run the default too (§10.2.11) ────────────
export function explicitUndefined() { return dynRadixUndefined(new Twin()); }
`;

const IMPORTED = [
  "pushLengthLoop",
  "fdivShapeLoop",
  "twoDeclarations",
  "mixedArity",
  "arraySubclassToString",
  "builtinNameToString",
  "staticCall",
  "otherArity",
  "explicitUndefined",
] as const;

const CONSUMER_PROBES = `
export function pPushLengthLoop() { return pushLengthLoop(); }
export function pFdivShapeLoop() { return fdivShapeLoop(7, 3); }
export function pTwoDeclarations() { return twoDeclarations(); }
export function pMixedArity() { return mixedArity(); }
export function pArraySubclassToString() { return arraySubclassToString(); }
export function pBuiltinNameToString() { return builtinNameToString(); }
export function pStaticCall() { return staticCall(); }
export function pOtherArity() { return otherArity(); }
export function pExplicitUndefined() { return explicitUndefined(); }
`;

/**
 * Measured on base (2026-09-07, both lanes, identical): `pTwoDeclarations`
 * `"T:NaN"`, `pMixedArity` `"S:NaN"`, `pArraySubclassToString` `"A:NaN"`,
 * `pBuiltinNameToString` `"B:NaN"`, `pExplicitUndefined` `"T:NaN"`. The two
 * loop probes and the two static controls were already correct — which is what
 * makes this the bridge's dropped default and not the `c.length` carrier the
 * issue first suspected.
 */
const EXPECTED: Record<string, unknown> = {
  pPushLengthLoop: "len=50,iters=50",
  pFdivShapeLoop: "len=50,33333333333333333333333333333333333333333333333333",
  pTwoDeclarations: "T:10",
  pMixedArity: "S:10",
  pArraySubclassToString: "A:10",
  pBuiltinNameToString: "B:10",
  pStaticCall: "T:10",
  pOtherArity: "O:34",
  pExplicitUndefined: "T:10",
};

function readAll(exports: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      observed[name] = (exports[name] as (() => unknown) | undefined)?.();
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5380 — a defaulted numeric formal through the dynamic class-method bridge", () => {
  it("answers in the single-module lane", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { ${IMPORTED.join(", ")} } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this is the control lane.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("answers identically through a separately linked package", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5380-"));
    const packageRoot = join(root, "node_modules", "loop5380");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "loop5380", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { ${IMPORTED.join(", ")} } from "loop5380";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently test
    // the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});

/**
 * The real polyfill's `fdiv`, on the real pinned JSBI — the shortest path from
 * the primitive above to the reported hang, without compiling Temporal.
 *
 * `fdivGuarded` is `TimeDuration.prototype.fdiv` verbatim in shape (the helpers
 * `m`/`y`/`g` and the constants `t`/`o` are the polyfill's own), plus a runaway
 * guard so a regression returns `"RUNAWAY:…"` instead of spinning forever.
 */
const JSBI_ENTRY = setupTemporalPolyfill().jsbiEntryPath;
const JSBI_SOURCE = readFileSync(JSBI_ENTRY, "utf-8")
  .replace("export default JSBI;", "")
  .replace(/^\/\/# sourceMappingURL=.*$/gm, "");

const FDIV_SOURCE = `
const e = JSBI;
const t = e.BigInt(0), o = e.BigInt(10);
function y(n) { return e.lessThan(n, t) ? e.unaryMinus(n) : n; }
function g(a, b) { return { quotient: e.divide(a, b), remainder: e.remainder(a, b) }; }
export function big(a, b) { return e.multiply(e.BigInt(a), e.BigInt(b)); }
export function small(a) { return e.BigInt(a); }
export function jsbiToString(a) { return e.BigInt(a).toString(); }
export function fdivGuarded(totalNs, r) {
  const i = e.BigInt(r);
  let { quotient: a, remainder: s } = g(totalNs, i);
  const c = [];
  let d;
  let guard = 0;
  const h = (e.lessThan(totalNs, t) ? -1 : 1) * Math.sign(e.toNumber(r));
  for (; !e.equal(s, t) && c.length < 50; ) {
    s = e.multiply(s, o), ({ quotient: d, remainder: s } = g(s, i)), c.push(Math.abs(e.toNumber(d)));
    if (++guard > 400) return "RUNAWAY:" + guard;
  }
  return String(h * Number(y(a).toString() + "." + c.join("")));
}
`;

describe("#5380 — the polyfill's TimeDuration.fdiv on the pinned JSBI terminates", () => {
  it("divides a 24-hour TimeDuration by an hour", { timeout: 600_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/jsbi.js": `${JSBI_SOURCE}\n${FDIV_SOURCE}`,
        [entry]:
          `import { big, small, jsbiToString, fdivGuarded } from "./jsbi";\n` +
          // 86_400e9 ns / 3_600e9 ns = 24 — exactly ZonedDateTime.hoursInDay.
          `export function pHoursInDay() { return fdivGuarded(big(86400, 1000000000), big(3600, 1000000000)); }\n` +
          // A non-terminating decimal: the c.length < 50 bound is the exit.
          `export function pRepeating() { return fdivGuarded(small(1000000007), small(3)); }\n` +
          // The primitive itself, on the value that spun: radix defaulting.
          `export function pToString() { return jsbiToString(123456); }\n`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    const api = instance.exports as unknown as Record<string, () => unknown>;

    // Base (2026-09-07): `pToString` HUNG (no return, killed at 300 s), and so
    // did both fdiv probes — the guard never ran because the spin is below it.
    expect(api.pToString!()).toBe("123456");
    expect(api.pHoursInDay!()).toBe("24");
    expect(api.pRepeating!()).toBe("333333335.6666667");
  });
});
