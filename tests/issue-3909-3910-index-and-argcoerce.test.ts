import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

// #3909 / #3910 — two *different* root causes that both surfaced as "this only
// breaks when three features appear in one module". Both are validation-time
// failures in `fast` (native-strings) mode.
//
// #3910 — call-argument coercions were applied in the wrong order.
//   `fixCallArgTypesInBody` (src/codegen/stack-balance.ts) collects the
//   coercions it needs by walking BACKWARD from the call, so the collected
//   list is in DESCENDING position order. It then applied them "in reverse
//   order (so positions don't shift)", i.e. ASCENDING — the one order that DOES
//   shift every not-yet-applied position. For a call with 2+ mismatched args
//   the 2nd coercion therefore landed on the 1st argument. A fast-mode regex
//   literal is the minimal trigger:
//       global.get $pattern ; global.get $flags ; call $RegExp_new
//   with both native-string args needing `extern.convert_any` became
//       global.get $pattern ; extern.convert_any ; extern.convert_any ;
//       global.get $flags   ; call $RegExp_new
//   and the later `fixupExternConvertAny` repair pass dropped the duplicate,
//   leaving the FLAGS argument uncoerced:
//     "call[1] expected type externref, found global.get of type (ref null N)".
//
// #3909 — a native-string helper's call target was baked as a LIVE function
//   index instead of the STABLE handle it already had. `resolveNativeStrHelper`
//   preferred a positional `numImportFuncs + i` scan over the stable handle in
//   `ctx.nativeStrHelpers`. A live index has to be chased by every later
//   shifter, and the shift guard is `idx >= importsBefore` — so once enough
//   imports accumulate that `importsBefore` climbs ABOVE the baked number, the
//   stale defined-function reference is misread as an import index and stops
//   being shifted. Measured: `__str_trimStart`'s call to `__str_substring` was
//   baked as 61 with 54 imports; the ~19 union/`typeof` imports that follow
//   push the count past 61, one batch stops applying, and the call lands one
//   slot low on `__str_compare` — arity 2, not 3:
//     "call[0] expected type (ref null 6), found i32.trunc_sat_f64_s of type i32".
//   That crossing threshold is exactly why it took three features to trigger.

async function compileFast(source: string): Promise<{ binary: Uint8Array; wat: string }> {
  const result = await compile(source, { fast: true, emitWat: true, optimize: 0, fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  return { binary: result.binary, wat: result.wat ?? "" };
}

/** The body of one `(func $name …)` in the emitted WAT. */
function funcBody(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `no $${name} in the emitted module`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? undefined : next);
}

describe("#3910 — every mismatched call argument gets its own coercion", () => {
  // The reported repro: a regex literal alongside string constants.
  it("a regex literal in fast mode produces a VALID module", async () => {
    const { binary } = await compileFast(`
export function run(): number {
  const s = "hello world";
  const re = /o/;
  return s.length + (re.test(s) ? 1 : 0);
}`);
    expect(WebAssembly.validate(binary)).toBe(true);
  });

  // A regex literal ALWAYS needs two coercions (pattern + flags), even with no
  // user string constant anywhere — the pattern and the "" flags are both
  // native-string globals feeding an `(externref, externref)` host import. This
  // is the smallest form of the bug.
  it("a bare regex literal — no user string constant — is also valid", async () => {
    const { binary } = await compileFast(`
export function run(s: string): number {
  const re = /o/;
  return re.test(s) ? 1 : 0;
}`);
    expect(WebAssembly.validate(binary)).toBe(true);
  });

  it("both RegExp_new arguments are coerced, not just the first", async () => {
    const { wat } = await compileFast(`
export function run(s: string): number {
  const re = /o/;
  return re.test(s) ? 1 : 0;
}`);
    const run = funcBody(wat, "run");
    // Pre-fix the two coercions stacked on the FIRST argument and the repair
    // pass removed one, so `run` held a single `extern.convert_any` for the
    // pattern and the flags `global.get` reached `call` raw. Assert the shape
    // directly: each of the two `global.get`s feeding RegExp_new is followed by
    // its own conversion.
    const ops = run
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const globalGets: number[] = [];
    ops.forEach((op, i) => {
      if (op.startsWith("global.get")) globalGets.push(i);
    });
    expect(globalGets.length, "expected the pattern + flags string globals").toBeGreaterThanOrEqual(2);
    for (const i of globalGets) {
      expect(ops[i + 1], `global.get at ${i} (${ops[i]}) must be followed by its own coercion`).toBe(
        "extern.convert_any",
      );
    }
  });
});

describe("#3909 — self-hosted string helpers keep their stable call targets", () => {
  // The exact reported shape: JSON.stringify + a regex + a case conversion.
  it("JSON.stringify + regex + case conversion produces a VALID module", async () => {
    const { binary } = await compileFast(`
export function run(): number {
  const s = "  Hello World Test String  ";
  const j = JSON.stringify({ a: 1, b: "x" });
  const lc = s.toLowerCase();
  const mm = s.match(/l/);
  return j.length + lc.length + (mm === null ? 0 : 1);
}`);
    expect(WebAssembly.validate(binary)).toBe(true);
  });

  it("__str_trimStart's substring call targets __str_substring, not its neighbour", async () => {
    const { wat } = await compileFast(`
export function run(): number {
  const s = "  Hello World Test String  ";
  const j = JSON.stringify({ a: 1, b: "x" });
  const lc = s.toLowerCase();
  const mm = s.match(/l/);
  return j.length + lc.length + s.trimStart().length + (mm === null ? 0 : 1);
}`);

    // Function index space: imports first (in declaration order), then defined
    // functions in `(func $name …)` order.
    const importNames = [...wat.matchAll(/^ {2}\(import "[^"]*" "([^"]*)"/gm)].map((m) => m[1]!);
    const funcNames = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((m) => m[1]!);
    const indexOfFunc = (name: string): number => {
      const pos = funcNames.indexOf(name);
      expect(pos, `no $${name} in the emitted module`).toBeGreaterThanOrEqual(0);
      return importNames.length + pos;
    };

    const body = funcBody(wat, "__str_trimStart");
    const calls = [...body.matchAll(/\bcall (\d+)/g)].map((m) => Number(m[1]));
    expect(calls.length, "expected __str_trimStart to call its helpers").toBeGreaterThan(0);

    // The tail call is `s.substring(i, len)`. Pre-fix it pointed one slot low,
    // at `__str_compare` — a 2-arg function fed 3 operands.
    expect(calls.at(-1)).toBe(indexOfFunc("__str_substring"));
    expect(calls.at(-1)).not.toBe(indexOfFunc("__str_compare"));
    // The leading `__str_flatten` call was already correct; assert it stays so,
    // since the fix changes how BOTH are resolved.
    expect(calls[0]).toBe(indexOfFunc("__str_flatten"));
  });

  it("string features that use the self-hosted helpers still work in fast mode", async () => {
    // trim / startsWith / padStart all route through the self-hosted family
    // whose call targets this fix re-resolves.
    const { binary } = await compileFast(`
export function run(): number {
  const s = "  Hello  ";
  return s.trim().length + s.trimStart().length + s.trimEnd().length +
    (s.trim().startsWith("He") ? 1 : 0) + "x".padStart(4, "-").length;
}`);
    expect(WebAssembly.validate(binary)).toBe(true);
  });
});
