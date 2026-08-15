// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3931 — the #2682 canonical char-read-loop recogniser, ported into the IR
// front-end (`src/ir/char-read-loop.ts`).
//
// Legacy's `detectCanonicalCharReadLoop` only ever ran on the AST path, and the
// IR overlay had taken ownership of these bodies everywhere except one
// configuration, so the hoist had been dead for `nativeStrings`, `standalone`
// and `wasi` since before #3907 (which closed the last accidental pocket). What
// is asserted here:
//
//   (a) the hoist FIRES under the IR front-end in every configuration —
//       fast+nativeStrings, plain nativeStrings, standalone, wasi, and host
//       (host has no flattenable descriptor, so there it is the guard that is
//       dropped, not a flatten that is hoisted);
//   (b) results stay byte-faithful against the JS reference, including the
//       shapes where the hoist is what makes them non-trivial (rope receiver,
//       substring view with a non-zero offset, high code units);
//   (c) every non-matching shape keeps the guarded §22.1.3.3 lowering.
//
// The performance claim behind (a) — the reason the port exists — is measured
// separately; the emitted-shape assertions here are its proxy: no per-iteration
// flatten, no bounds/NaN branch, and the `(h * 31 + c) | 0` chain composed in
// native i32 rather than the f64 ToInt32 bit-decomposition (`i64.*`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const HASH_SRC = `
  export function hashStr(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }
`;

function refHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Every configuration the issue's acceptance criteria name. */
const CONFIGURATIONS: Array<{ tag: string; opts: Record<string, unknown>; native: boolean }> = [
  { tag: "fast+nativeStrings", opts: { fast: true, nativeStrings: true }, native: true },
  { tag: "nativeStrings", opts: { nativeStrings: true }, native: true },
  { tag: "standalone", opts: { target: "standalone" }, native: true },
  { tag: "wasi", opts: { target: "wasi" }, native: true },
  { tag: "host", opts: {}, native: false },
];

/** The WAT of one named function (the recogniser only ever touches one fn). */
async function watOf(source: string, fnName: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await compile(source, { emitWat: true, fileName: "issue-3931-wat.ts", ...opts });
  if (!r.success) {
    const errors = Array.isArray(r.errors) ? r.errors.map((err) => err.message).join("; ") : "no errors array";
    throw new Error(`compile failed: ${errors}`);
  }
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

interface Built {
  exports: Record<string, unknown>;
  toNative: (s: string) => unknown;
}

async function buildNative(source: string, opts: Record<string, unknown> = {}): Promise<Built> {
  const r = await compile(source, { nativeStrings: true, testRuntime: true, fileName: "issue-3931.ts", ...opts });
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

describe("#3931 the char-read-loop hoist fires under the IR front-end", () => {
  for (const config of CONFIGURATIONS) {
    it(`fires for ${config.tag}`, async () => {
      const wat = await watOf(HASH_SRC, "hashStr", config.opts);
      // The IR owns the body — that is the precondition the whole issue is
      // about, and it is what made the legacy recogniser unreachable here.
      expect(wat).toMatch(/\$\$ir\d/);
      if (config.native) {
        // Native strings: the flatten is hoisted into a preheader slot and the
        // body reads code units straight out of the flat descriptor.
        expect(wat).toContain("$$slot___cca_flat");
        expect(wat).toContain("array.get_u");
      } else {
        // Host strings: nothing to flatten, so the win is the dropped guard —
        // one bare builtin call per read, no `length` re-read to bound it.
        expect(wat).not.toContain("$$slot___cca_flat");
      }
      // Both: the §22.1.3.3 NaN arm is proven dead …
      expect(wat).not.toContain("f64.const nan");
      // … and `(h * 31 + c) | 0` now composes in native i32 instead of the
      // f64 ToInt32 bit-decomposition, which is where the time actually went.
      expect(wat).toContain("i32.mul");
      expect(wat).not.toContain("i64.");
    });
  }

  it("hash results stay byte-faithful in every runnable configuration", async () => {
    const subjects = [
      "",
      "a",
      "hello world",
      "The quick brown fox 0123456789!",
      "héllo ☃ unicode",
      "￿￾�", // high code units — the read is unsigned
      "z".repeat(300),
    ];
    // standalone/wasi take no host-string argument, so they are covered by the
    // shape assertions above plus the standalone case further down.
    for (const opts of [{ fast: true }, {}] as Array<Record<string, unknown>>) {
      const { exports, toNative } = await buildNative(HASH_SRC, opts);
      const hashStr = exports.hashStr as (s: unknown) => number;
      for (const s of subjects) expect(hashStr(toNative(s))).toBe(refHash(s));
    }
  });

  it("host mode: hash results stay byte-faithful", async () => {
    const r = await compile(HASH_SRC, { testRuntime: true, fileName: "issue-3931-host.ts" });
    expect(r.success).toBe(true);
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    const exports = instance.exports as Record<string, unknown>;
    built.setExports?.(exports as Record<string, Function>);
    const hashStr = exports.hashStr as (s: string) => number;
    for (const s of ["", "a", "hello world", "héllo ☃", "￿￾"]) expect(hashStr(s)).toBe(refHash(s));
  });
});

describe("#3931 the hoisted read stays byte-faithful on the hard receivers", () => {
  it("a substring view (non-zero `.off`) reads the right code units", async () => {
    // The flat descriptor of a substring carries an offset; a hoist that
    // dropped it would silently read from the start of the backing array.
    const src = `
      export function sub(s: string): number {
        const t = s.substring(2);
        let h = 0;
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const ref = (s: string) => refHash(s.substring(2));
    for (const opts of [{ fast: true }, {}] as Array<Record<string, unknown>>) {
      const { exports, toNative } = await buildNative(src, opts);
      const sub = exports.sub as (s: unknown) => number;
      for (const s of ["abcdef", "ab", "", "héllo ☃ x"]) expect(sub(toNative(s))).toBe(ref(s));
    }
  });

  it("nested loops over two receivers keep both proofs", async () => {
    const src = `
      export function nest(a: string, b: string): number {
        let h = 0;
        for (let i = 0; i < a.length; i++) {
          for (let j = 0; j < b.length; j++) h = (h * 31 + a.charCodeAt(i) + b.charCodeAt(j)) | 0;
        }
        return h;
      }
    `;
    const ref = (a: string, b: string) => {
      let h = 0;
      for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) h = (h * 31 + a.charCodeAt(i) + b.charCodeAt(j)) | 0;
      }
      return h;
    };
    const { exports, toNative } = await buildNative(src, { fast: true });
    const nest = exports.nest as (a: unknown, b: unknown) => number;
    for (const [a, b] of [
      ["abc", "xy"],
      ["", "q"],
      ["zz", ""],
    ] as const) {
      expect(nest(toNative(a), toNative(b))).toBe(ref(a, b));
    }
    // The OUTER receiver's read is still hoisted from inside the inner loop:
    // the inner loop cannot invalidate `0 <= i < a.length`.
    const wat = await watOf(src, "nest", { nativeStrings: true });
    expect((wat.match(/\(local \$\$slot___cca_flat /g) ?? []).length).toBe(2);
  });

  it("a `break` out of the loop does not observe a partial hoist", async () => {
    const src = `
      export function brk(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++) { if (i === 3) break; h = (h * 31 + s.charCodeAt(i)) | 0; }
        return h;
      }
    `;
    const ref = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        if (i === 3) break;
        h = (h * 31 + s.charCodeAt(i)) | 0;
      }
      return h;
    };
    const { exports, toNative } = await buildNative(src, { fast: true });
    const brk = exports.brk as (s: unknown) => number;
    for (const s of ["abcdefgh", "ab", ""]) expect(brk(toNative(s))).toBe(ref(s));
  });

  it("a non-bitwise consumer takes the widened read and stays exact", async () => {
    // No `| 0` — the read is still unguarded, but its i32 code unit is widened
    // back to the f64 every ordinary charCodeAt consumer expects.
    const src = `
      export function sum(s: string): number {
        let acc = 0;
        for (let i = 0; i < s.length; i++) acc = acc + s.charCodeAt(i);
        return acc;
      }
    `;
    const ref = (s: string) => {
      let acc = 0;
      for (let i = 0; i < s.length; i++) acc = acc + s.charCodeAt(i);
      return acc;
    };
    const { exports, toNative } = await buildNative(src);
    const sum = exports.sum as (s: unknown) => number;
    for (const s of ["abc", "", "￿😀", "héllo ☃"]) expect(sum(toNative(s))).toBe(ref(s));
  });

  it("an `i += 3` step and a non-zero init stay correct", async () => {
    const src = `
      export function st(s: string): number {
        let h = 7;
        for (let i = 2; i < s.length; i += 3) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h;
      }
    `;
    const ref = (s: string) => {
      let h = 7;
      for (let i = 2; i < s.length; i += 3) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    };
    const { exports, toNative } = await buildNative(src, { fast: true });
    const st = exports.st as (s: unknown) => number;
    for (const s of ["￿￾Xabc", "ab", "", "abcdefghij"]) expect(st(toNative(s))).toBe(ref(s));
  });
});

describe("#3931 standalone/wasi: the configurations the gap had been costing", () => {
  // These lanes take no host-string argument, so the workload builds its own
  // subject inside Wasm and returns a number. This is also the shape the
  // before/after measurement in the issue uses.
  const SRC = `
    function mk(): string {
      let s = "The quick brown fox 0123456789 ";
      return s + "";
    }
    export function bench(chunks: number): number {
      let text = mk();
      for (let c = 1; c < chunks; c++) text = text + mk();
      const s = text;
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    }
  `;
  const ref = (chunks: number) => refHash("The quick brown fox 0123456789 ".repeat(chunks));

  for (const target of ["standalone", "wasi"] as const) {
    it(`${target}: the loop is IR-owned, hoisted, and byte-faithful`, async () => {
      const wat = await watOf(SRC, "bench", { target });
      expect(wat).toMatch(/\$\$ir\d/);
      expect(wat).toContain("$$slot___cca_flat");
      expect(wat).not.toContain("i64.");

      const r = await compile(SRC, { target, testRuntime: true, fileName: "issue-3931-standalone.ts" });
      expect(r.success).toBe(true);
      const built = buildImports(r.imports, ENV_STUB, r.stringPool);
      const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
      const exports = instance.exports as Record<string, unknown>;
      built.setExports?.(exports as Record<string, Function>);
      const bench = exports.bench as (chunks: number) => number;
      for (const chunks of [1, 2, 7]) expect(bench(chunks)).toBe(ref(chunks));
    });
  }
});

describe("#3931 non-matching shapes keep the guarded lowering", () => {
  const NEGATIVE: Array<{ name: string; fn: string; src: string; ref: (...a: string[]) => number; args: string[][] }> =
    [
      {
        name: "a `<=` bound admits `i === length` and is refused",
        fn: "le",
        src: `
        export function le(s: string): number {
          let h = 0;
          for (let i = 0; i <= s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
          return h;
        }`,
        ref: (s: string) => {
          let h = 0;
          for (let i = 0; i <= s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
          return h;
        },
        args: [["abc"], [""], ["x"]],
      },
      {
        name: "a negative init is refused (the lower bound is what the proof needs)",
        fn: "neg",
        src: `
        export function neg(s: string): number {
          let h = 0;
          for (let i = -1; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
          return h;
        }`,
        ref: (s: string) => {
          let h = 0;
          for (let i = -1; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
          return h;
        },
        args: [["abc"], [""], ["x"]],
      },
      {
        name: "a bound on a DIFFERENT receiver is refused",
        fn: "bm",
        src: `
        export function bm(a: string, b: string): number {
          let h = 0;
          for (let i = 0; i < a.length; i++) h = (h * 31 + b.charCodeAt(i)) | 0;
          return h;
        }`,
        ref: (a: string, b: string) => {
          let h = 0;
          for (let i = 0; i < a.length; i++) h = (h * 31 + b.charCodeAt(i)) | 0;
          return h;
        },
        args: [
          ["abcdef", "xy"],
          ["ab", "wxyz"],
        ],
      },
      {
        name: "a non-induction index `charCodeAt(i + 1)` is refused",
        fn: "nh",
        src: `
        export function nh(s: string): number {
          let h = 0;
          for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i + 1)) | 0;
          return h;
        }`,
        ref: (s: string) => {
          let h = 0;
          for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i + 1)) | 0;
          return h;
        },
        args: [["abc"], ["abcde"], ["a"]],
      },
    ];

  for (const negative of NEGATIVE) {
    it(negative.name, async () => {
      // Non-fast, so the §22.1.3.3 NaN result keeps its exact f64 semantics.
      const { exports, toNative } = await buildNative(negative.src);
      const fn = exports[negative.fn] as (...a: unknown[]) => number;
      for (const args of negative.args) {
        expect(fn(...args.map((s) => toNative(s)))).toBe(negative.ref(...args));
      }
      // …and no hoist was installed for it.
      expect(await watOf(negative.src, negative.fn, { nativeStrings: true })).not.toContain("__cca_");
    });
  }

  it("a nested function in the body is refused (it could capture and reassign)", async () => {
    // Conservative and deliberately shape-based, exactly like legacy's own
    // predicate: ANY nested function/arrow/class in the body disqualifies the
    // loop, even one that captures nothing.
    const src = `
      export function cap(s: string): number {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
          const bump = (x: number): number => { return x + 1; };
          h = (h * 31 + bump(s.charCodeAt(i))) | 0;
        }
        return h;
      }
    `;
    const wat = await watOf(src, "cap", { nativeStrings: true });
    expect(wat).not.toContain("__cca_");
  });
});
