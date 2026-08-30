import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5207) An IIFE's ARGUMENT LIST belongs to the CALLER, but the inline-IIFE
 * fast path evaluated it inside the CALLEE's binding scope.
 *
 * `call-tail-dispatch.ts` enters `enterInlineIifeBindingScope` — which hides
 * every name the IIFE declares (parameters, `var`/`let`/`const`, catch
 * parameters, nested function/class names, the function expression's own name)
 * so the spliced-in body cannot see same-named caller bindings — and only
 * THEN compiled the arguments. A bare caller identifier whose name the callee
 * happened to reuse therefore resolved against nothing:
 *
 *   function C(e, t) {
 *     return (function (x) { let t, n = x; return n === null ? "NULL" : n.length; })(t);
 *   }
 *   C("x", [1, 2]);   // native 2 · js2wasm read `t` as null
 *
 * Silent wrong value, no throw. Minifiers reuse short names constantly, so
 * every minified bundle containing an IIFE was exposed; it is the ninth
 * `@js-temporal/polyfill` module-init blocker (#4628), where
 * `GregorianBaseHelper`'s constructor IIFE over `eras` delivered an empty era
 * table and the polyfill threw "Invalid era data: eras are required".
 *
 * The fix moves argument evaluation OUT of that scope and defers binding the
 * parameter NAMES to their slots until the scope is entered. Two consequences
 * are asserted below beyond the reported matrix: argument `i+1` must still see
 * the CALLER's binding for a name parameter `i` shadows
 * (`(function (a, b) {…})(b, a)`), and the same holds for extra arguments past
 * the declared parameter list.
 *
 * Everything here is name-resolution in shared codegen, so each case runs on
 * the host lane AND the standalone lane. The value-returning cases are numeric
 * so the standalone lane (WasmGC `i16` string arrays, not host strings) can be
 * asserted through the same harness.
 */
type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-5207.ts",
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/** Every row asserted on both lanes; each FAILED on base (measured 2026-08-29). */
const rows: ReadonlyArray<readonly [string, string, number]> = [
  [
    // Matrix row 1 — the reduced repro. `let t` inside the callee hid the
    // caller's `t`; base read null and trapped dereferencing it.
    "IIFE parameter `x`, callee declares `let t`, called with caller's `t`",
    `function C(e: number, t: number[]): number {
       return (function (x: number[]) { let t: number[] = []; const n: number[] = x; return n.length + t.length; })(t);
     }
     export function test(): number { return C(1, [1, 2]); }`,
    2,
  ],
  [
    // Matrix row 2 — the control: no name collision, correct on base too.
    "no collision: callee declares `let q`, called with caller's `t`",
    `function C(e: number, t: number[]): number {
       return (function (e: number[]) { let q: number = 0; return e.length + q; })(t);
     }
     export function test(): number { return C(1, [1, 2]); }`,
    2,
  ],
  [
    // Matrix row 3 — `var` reaches the same collector, and it is collected
    // RECURSIVELY (a `var` in a nested block still hides the caller's name).
    "callee declares `var t` in a nested block",
    `function C(e: number, t: number[]): number {
       return (function (x: number[]) { if (e > 0) { var t: number = 7; } return x.length; })(t);
     }
     export function test(): number { return C(1, [1, 2, 3]); }`,
    3,
  ],
  [
    "callee declares `const t`",
    `function C(e: number, t: number[]): number {
       return (function (x: number[]) { const t: number = 5; return x.length + t; })(t);
     }
     export function test(): number { return C(1, [1, 2]); }`,
    7,
  ],
  [
    "arrow IIFE with a block body",
    `function C(e: number, t: number[]): number {
       return ((x: number[]) => { let t: number = 0; return x.length + t; })(t);
     }
     export function test(): number { return C(1, [1, 2]); }`,
    2,
  ],
  [
    "arrow IIFE with a concise body",
    `function C(e: number, t: number[]): number {
       return ((t: number[]) => t.length)(t);
     }
     export function test(): number { return C(1, [1, 2, 3, 4]); }`,
    4,
  ],
  [
    // Matrix row 5 — the caller binding is a `const`, not a parameter.
    "caller binding is a `const`, not a parameter",
    `export function test(): number {
       const t: number[] = [1, 2, 3];
       return (function (x: number[]) { let t: number = 0; return x.length + t; })(t);
     }`,
    3,
  ],
  [
    // Matrix row 6 — a callee PARAMETER of the same name is enough; no body
    // declaration required. This is the shape minifiers emit most.
    "callee PARAMETER shadows the caller's name (no body declaration)",
    `function C(e: number, t: number[]): number {
       return (function (t: number[]) { return t.length; })(t);
     }
     export function test(): number { return C(1, [1, 2, 3, 4, 5]); }`,
    5,
  ],
  [
    // Matrix row 7 — the argument is an EXPRESSION over the hidden name, not
    // the bare identifier; base produced `undefined` rather than a trap.
    "argument is `t.length`, not the bare identifier",
    `function C(e: number, t: number[]): number {
       return (function (x: number) { let t: number = 0; return x + t; })(t.length);
     }
     export function test(): number { return C(1, [1, 2, 3]); }`,
    3,
  ],
  [
    // Not in the reported matrix: argument i+1 must see the CALLER's binding
    // for a name parameter i shadows. Base returned 0 (both read as unbound).
    "later arguments see the CALLER's binding for names earlier parameters shadow",
    `export function test(): number {
       const a: number = 1;
       const b: number = 2;
       return (function (a: number, b: number) { return a * 10 + b; })(b, a);
     }`,
    21,
  ],
  [
    // Not in the reported matrix: EXTRA arguments past the parameter list are
    // caller-scope too. Base evaluated `t` as unbound and returned 100.
    "extra arguments past the parameter list are caller-scope",
    `function C(t: number): number {
       return (function (x: number) { let t: number = 100; return x + t; })(t, t + 1);
     }
     export function test(): number { return C(5); }`,
    105,
  ],
  [
    // The `arguments`-carrier arm builds its vec from the same slots; the
    // extra-argument expression must still be the caller's `t`.
    "the inlined `arguments` carrier is built from caller-scope values",
    `function C(t: number): number {
       return (function (x: number) {
         let t: number = 0;
         return (arguments as any).length * 100 + ((arguments as any)[1] as number);
       })(t, t + 1);
     }
     export function test(): number { return C(5); }`,
    206,
  ],
  [
    // Matrix rows 8 and 9 — the non-IIFE call forms, correct on base. They
    // pin that the fix did not move the regression somewhere else.
    "control: function stored in a variable, then called",
    `function C(e: number, t: number[]): number {
       const f = function (x: number[]) { let t: number = 0; return x.length + t; };
       return f(t);
     }
     export function test(): number { return C(1, [1, 2]); }`,
    2,
  ],
  [
    "control: hoisted named function called normally",
    `function g(x: number[]): number { let t: number = 0; return x.length + t; }
     function C(e: number, t: number[]): number { return g(t); }
     export function test(): number { return C(1, [1, 2]); }`,
    2,
  ],
  [
    // A nested IIFE: the inner argument is the OUTER IIFE's `t`, which the
    // inner callee shadows with `let t`. Both scopes must compose.
    "nested IIFEs compose — the inner argument is the outer callee's binding",
    `export function test(): number {
       const t: number[] = [1, 2];
       return (function (x: number[]) {
         const t: number = x.length + 10;
         return (function (y: number) { let t: number = 0; return y + t; })(t);
       })(t);
     }`,
    12,
  ],
  [
    // A catch parameter also lands in the hidden-name set.
    "a callee catch parameter hides the caller's name",
    `function C(e: number, t: number[]): number {
       return (function (x: number[]) {
         try { throw new Error("x"); } catch (t) { return x.length; }
       })(t);
     }
     export function test(): number { return C(1, [1, 2, 3]); }`,
    3,
  ],
  [
    // A named function expression's OWN name is added to the hidden set too.
    "the function expression's own name does not hide a caller binding",
    `export function test(): number {
       const f: number[] = [1, 2, 3, 4];
       return (function f(x: number[]) { return x.length; })(f);
     }`,
    4,
  ],
];

describe("#5207 — IIFE arguments evaluate in the caller's scope", () => {
  for (const [title, source, expected] of rows) {
    for (const lane of ["host", "standalone"] as const) {
      it(`${title} [${lane}]`, async () => {
        expect(await run(source, lane)).toBe(expected);
      });
    }
  }

  // The polyfill shape itself: an IIFE inside a CONSTRUCTOR over a constructor
  // parameter the IIFE shadows with its own parameter of the same name. Both
  // deliveries the reducer distinguished are covered — a populated era table
  // and an EMPTY one — because "the array arrived empty" and "the argument
  // arrived null" present identically at that call site.
  for (const lane of ["host", "standalone"] as const) {
    it(`constructor IIFE over a shadowed parameter, populated and empty [${lane}]`, async () => {
      expect(
        await run(
          `class GregorianBaseHelper {
             count: number;
             constructor(id: string, isoEpoch: number, eras: number[]) {
               this.count = (function (eras: number[]) {
                 const e: number[] = eras;
                 return e.length;
               })(eras);
             }
           }
           export function test(): number {
             const populated = new GregorianBaseHelper("gregory", 0, [1, 2, 3]);
             const empty = new GregorianBaseHelper("gregory", 0, []);
             return populated.count * 10 + empty.count;
           }`,
          lane,
        ),
      ).toBe(30);
    });
  }
});
