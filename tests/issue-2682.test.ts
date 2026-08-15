// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2682 — string read-loop fast path: hoist the loop-invariant `__str_flatten`
// + `.data`/`.off` descriptor out of the canonical hash loop, and (under the
// in-bounds proof) lower `recv.charCodeAt(i)` to a direct i32 `array.get_u` so
// the whole `(h*31 + c) | 0` chain stays in i32 — no per-iteration flatten, no
// struct.get reload, no OOB/NaN branch, no f64 `|0` emulation.
//
// The optimization is GATED on the canonical loop shape + an in-bounds proof
// (init >= 0, strict `i < recv.length`, monotonic step, `i`/`recv` not mutated,
// no capturing closure). These tests assert (a) byte-faithful results for the
// optimized loops, and (b) that every NON-matching shape is left unoptimized and
// behaviourally unchanged (the #1105 OOB-NaN semantics are preserved).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface Built {
  exports: Record<string, unknown>;
  toNative: (s: string) => unknown;
}

async function compileNative(source: string, opts: Record<string, unknown> = {}): Promise<Built> {
  const r = await compile(source, {
    nativeStrings: true,
    testRuntime: true,
    fileName: "issue-2682.ts",
    ...opts,
  });
  if (!r.success) {
    const errors = Array.isArray(r.errors) ? r.errors.map((err) => err.message).join("; ") : "no errors array";
    throw new Error(`compile failed: ${errors}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  const exports = instance.exports as Record<string, unknown>;
  built.setExports?.(exports as Record<string, Function>);
  return { exports, toNative: exports.__test_str_from_externref as (s: string) => unknown };
}

// Just the WAT of the named function (the recogniser only ever touches one fn).
async function watOf(source: string, fnName: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await compile(source, { nativeStrings: true, emitWat: true, fileName: "issue-2682-wat.ts", ...opts });
  const lines = (r.wat ?? "").split("\n");
  const out: string[] = [];
  let cap = false;
  for (const l of lines) {
    if (l.includes(`(func $${fnName} `)) cap = true;
    if (cap) {
      out.push(l);
      if (out.length > 1 && /^\s*\(func /.test(l) && !l.includes(`$${fnName} `)) {
        out.pop();
        break;
      }
    }
  }
  return out.join("\n");
}

// JS reference for the canonical `(h * 31 + s.charCodeAt(i)) | 0` hash.
function refHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const HASH_SRC = `
  export function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
`;

describe("#2682 canonical string read-loop fast path", () => {
  for (const mode of [
    { tag: "fast+nativeStrings", opts: { fast: true } },
    { tag: "nativeStrings", opts: {} },
  ]) {
    it(`hash result is byte-faithful (${mode.tag})`, async () => {
      const { exports, toNative } = await compileNative(HASH_SRC, mode.opts);
      const hashStr = exports.hashStr as (s: unknown) => number;
      for (const s of ["", "a", "hello world", "The quick brown fox 0123456789!", "héllo ☃ unicode", "z".repeat(300)]) {
        expect(hashStr(toNative(s))).toBe(refHash(s));
      }
    });
  }

  // (#3931) The #3907-era KNOWN CAPABILITY GAP block that used to sit here is
  // gone: the recogniser now lives in the IR front-end too
  // (`src/ir/char-read-loop.ts`), so the hoist fires wherever the IR owns the
  // body — which is these two configurations plus standalone/wasi/host. The
  // shape assertions below therefore pin the IR-EMITTED form, not legacy's.
  // Full per-configuration coverage is in `tests/issue-3931.test.ts`; what is
  // kept here is the pin that this file's own HASH_SRC is optimised.
  it("(#3931) the read loop is IR-owned AND hoisted", async () => {
    for (const opts of [{ fast: true }, {}]) {
      const wat = await watOf(HASH_SRC, "hashStr", opts);
      // IR owns the body (its locals are `$$irN`) …
      expect(wat).toMatch(/\$\$ir\d/);
      // … and the flatten is hoisted into a preheader slot, so the loop body
      // reads code units straight out of the flat descriptor.
      expect(wat).toContain("$$slot___cca_flat");
      expect(wat).toContain("array.get_u");
      // The §22.1.3.3 NaN arm is proven dead — no f64 NaN sentinel survives.
      expect(wat).not.toContain("f64.const nan");
    }
  });

  it("a non-negative literal init and `i += 2` step still optimise (and stay correct)", async () => {
    const src = `
      export function hashStep(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i += 2) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const { exports, toNative } = await compileNative(src, { fast: true });
    const hashStep = exports.hashStep as (s: unknown) => number;
    const ref = (str: string) => {
      let h = 0;
      for (let i = 0; i < str.length; i += 2) h = (h * 31 + str.charCodeAt(i)) | 0;
      return h;
    };
    for (const s of ["abcdefgh", "x", "", "abcdefghijklmnop"]) expect(hashStep(toNative(s))).toBe(ref(s));
    // (#3931) Shape pin re-pointed to the IR hoist. The RESULT assertions on
    // the line above are the soundness guarantee and are unchanged.
    expect(await watOf(src, "hashStep", { fast: true })).toContain("$$slot___cca_flat");
  });

  it("multiple charCodeAt(i) reads share a single hoist", async () => {
    const src = `
      export function h2(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i) + s.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const { exports, toNative } = await compileNative(src, { fast: true });
    const h2 = exports.h2 as (s: unknown) => number;
    const ref = (str: string) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i) + str.charCodeAt(i)) | 0;
      return h;
    };
    for (const s of ["abcd", "", "hello"]) expect(h2(toNative(s))).toBe(ref(s));
    // (#3931) Two reads, ONE hoist: the slot is declared once, so the flatten
    // runs once per loop entry no matter how many reads the body carries.
    const wat = await watOf(src, "h2", { fast: true });
    expect((wat.match(/\(local \$\$slot___cca_flat /g) ?? []).length).toBe(1);
    expect((wat.match(/array\.get_u/g) ?? []).length).toBe(2);
  });
});

describe("#2682 soundness — non-matching shapes are left unoptimised and unchanged", () => {
  // Outside a recognised loop, charCodeAt keeps its OOB-NaN semantics (#1105):
  // `(a + s.charCodeAt(OOB)) | 0` poisons to 0, NOT to `a`.
  it("OOB charCodeAt outside a loop still poisons `(a + c) | 0` to 0 (nativeStrings, exact f64)", async () => {
    const src = `export function oob(): number { const s = "ab"; return (100 + s.charCodeAt(50)) | 0; }`;
    const { exports } = await compileNative(src); // non-fast: exact spec f64 semantics
    expect((exports.oob as () => number)()).toBe(0);
    // and it is NOT optimised (no hoist locals).
    expect(await watOf(src, "oob")).not.toContain("__cca_");
  });

  it("a non-induction index `charCodeAt(i + 1)` is NOT optimised and stays correct", async () => {
    const src = `
      export function nh(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i + 1)) | 0;
        return h;
      }
    `;
    const { exports, toNative } = await compileNative(src); // non-fast for exact NaN semantics
    const nh = exports.nh as (s: unknown) => number;
    const ref = (str: string) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i + 1)) | 0;
      return h;
    };
    for (const s of ["abc", "abcde", "a"]) expect(nh(toNative(s))).toBe(ref(s));
    expect(await watOf(src, "nh")).not.toContain("__cca_");
  });

  it("a reassigned receiver inside the loop is NOT optimised and stays correct", async () => {
    const src = `
      export function rr(): number {
        let h = 0;
        let s = "abcd";
        for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; if (i === 1) s = "xy"; }
        return h;
      }
    `;
    const { exports } = await compileNative(src);
    const ref = () => {
      let h = 0;
      let s = "abcd";
      for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
        if (i === 1) s = "xy";
      }
      return h;
    };
    expect((exports.rr as () => number)()).toBe(ref());
    expect(await watOf(src, "rr")).not.toContain("__cca_");
  });

  it("a body that SHADOWS the receiver name is NOT optimised (text-keyed match stays sound)", async () => {
    // Inner `s` shadows the loop receiver; `s.charCodeAt(i)` must read the INNER
    // string, never the hoisted outer descriptor.
    const src = `
      export function sh(): number {
        let h = 0;
        const s = "abcdef";
        for (let i = 0; i < s.length; i++) { const s = "ZZ"; h = (h * 31 + s.charCodeAt(i % 2)) | 0; }
        return h;
      }
    `;
    const { exports } = await compileNative(src);
    const ref = () => {
      let h = 0;
      const s = "abcdef";
      for (let i = 0; i < s.length; i++) {
        const s = "ZZ";
        h = (h * 31 + s.charCodeAt(i % 2)) | 0;
      }
      return h;
    };
    expect((exports.sh as () => number)()).toBe(ref());
    expect(await watOf(src, "sh")).not.toContain("__cca_");
  });

  it("a ConsString receiver flattens correctly once-hoisted", async () => {
    // `a + b` is a ConsString (rope); the hoisted `__str_flatten` must still
    // produce the correct flat code units.
    const src = `
      export function hc(a: string, b: string): number {
        const s = a + b;
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const { exports, toNative } = await compileNative(src, { fast: true });
    const hc = exports.hc as (a: unknown, b: unknown) => number;
    const ref = (a: string, b: string) => {
      const s = a + b;
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    };
    for (const [a, b] of [
      ["foo", "bar"],
      ["", "x"],
      ["hello ", "world"],
    ] as const) {
      expect(hc(toNative(a), toNative(b))).toBe(ref(a, b));
    }
    // (#3931) This IS a matching shape, so the hoist fires — and the point of
    // the case is that hoisting the flatten is what makes it correct: the rope
    // is flattened ONCE, before the loop, and every read then indexes the flat
    // code units. The result assertions above are the soundness guarantee.
    expect(await watOf(src, "hc", { fast: true })).toContain("$$slot___cca_flat");
  });

  it("a `.length` bound on a DIFFERENT string than the charCodeAt receiver is not mis-optimised", async () => {
    // Condition bounds `i` by `a.length`, but the read is `b.charCodeAt(i)` — `b`
    // is NOT proven in-bounds, so it must keep the guarded (NaN) lowering.
    const src = `
      export function bm(a: string, b: string): number {
        let h = 0;
        for (let i = 0; i < a.length; i++) h = (h * 31 + b.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const { exports, toNative } = await compileNative(src); // non-fast: exact NaN semantics
    const bm = exports.bm as (a: unknown, b: unknown) => number;
    const ref = (a: string, b: string) => {
      let h = 0;
      for (let i = 0; i < a.length; i++) h = (h * 31 + b.charCodeAt(i)) | 0;
      return h;
    };
    // a longer than b => b.charCodeAt(i) is OOB on the tail => NaN-poisons to 0.
    for (const [a, b] of [
      ["abcdef", "xy"],
      ["ab", "wxyz"],
    ] as const) {
      expect(bm(toNative(a), toNative(b))).toBe(ref(a, b));
    }
    // `b` is not the bound receiver, so `b.charCodeAt(i)` stays unoptimised.
    expect(await watOf(src, "bm")).not.toContain("__cca_");
  });

  it("a body that mutates the induction var is NOT optimised and stays correct", async () => {
    const src = `
      export function mi(): number {
        let h = 0;
        const s = "abcdef";
        for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; i++; }
        return h;
      }
    `;
    const { exports } = await compileNative(src);
    const ref = () => {
      let h = 0;
      const s = "abcdef";
      for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
        i++;
      }
      return h;
    };
    expect((exports.mi as () => number)()).toBe(ref());
    expect(await watOf(src, "mi")).not.toContain("__cca_");
  });
});
