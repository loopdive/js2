// #3481 slice 1 — wrapper-object / exotic-@@toPrimitive ToNumeric unwrap.
//
// §7.1.3 ToNumeric runs ToPrimitive FIRST, so an operand that is a BigInt
// *wrapper* (`Object(2n)`) or an object whose `@@toPrimitive` yields a BigInt is
// NOT a "mix" — `Object(2n) * 2n` is `4n`, not a TypeError.
//
// Three physical shapes carry `@@toPrimitive`, and only two were reachable
// before this slice:
//   1. a dynamic assignment `o[Symbol.toPrimitive] = fn` → sidecar slot;
//   2. a class / object-literal METHOD body `[Symbol.toPrimitive](hint) {…}` →
//      the `__call_@@toPrimitive` struct-method export (#1716);
//   3. an object-literal computed PROPERTY `{ [Symbol.toPrimitive]: fn }` → the
//      closure lives in a struct FIELD named `@@toPrimitive`, exposed only via
//      `__sget_@@toPrimitive`. Nothing probed that, so `_hostToPrimitive` fell
//      through to its `"[object Object]"` sentinel and the host BigInt binop
//      multiplied a *string* by a BigInt → "Cannot mix BigInt and other types".
//
// Shape 3 is what these tests pin, together with the shapes that already worked
// (regression guards) and the cases that must still throw.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/** Run `body` and report the thrown error's constructor name, or `"no-throw"`. */
async function throwsWith(body: string): Promise<string> {
  const exports = await run(`try { ${body} } catch (e) { return (e as any).constructor.name; } return "no-throw";`);
  return exports.test();
}

const TP = "{ [Symbol.toPrimitive]: function () { return 2n; } }";

describe("#3481 — object-literal computed [Symbol.toPrimitive] reduces before a BigInt op", () => {
  // One case per operator the mixed-BigInt arithmetic block routes to
  // `__host_bigint_binop`; each is its own test262 `bigint-wrapped-values.js`
  // file, so a per-operator regression is attributable.
  // [family, operator, right-hand BigInt literal, expected result]
  const cases: [string, string, string, bigint][] = [
    ["multiplication", "*", "2n", 4n],
    ["division", "/", "2n", 1n],
    ["subtraction", "-", "1n", 1n],
    ["modulus", "%", "2n", 0n],
    ["exponentiation", "**", "2n", 4n],
    ["bitwise-and", "&", "3n", 2n],
    ["bitwise-or", "|", "1n", 3n],
    ["bitwise-xor", "^", "3n", 1n],
    ["left-shift", "<<", "1n", 4n],
    ["right-shift", ">>", "1n", 1n],
    ["addition", "+", "1n", 3n],
  ];

  for (const [name, op, rhs, expected] of cases) {
    it(`${name}: (obj) ${op} ${rhs} === ${expected}n`, async () => {
      const exports = await run(`return ${TP} ${op} ${rhs};`);
      expect(exports.test()).toBe(expected);
    });

    it(`${name}: BigInt on the LEFT also reduces the object operand`, async () => {
      // Only the result TYPE is asserted here — several of these operators are
      // non-commutative, so the value differs from the left-hand case. What
      // matters is that no "Cannot mix BigInt and other types" TypeError is
      // raised, i.e. the object was reduced to `2n` before the operator ran.
      const exports = await run(`return typeof (2n ${op} ${TP});`);
      expect(exports.test()).toBe("bigint");
    });
  }

  it("the hint reaches the exotic method (`default` for +, `number` otherwise)", async () => {
    const exports = await run(
      `var seen: any[] = [];
       var o: any = { [Symbol.toPrimitive]: function (h: any) { seen.push(h); return 1n; } };
       var a = o + 1n;
       var b = o * 1n;
       return seen[0] + "," + seen[1];`,
    );
    expect(exports.test()).toBe("default,number");
  });

  it("@@toPrimitive wins over a sibling valueOf (§7.1.1 step 2 precedes OrdinaryToPrimitive)", async () => {
    const exports = await run(
      `var o: any = { [Symbol.toPrimitive]: function () { return 2n; }, valueOf: function () { return 9n; } };
       return o * 2n;`,
    );
    expect(exports.test()).toBe(4n);
  });

  it("a string-hint context calls the same exotic method", async () => {
    const exports = await run(`var o: any = { [Symbol.toPrimitive]: function (h: any) { return "hint:" + h; } };
       return String(o);`);
    expect(exports.test()).toBe("hint:string");
  });
});

describe("#3481 — shapes that already worked keep working", () => {
  it("BigInt wrapper object: Object(2n) * 2n === 4n", async () => {
    const exports = await run(`return Object(2n) * 2n;`);
    expect(exports.test()).toBe(4n);
  });

  it("BigInt wrapper object on the right: 2n * Object(2n) === 4n", async () => {
    const exports = await run(`return 2n * Object(2n);`);
    expect(exports.test()).toBe(4n);
  });

  it("valueOf returning a BigInt", async () => {
    const exports = await run(`return { valueOf: function () { return 2n; } } * 2n;`);
    expect(exports.test()).toBe(4n);
  });

  it("toString returning a BigInt", async () => {
    const exports = await run(`return { toString: function () { return 2n; } } * 2n;`);
    expect(exports.test()).toBe(4n);
  });

  it("@@toPrimitive as a METHOD body still dispatches (#1716 arm)", async () => {
    const exports = await run(`var o: any = { [Symbol.toPrimitive](h: any) { return 2n; } }; return o * 2n;`);
    expect(exports.test()).toBe(4n);
  });

  it("plain bigint arithmetic is untouched", async () => {
    const exports = await run(`return 2n * 2n + 5n - 1n;`);
    expect(exports.test()).toBe(8n);
  });

  it("an object with NO coercion method still reaches the [object Object] sentinel", async () => {
    const exports = await run(`var o: any = { a: 1 }; return "" + o;`);
    expect(exports.test()).toBe("[object Object]");
  });

  it("a genuine mix still throws TypeError", async () => {
    expect(await throwsWith(`var n: any = 5; return n * 2n;`)).toBe("TypeError");
  });
});

describe("#3481 — Symbol / non-callable negatives still throw", () => {
  it("@@toPrimitive returning a Symbol into a numeric context throws TypeError", async () => {
    expect(
      await throwsWith(`var o: any = { [Symbol.toPrimitive]: function () { return Symbol("s"); } }; return o * 2n;`),
    ).toBe("TypeError");
  });

  it("toString returning a Symbol beside BigInt still throws TypeError", async () => {
    expect(await throwsWith(`return { toString: function () { return Symbol("s"); } } * 2n;`)).toBe("TypeError");
  });

  it("@@toPrimitive returning a Symbol into a number coercion throws TypeError", async () => {
    expect(
      await throwsWith(`var o: any = { [Symbol.toPrimitive]: function () { return Symbol("s"); } }; return +o;`),
    ).toBe("TypeError");
  });

  it("a NON-CALLABLE @@toPrimitive throws TypeError (§7.1.1 step 2d)", async () => {
    expect(await throwsWith(`var o: any = { [Symbol.toPrimitive]: 42 }; return o * 2n;`)).toBe("TypeError");
  });

  it("@@toPrimitive returning an object throws TypeError (§7.1.1 step 5)", async () => {
    expect(await throwsWith(`var o: any = { [Symbol.toPrimitive]: function () { return {}; } }; return o * 2n;`)).toBe(
      "TypeError",
    );
  });

  it("a user throw inside @@toPrimitive propagates unchanged", async () => {
    expect(
      await throwsWith(`var o: any = { [Symbol.toPrimitive]: function () { throw new RangeError("boom"); } };
         return o * 2n;`),
    ).toBe("RangeError");
  });
});
