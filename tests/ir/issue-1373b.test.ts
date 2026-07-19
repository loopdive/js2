// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1373b Slice 1a — IR async Phase C scaffolding (plumbing only).
//
// Scope of this PR:
//   1. New `CodegenContext.supportsAsyncIr: boolean` field, initialised
//      `false` by `createContext`. Reserved for Slice 1b to flip on when
//      the FULFILLED / REJECTED fast-path lowering lands.
//   2. New `IrSelectionOptions.supportsAsyncIr?: boolean` plumbing.
//   3. New `isAsyncIrReady(options, fn)` selector helper — the single
//      source of truth for whether a given async function can flow
//      through the IR's CPS lowering. Slice 1a hardcodes `false`;
//      Slice 1b will swap in the real body-shape check.
//
// Out of scope (follow-ups):
//   - Slice 1b: FULFILLED/REJECTED fast-path lowering in `src/ir/lower.ts`,
//     `IrInstrAwait`/`IrInstrAsyncReturn`/`IrInstrAsyncThrow` emission in
//     `src/ir/from-ast.ts`. See architect spec
//     `plan/issues/sprints/52/1373b-ir-async-cps-lowering.md`.
//   - Slice 2: PENDING-path CPS continuation synthesis (blocked on
//     #1326c Phase 1C-B).
//   - Slice 3: gate-flip.
//
// Even with the flag set, the selector still returns the `"async-function"`
// fallback for now — the `isAsyncIrReady` body returns `false` unconditionally
// at this slice's checkpoint. Tests below pin both behaviours so any
// regression that accidentally claims an async function before the lowering
// is ready surfaces immediately.

import { describe, expect, it } from "vitest";
import { ts } from "../../src/ts-api.js";
import { isAsyncIrReady, planIrCompilation } from "../../src/ir/select.js";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

function parseSource(src: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", src, ts.ScriptTarget.ES2022, true);
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
  }
  return undefined;
}

describe("#1373b Slice 1a — async-IR scaffolding (plumbing only)", () => {
  describe("isAsyncIrReady() gate", () => {
    it("returns false when supportsAsyncIr is undefined", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const fn = findFunction(sf, "f")!;
      expect(isAsyncIrReady(undefined, fn)).toBe(false);
    });

    it("returns false when supportsAsyncIr is explicitly false", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const fn = findFunction(sf, "f")!;
      expect(isAsyncIrReady({ supportsAsyncIr: false }, fn)).toBe(false);
    });

    it("returns false even when supportsAsyncIr is true (Slice 1a — gate still closed)", () => {
      // This is the deliberate scaffolding behaviour: the flag exists and
      // is threaded through, but the gate body returns `false` so no async
      // function actually flows through the IR until Slice 1b ships the
      // FULFILLED/REJECTED fast-path lowering.
      const sf = parseSource(`async function f() { return 1; }`);
      const fn = findFunction(sf, "f")!;
      expect(isAsyncIrReady({ supportsAsyncIr: true }, fn)).toBe(false);
    });

    it("returns false for an arbitrary async function shape", () => {
      const sf = parseSource(`async function g(x: number) { return await Promise.resolve(x); }`);
      const fn = findFunction(sf, "g")!;
      expect(isAsyncIrReady({ supportsAsyncIr: true }, fn)).toBe(false);
    });
  });

  describe("selector unchanged from #1373 Phase A", () => {
    it("async function lands in async-function fallback (gate closed)", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
        supportsAsyncIr: true, // even with the new flag set, the bucket is unchanged
      });
      const fb = sel.fallbacks?.find((f) => f.name === "f");
      expect(fb?.reason).toBe("async-function");
    });

    it("async function lands in async-function fallback (flag absent — back-compat)", () => {
      const sf = parseSource(`async function f() { return 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
      });
      const fb = sel.fallbacks?.find((f) => f.name === "f");
      expect(fb?.reason).toBe("async-function");
    });

    it("async generator still lands in async-generator (separate bucket)", () => {
      const sf = parseSource(`async function* g() { yield 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
        supportsAsyncIr: true,
      });
      const fb = sel.fallbacks?.find((f) => f.name === "g");
      // The async-generator bucket is intentionally not affected by the
      // async-function gate — async generators stay deferred.
      expect(fb?.reason).toBe("async-generator");
    });

    it("plain (non-async) function still IR-claimable", () => {
      const sf = parseSource(`export function f(): number { return 1; }`);
      const sel = planIrCompilation(sf, {
        experimentalIR: true,
        trackFallbacks: true,
        supportsAsyncIr: true,
      });
      const fb = sel.fallbacks?.find((f) => f.name === "f");
      expect(fb).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// #1373b C-1 — sync-pass-through async claim (ONE-engine consistency gate)
//
// The IR claims an async function DECLARATION iff:
//   - supportsAsyncIr is on, AND
//   - the converged async engine DECLINES it (`asyncEngineClaims(fn)===false`
//     — the legacy synchronous pass-through population), AND
//   - it has an explicit `Promise<T>` annotation (raw-`T` sync signature), AND
//   - the body passes the normal Phase-1 shape checks (await accepted via the
//     isPhase1Expr arm; for-await / nested async fn-likes excluded).
//
// Engine-activated (genuinely suspending) functions are NEVER IR-claimed —
// their routing must stay byte-identical.
// ---------------------------------------------------------------------------

// biome disallows static `delete process.env.X`; the computed-member form via a
// const key is the repo pattern (cf. tests/issue-2973.test.ts).
const IR_ASYNC_GATE = "JS2WASM_IR_ASYNC";

const GATE_OPEN = {
  experimentalIR: true,
  trackFallbacks: true,
  supportsAsyncIr: true,
  asyncEngineClaims: () => false, // stub: engine declines everything
} as const;

async function instantiateHost(r: Awaited<ReturnType<typeof compile>>): Promise<Record<string, Function>> {
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const built = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1373b C-1 — isAsyncIrReady (engine-consistency gate)", () => {
  it("claims an annotated async declaration when the engine declines it", () => {
    const sf = parseSource(`async function f(): Promise<number> { return await Promise.resolve(41) + 1; }`);
    const fn = findFunction(sf, "f")!;
    expect(isAsyncIrReady({ supportsAsyncIr: true, asyncEngineClaims: () => false }, fn)).toBe(true);
  });

  it("NEVER claims when the engine would activate (byte-identical engine routing)", () => {
    const sf = parseSource(`async function f(): Promise<number> { return await Promise.resolve(41) + 1; }`);
    const fn = findFunction(sf, "f")!;
    expect(isAsyncIrReady({ supportsAsyncIr: true, asyncEngineClaims: () => true }, fn)).toBe(false);
  });

  it("declines without an engine binding (safe default for bare selector callers)", () => {
    const sf = parseSource(`async function f(): Promise<number> { return 1; }`);
    const fn = findFunction(sf, "f")!;
    expect(isAsyncIrReady({ supportsAsyncIr: true }, fn)).toBe(false);
  });

  it("declines a body containing `for await` (engine 3b/3dii lanes own it)", () => {
    const sf = parseSource(
      `async function f(): Promise<number> { let s: number = 0; for await (const x of [1, 2]) { s = s + x; } return s; }`,
    );
    const fn = findFunction(sf, "f")!;
    expect(isAsyncIrReady({ supportsAsyncIr: true, asyncEngineClaims: () => false }, fn)).toBe(false);
  });

  it("declines a body containing a nested async arrow (closure-lift has no async arm)", () => {
    const sf = parseSource(
      `async function f(): Promise<number> { const g = async () => 1; return await Promise.resolve(2); }`,
    );
    const fn = findFunction(sf, "f")!;
    expect(isAsyncIrReady({ supportsAsyncIr: true, asyncEngineClaims: () => false }, fn)).toBe(false);
  });
});

describe("#1373b C-1 — selector claims the sync-pass-through population", () => {
  it("claims the annotated await-elidable async fn (settled-substitution shape)", () => {
    const sf = parseSource(`async function f(): Promise<number> { return await Promise.resolve(41) + 1; }`);
    const sel = planIrCompilation(sf, GATE_OPEN);
    expect(sel.fallbacks?.find((f) => f.name === "f")).toBeUndefined();
    expect(sel.funcs.has("f")).toBe(true);
  });

  it("claims a multi-statement async body with an awaited local", () => {
    const sf = parseSource(
      `async function f(): Promise<number> { const x: number = await Promise.resolve(20); return x * 2 + 2; }`,
    );
    const sel = planIrCompilation(sf, GATE_OPEN);
    expect(sel.funcs.has("f")).toBe(true);
  });

  it("rejects an UNANNOTATED async fn (C-1 requires the explicit Promise<T>)", () => {
    const sf = parseSource(`async function f() { return await Promise.resolve(1); }`);
    const sel = planIrCompilation(sf, GATE_OPEN);
    expect(sel.fallbacks?.find((f) => f.name === "f")?.reason).toBe("return-type-not-resolvable");
  });

  it("keeps the async-function bucket when the engine claims the fn", () => {
    const sf = parseSource(`async function f(): Promise<number> { return await Promise.resolve(41) + 1; }`);
    const sel = planIrCompilation(sf, { ...GATE_OPEN, asyncEngineClaims: () => true });
    expect(sel.fallbacks?.find((f) => f.name === "f")?.reason).toBe("async-function");
  });

  it("keeps async METHODS in the async-function bucket (C-1 is declarations-only)", () => {
    const sf = parseSource(`class C { async m(): Promise<number> { return 1; } }`);
    const sel = planIrCompilation(sf, GATE_OPEN);
    // The method must not be claimed as a classMember.
    expect([...(sel.classMembers ?? [])].some((n) => n.includes("m"))).toBe(false);
  });

  it("await of the zero-arg Promise.resolve() (undefined settle) rejects the body", () => {
    const sf = parseSource(`async function f(): Promise<number> { return (await Promise.resolve()) as any; }`);
    const sel = planIrCompilation(sf, GATE_OPEN);
    expect(sel.funcs.has("f")).toBe(false);
  });
});

describe("#1373b C-1 — full compile parity (JS-host gc lane)", () => {
  // The C-1 split, verified empirically:
  //   - `base` (await-elidable: `await Promise.resolve(20)` is statically
  //     resolved) → engine DECLINES (no real suspension) → IR claims it.
  //   - `twice` (`const x = await base()` — a call operand is NOT statically
  //     resolved) → engine HOST-DRIVES it → IR must decline; its export
  //     returns a real host Promise on both gate settings.
  const src = `
    async function base(): Promise<number> {
      return await Promise.resolve(20) + 1;
    }
    export async function twice(): Promise<number> {
      const x: number = await base();
      return x * 2;
    }
  `;

  it("claims only the engine-declined fn; the engine keeps the suspending one; value parity via await", async () => {
    const r = await compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(r.irCompiledFuncs ?? []).toContain("base");
    // twice genuinely suspends → host-drive engine owns it, never the IR.
    expect(r.irCompiledFuncs ?? []).not.toContain("twice");
    const ex = await instantiateHost(r);
    // Engine-driven export returns a real Promise; await normalizes.
    expect(await (ex.twice as () => Promise<number>)()).toBe(42);
  });

  it("JS2WASM_IR_ASYNC=0 rolls back to legacy routing with the same runtime value (parity)", async () => {
    process.env[IR_ASYNC_GATE] = "0";
    try {
      const r = await compile(src, { fileName: "test.ts" });
      expect(r.success).toBe(true);
      expect(r.irCompiledFuncs ?? []).not.toContain("base");
      expect(r.irCompiledFuncs ?? []).not.toContain("twice");
      const ex = await instantiateHost(r);
      expect(await (ex.twice as () => Promise<number>)()).toBe(42);
    } finally {
      delete process.env[IR_ASYNC_GATE];
    }
  });

  it("an IR-claimed exported async fn produces the same raw-T value as its legacy sync compile", async () => {
    const rootSrc = `
      export async function f(): Promise<number> {
        return await Promise.resolve(41) + 1;
      }
    `;
    const on = await compile(rootSrc, { fileName: "test.ts" });
    expect(on.success).toBe(true);
    expect(on.irCompiledFuncs ?? []).toContain("f");
    const exOn = await instantiateHost(on);
    // Sync-pass-through model on BOTH paths: raw T from the export; await
    // normalizes either way.
    const vOn = await (exOn.f as () => number | Promise<number>)();
    process.env[IR_ASYNC_GATE] = "0";
    let off: Awaited<ReturnType<typeof compile>>;
    try {
      off = await compile(rootSrc, { fileName: "test.ts" });
    } finally {
      delete process.env[IR_ASYNC_GATE];
    }
    expect(off.success).toBe(true);
    expect(off.irCompiledFuncs ?? []).not.toContain("f");
    const exOff = await instantiateHost(off);
    const vOff = await (exOff.f as () => number | Promise<number>)();
    expect(vOn).toBe(42);
    expect(vOff).toBe(42);
  });

  it("a value-consumer caller (f() as unknown as number) is not claimable; behavior parity holds", async () => {
    const consumerSrc = `
      async function f(): Promise<number> {
        return await Promise.resolve(41) + 1;
      }
      export function main(): number {
        return f() as unknown as number;
      }
    `;
    const on = await compile(consumerSrc, { fileName: "test.ts" });
    expect(on.success).toBe(true);
    // main contains an as-cast (not a Phase-1 expression) → legacy; f may be
    // claimed (signature-preserving), but main's legacy call site still gets
    // the raw T either way.
    expect(on.irCompiledFuncs ?? []).not.toContain("main");
    const exOn = await instantiateHost(on);
    const vOn = (exOn.main as () => number)();
    process.env[IR_ASYNC_GATE] = "0";
    let off: Awaited<ReturnType<typeof compile>>;
    try {
      off = await compile(consumerSrc, { fileName: "test.ts" });
    } finally {
      delete process.env[IR_ASYNC_GATE];
    }
    expect(off.success).toBe(true);
    const exOff = await instantiateHost(off);
    expect(vOn).toBe((exOff.main as () => number)());
    expect(vOn).toBe(42);
  });
});

describe("#1373b C-1 — engine-activated functions keep byte-identical routing", () => {
  // A genuinely-suspending single-tail-await declaration: on the wasi lane
  // `asyncFnNeedsDrive` activates the $AsyncFrame machine; the IR must
  // decline it, and the emitted binary must be byte-identical with the async
  // IR gate on vs off.
  const src = `
    async function work(): Promise<number> {
      return await Promise.resolve(1).then((x: number) => x + 41);
    }
    export function kick(): number {
      work() as any;
      return 0;
    }
  `;

  it("wasi: the drive-lowered fn is NOT IR-claimed and bytes match gate-off", async () => {
    const on = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(on.success).toBe(true);
    expect(on.irCompiledFuncs ?? []).not.toContain("work");
    process.env[IR_ASYNC_GATE] = "0";
    let off: Awaited<ReturnType<typeof compile>>;
    try {
      off = await compile(src, { fileName: "test.ts", target: "wasi" });
    } finally {
      delete process.env[IR_ASYNC_GATE];
    }
    expect(off.success).toBe(true);
    expect(Buffer.from(on.binary).equals(Buffer.from(off.binary))).toBe(true);
  });

  it("gc: same program byte-identical gate-on vs gate-off (host-drive lane untouched)", async () => {
    const on = await compile(src, { fileName: "test.ts" });
    process.env[IR_ASYNC_GATE] = "0";
    let off: Awaited<ReturnType<typeof compile>>;
    try {
      off = await compile(src, { fileName: "test.ts" });
    } finally {
      delete process.env[IR_ASYNC_GATE];
    }
    expect(on.success).toBe(true);
    expect(off.success).toBe(true);
    expect(Buffer.from(on.binary).equals(Buffer.from(off.binary))).toBe(true);
  });
});

describe("#1373b C-1 — wasi lane sync-shape claim", () => {
  it("an await-elidable async fn claims on wasi and runs host-free", async () => {
    const src = `
      export async function f(): Promise<number> {
        return await Promise.resolve(40) + 2;
      }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
    expect(r.irCompiledFuncs ?? []).toContain("f");
    expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.f as () => number)()).toBe(42);
  });
});
