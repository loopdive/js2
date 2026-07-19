import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #3032 W6 slice A — HOST-lane generator declarations route through the native
// state machine (ES2026 §27.5.3.1-3: EvaluateGeneratorBody performs
// GeneratorStart, which SUSPENDS at start-of-body; nothing runs until the
// first `next()`, and GeneratorResumeAbrupt on suspendedStart never runs the
// body). The #3050-era host lane admitted only try-region shapes; W6 drops
// that restriction, so the eager-buffer §27.5 violations (body runs at
// creation) and the buffer's impossible `next(v)` two-way are fixed for every
// safe-use free `function*` declaration under a JS host.
//
// Also pinned here:
//  - the nominal `__GenBrand_n` state-struct branding: two same-shape
//    generators minted structurally IDENTICAL `$__GenState_*` structs, which
//    WasmGC iso-recursive canonicalization merged — every `ref.test` dispatch
//    arm then resumed the FIRST generator's resume fn on the other's state
//    (test262 generators/yield-as-statement.js, BOTH lanes);
//  - sentinel-aware dynamic `.value` reads: the UNDEF_F64 absent/done marker
//    canonicalizes to the REAL host `undefined` (was: boxed NaN through the
//    inline fast chain / `__sget_value`, or JS `null` through null-extern);
//  - W5 pins: `return 9` observation and `it.return(42).value` round-trips
//    (delivered en route by W3/W4 native routing).

async function run(source: string, opts: { standalone?: boolean } = {}): Promise<unknown> {
  const result = await compile(source, {
    fileName: "test.ts",
    ...(opts.standalone ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

const MODES: Array<{ name: string; o: { standalone?: boolean } }> = [
  { name: "host", o: {} },
  { name: "standalone", o: { standalone: true } },
];

describe("#3032 W6 — host-lane declaration laziness (§27.5)", () => {
  for (const mode of MODES) {
    it(`${mode.name}: creation runs NOTHING for a nested capturing declaration`, async () => {
      expect(
        await run(
          `export function test(): number {
             let iterations = 0;
             function* g() { iterations += 1; yield 1; iterations += 1; }
             const it = g();
             return iterations * 100 + 1;
           }`,
          mode.o,
        ),
      ).toBe(1);
    });

    it(`${mode.name}: next(v) two-way reaches the suspended yield (named decl)`, async () => {
      expect(
        await run(
          `export function test(): number {
             let base = 100;
             function* g(): Generator<number, void, number> {
               const got = yield 1;
               yield base + got;
             }
             const it = g();
             it.next();
             const r = it.next(7);
             return r.value as number;
           }`,
          mode.o,
        ),
      ).toBe(107);
    });

    it(`${mode.name}: return-before-start completes without running the body (§27.5.3.2)`, async () => {
      expect(
        await run(
          `export function test(): number {
             let ran = 0;
             function* g(): Generator<number, number, undefined> { ran = 1; yield 1; return 0; }
             const it = g();
             const r = it.return(42);
             return (r.value as number) + ran * 10000 + (r.done ? 1000 : 0);
           }`,
          mode.o,
        ),
      ).toBe(1042);
    });

    it(`${mode.name}: throw-before-start never runs the body`, async () => {
      expect(
        await run(
          `export function test(): number {
             let ran = 0;
             function* g() { ran = 1; yield 1; }
             const it = g();
             let caught = 0;
             try { it.throw(new Error("x")); } catch { caught = 1; }
             return caught * 100 + ran * 10 + 1;
           }`,
          mode.o,
        ),
      ).toBe(101);
    });

    // W5 pins (delivered by W3/W4 routing; keep them locked).
    it(`${mode.name}: return-value observation (return 9) and it.return(42).value`, async () => {
      expect(
        await run(
          `export function test(): number {
             function* g(): Generator<number, number, undefined> { yield 1; return 9; }
             const it = g();
             it.next();
             const r = it.next();
             return (r.value as number) + (r.done ? 1000 : 0);
           }`,
          mode.o,
        ),
      ).toBe(1009);
      expect(
        await run(
          `export function test(): number {
             function* g(): Generator<number, number, undefined> { yield 1; yield 2; return 0; }
             const it = g();
             it.next();
             const r = it.return(42);
             return (r.value as number) + (r.done ? 1000 : 0);
           }`,
          mode.o,
        ),
      ).toBe(1042);
    });
  }

  it("host: exported generator declarations keep the host object (raw structs must not cross the JS boundary)", async () => {
    const result = await compile(`export function* count(): Generator<number> { yield 1; yield 2; }`, {
      fileName: "test.ts",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setExports?.(instance.exports as Record<string, Function>);
    const gen = (instance.exports as { count: () => { next: () => { value: unknown; done: boolean } } }).count();
    expect(typeof gen.next).toBe("function");
    expect(gen.next().value).toBe(1);
    expect(gen.next().value).toBe(2);
    expect(gen.next().done).toBe(true);
  });
});

describe("#3032 W6 — nominal GenState brands (same-shape cross-dispatch)", () => {
  for (const mode of MODES) {
    it(`${mode.name}: two same-shape generators dispatch to their OWN resume fns`, async () => {
      // Pre-brand: $__GenState_g1 and $__GenState_g2 canonicalized to ONE type,
      // so the any-receiver dispatch resumed g1's body on g2's state and
      // g2().next().value read g1's `undefined`.
      expect(
        await run(
          `export function test(): number {
             var iter, result;
             function* g1() { yield; }
             function* g2() { yield 1; }
             iter = g2();
             result = iter.next();
             const v: any = result.value;
             return (typeof v === "number" ? 10 : 0) + (v === 1 ? 1 : 0);
           }`,
          mode.o,
        ),
      ).toBe(11);
    });

    it(`${mode.name}: interleaved same-shape generators keep independent state`, async () => {
      expect(
        await run(
          `export function test(): number {
             var a: any, b: any;
             function* g1() { yield 10; yield 20; }
             function* g2() { yield 1; yield 2; }
             a = g1(); b = g2();
             const r1 = a.next().value;   // 10
             const r2 = b.next().value;   // 1
             const r3 = a.next().value;   // 20
             const r4 = b.next().value;   // 2
             return r1 * 1000 + r2 * 100 + r3 + r4; // 10000 + 100 + 22
           }`,
          mode.o,
        ),
      ).toBe(10122);
    });
  }
});

describe("#3032 W6 — sentinel-aware dynamic value reads (undefined, not NaN/null)", () => {
  it("host: valueless yield and done-result .value are === undefined through any-receiver reads", async () => {
    expect(
      await run(
        `export function test(): number {
           var iter, result;
           function* g1() { yield; }
           iter = g1();
           result = iter.next();
           const a1 = result.value === undefined ? 1 : 0;
           const a2 = result.done === false ? 1 : 0;
           result = iter.next();
           const a3 = result.value === undefined ? 1 : 0;
           const a4 = result.done === true ? 1 : 0;
           return a1 * 1000 + a2 * 100 + a3 * 10 + a4;
         }`,
      ),
    ).toBe(1111);
  });

  it("host: harness-shape isSameValue(result.value, undefined) holds", async () => {
    expect(
      await run(
        `function isSameValue(a: any, b: any): boolean {
           if (a === b) return true;
           return a !== a && b !== b;
         }
         export function test(): number {
           var iter, result;
           function* g1() { yield; }
           iter = g1();
           result = iter.next();
           const a1 = isSameValue(result.value, undefined) ? 1 : 0;
           result = iter.next();
           const a2 = isSameValue(result.value, undefined) ? 1 : 0;
           return a1 * 10 + a2;
         }`,
      ),
    ).toBe(11);
  });

  // #3468 — for-of over a `var it = g()` BINDING with abrupt completion
  // (labeled break/continue/return crossing a try/finally). W6 broadened
  // host-lane native routing so `function* g()` returns a WasmGC state struct;
  // a `var it = g()` binding COERCES that struct to externref (its inferred TS
  // type is `Generator<T>`), so `for (x of it)` fell to the JS-host iterator
  // protocol, which cannot drive a raw struct — `next()` reported `done` on the
  // first call, the loop body (with the `break outer`) was silently skipped,
  // and execution fell through to the "unreachable following for..of" throw.
  // These test262 tests regressed: language/statements/for-of/{break,continue}-
  // label*, return-from-*. The fix keeps such binding-iteration generators on
  // the eager host path (only `.next()/.throw()/.return()` member calls on a
  // binding stay native), while DIRECT-call consumers (`for (x of g())`) keep
  // W6's native driver. Assert the labeled break crosses the outer loop.
  it("host: labeled `break` out of for-of over a generator BINDING (test262 break-label)", async () => {
    expect(
      await run(
        `export function test(): number {
           function* values() { yield 1; }
           var iterator = values();
           var i = 0;
           outer:
           while (true) {
             for (var x of iterator) {
               i += 1;
               break outer;
             }
             return 999; // must NOT be reached (for-of fell through)
           }
           return i; // 1
         }`,
      ),
    ).toBe(1);
  });

  it("host: labeled `continue` out of for-of over a generator BINDING (test262 continue-label)", async () => {
    expect(
      await run(
        `export function test(): number {
           function* values() { yield 1; }
           var iterator = values();
           var i = 0;
           var loop = true;
           outer:
           while (loop) {
             loop = false;
             for (var x of iterator) {
               i += 1;
               continue outer;
             }
             return 999; // must NOT be reached
           }
           return i; // 1
         }`,
      ),
    ).toBe(1);
  });

  it("host: `break outer` from a finally inside for-of over a binding closes the iterator (test262 break-label-from-finally)", async () => {
    // The generator throws on the SECOND resume; iterator-close on abrupt exit
    // must NOT resume it. If for-of ran to completion (host-protocol done-early
    // regression) i would stay 0 and the fall-through 999 would return.
    expect(
      await run(
        `export function test(): number {
           function* values() { yield 1; throw 42; }
           var iterator = values();
           var i = 0;
           outer:
           while (true) {
             for (var x of iterator) {
               try {
               } finally {
                 i += 1;
                 break outer;
               }
             }
             return 999;
           }
           return i; // 1
         }`,
      ),
    ).toBe(1);
  });

  it("host: DIRECT-call for-of native driver still sums correctly (W6 improvement preserved)", async () => {
    expect(
      await run(
        `export function test(): number {
           function* g() { yield 10; yield 20; yield 30; }
           var sum = 0;
           for (var x of g()) { sum += x; }
           return sum; // 60
         }`,
      ),
    ).toBe(60);
  });

  it("host: for-of + spread + Array.from over a generator BINDING all yield real values (#3468)", async () => {
    expect(
      await run(
        `export function test(): number {
           function* g() { yield 3; yield 4; }
           var it1 = g();
           var s = 0;
           for (var x of it1) { s += x; }         // 7
           var it2 = g();
           var arr = [...it2];                     // [3,4]
           var it3 = g();
           var arr2 = Array.from(it3);             // [3,4]
           return s * 100 + (arr[0] + arr[1]) * 10 + (arr2[0] + arr2[1]); // 700+70+7
         }`,
      ),
    ).toBe(777);
  });
});
