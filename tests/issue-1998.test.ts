import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1998: Array.prototype.join over non-numeric / any-typed element vecs trapped
// "illegal cast" because the raw element flowed straight into wasm:js-string
// `concat`, which requires string operands. Each element must be stringified
// first (§23.1.3.18): `undefined`/`null` (and array holes) → "", everything
// else → ToString. A genuine NaN still renders "NaN".
//
// #1997: Array.prototype.toString() (§23.1.3.36) delegates to join with the
// default "," separator; previously it fell through to the generic object
// dispatch and produced "[object Array]".

async function evalStr(expr: string): Promise<unknown> {
  const exports = await compileToWasm(`export function test(): string { return ${expr}; }`);
  return (exports as { test: () => unknown }).test();
}

describe("#1998 Array.prototype.join element coercion", () => {
  it("joins an any-typed numeric array (was: illegal cast)", async () => {
    expect(await evalStr(`([10,9] as any[]).join(",")`)).toBe("10,9");
  });

  it("renders undefined elements as the empty string", async () => {
    expect(await evalStr(`[1,undefined,2].join("-")`)).toBe("1--2");
  });

  it("renders null elements as the empty string", async () => {
    expect(await evalStr(`[1,null,2].join("-")`)).toBe("1--2");
  });

  it("renders array holes as the empty string", async () => {
    expect(await evalStr(`[1,,3].join(",")`)).toBe("1,,3");
  });

  it('renders a genuine NaN element as "NaN", not empty', async () => {
    expect(await evalStr(`[1,NaN,2].join("-")`)).toBe("1-NaN-2");
  });

  it("does not regress numeric joins", async () => {
    expect(await evalStr(`[1,2,3].join("-")`)).toBe("1-2-3");
    expect(await evalStr(`[0,0,0].join(",")`)).toBe("0,0,0");
    expect(await evalStr(`[1.5,2.25].join("|")`)).toBe("1.5|2.25");
  });

  it("does not regress string joins", async () => {
    expect(await evalStr(`["a","b"].join("-")`)).toBe("a-b");
  });

  it('uses the default "," separator when join is called with no argument', async () => {
    expect(await evalStr(`[1,2,3].join()`)).toBe("1,2,3");
  });

  it("joins an empty array to the empty string", async () => {
    expect(await evalStr(`[].join(",")`)).toBe("");
  });
});

describe("#1997 Array.prototype.toString", () => {
  it('returns the comma-joined elements, not "[object Array]"', async () => {
    expect(await evalStr(`[1,2,3].toString()`)).toBe("1,2,3");
    expect(await evalStr(`["a","b"].toString()`)).toBe("a,b");
  });

  it("recurses into nested arrays", async () => {
    expect(await evalStr(`([[1,2],[3]] as any[]).toString()`)).toBe("1,2,3");
    expect(await evalStr(`[[1,2],[3,4]].join(";")`)).toBe("1,2;3,4");
  });

  it("renders undefined / hole elements as empty", async () => {
    expect(await evalStr(`[1,undefined,2].toString()`)).toBe("1,,2");
  });

  it("returns the empty string for an empty array", async () => {
    expect(await evalStr(`[].toString()`)).toBe("");
  });

  it('renders a genuine NaN element as "NaN"', async () => {
    expect(await evalStr(`[1,NaN,2].toString()`)).toBe("1,NaN,2");
  });
});
