// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4654) A RegExp produced INSIDE runtime `eval` must reach compiled code as a
 * RegExp.
 *
 * ## What was actually wrong (the issue's own reading was off)
 *
 * The issue filed this as "a NUL (`\u0000`) in a regexp source truncates the
 * pattern", from seven rows all reporting
 * `Code unit: 0 — SameValue(«undefined», «"\u0000"»)`. That is not what those
 * rows measure. Every one of them is a `for (cu = 0; cu <= 0xffff; ++cu)` loop
 * whose body does `eval("/" + String.fromCharCode(cu) + "/").source`, so the
 * FIRST iteration is the NUL one and the first iteration is the only one that
 * ever reported. Measured on campaign HEAD c42bdbe3e with a fresh
 * bundle+adapter, `eval("/" + xx + "/").source` answered `undefined` for
 * `String.fromCharCode(97)` too — every code unit, not the NUL.
 *
 * The root is the outward half of the QuickJS eval membrane
 * (`qjsPublish`, scripts/quickjs-eval-provider.mjs). A non-callable QuickJS
 * object crosses out as the #4245-slice-2 MIRRORED BOX: a compiled `$Object`
 * carrying the QuickJS object's own STRING keys. A RegExp instance has exactly
 * one own string key — `lastIndex`. `source`, `flags`, `global`, `ignoreCase`,
 * `multiline`, `sticky`, `exec` and `test` are all %RegExp.prototype% accessors
 * and methods, so the box arrived carrying none of them: measured
 * `instanceof RegExp === false`, `.source === undefined`,
 * `.test(…)` → "called value is not a function", `.lastIndex === 0`.
 *
 * ## The fix, and why these pins are shaped the way they are
 *
 * `qjsPublish` now RECONSTRUCTS a realm RegExp as a real compiled
 * `new RegExp(source, flags)` before the box arm, falling back to the box when
 * construction refuses.
 *
 * That fix rests on one property of the compiled lane which is NOT obvious and
 * which nothing else pins: **`new RegExp(<dynamic>)` does not refuse an
 * unsupported pattern at CONSTRUCTION.** The standalone runtime pattern grammar
 * (regexp-dynamic-pattern.ts) refuses at MATCH time, so `source`/`flags` are
 * right for every pattern and only `test`/`exec` outside that grammar throw. If
 * that ever moved to construction time, the adapter's arm would start throwing
 * mid-publish (or silently fall back to the useless box) and the seven rows
 * would regress with no other test noticing. `describe("construction-time
 * contract")` below is that pin, and it is UNGATED — it runs everywhere,
 * including on a machine with no QuickJS provider, so this file can never be
 * "green" purely by skipping.
 *
 * The behavioural half needs the QuickJS provider linked and self-gates the
 * same way tests/quickjs-eval-membrane.test.ts does. Its eval sources are
 * composed through a runtime loop so `tryStaticEvalInline` cannot fold them:
 * an all-literal `eval("/a/")` is evaluated at COMPILE time and never reaches
 * the membrane at all (measured — the literal form already answered
 * `source === "a"` on the broken build, which is exactly how this defect stayed
 * invisible).
 */
import { existsSync } from "node:fs";
import { describe, expect, it, beforeAll } from "vitest";

import { compile } from "../src/index.js";
import {
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  runtimeEvalProviderCacheKey,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import {
  buildQuickjsAdapterSource,
  quickjsAdapterCachePath,
  quickjsArtifactCacheDir,
  quickjsArtifactCacheKey,
  readQuickjsArtifact,
} from "../scripts/quickjs-eval-provider.mjs";

const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";
const ENGINE_ENV = "JS2WASM_EVAL_ENGINE";

function quickjsProviderAvailable(): string | null {
  try {
    const cacheDir = defaultRuntimeEvalProviderCacheDir();
    const artifactDir =
      process.env.JS2WASM_QUICKJS_ARTIFACT_DIR ?? quickjsArtifactCacheDir(cacheDir, quickjsArtifactCacheKey());
    const artifact = readQuickjsArtifact(artifactDir);
    if (!artifact) return null;
    const key = runtimeEvalProviderCacheKey(buildQuickjsAdapterSource(artifact.abi), computeCompilerBundleHash());
    return existsSync(quickjsAdapterCachePath(cacheDir, key)) ? artifactDir : null;
  } catch {
    return null;
  }
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─────────────────────────── ungated: the premise ────────────────────────────

/**
 * The pattern is assembled through a loop so it is a genuinely RUNTIME string —
 * a syntactic literal would be folded to the static regexp lane, which has a
 * different (complete) grammar and would make every case here vacuous.
 */
const CONSTRUCTION_SOURCE = `
  function joinParts(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  // In the runtime grammar: literal units.
  var simple: any = new RegExp(joinParts(["a", "b"]), joinParts(["g", "i"]));
  // OUTSIDE it: a character class + a quantifier. Construction must still
  // succeed and still report the source verbatim.
  var hard: any = new RegExp(joinParts(["[a-z]", "+"]), joinParts([""]));
  // A NUL code unit inside a runtime pattern must survive as one unit — the
  // C-string truncation the issue suspected would drop it here if it existed.
  var nul: any = new RegExp(joinParts(["a", String.fromCharCode(0), "b"]), joinParts([""]));

  export function simpleSourceLen(): number { return (simple.source as string).length; }
  export function simpleTest(): number { return simple.test(joinParts(["z", "ab", "z"])) ? 1 : 0; }
  export function hardSourceLen(): number { return (hard.source as string).length; }
  export function hardSourceUnit0(): number { return (hard.source as string).charCodeAt(0) as number; }
  /** 1 when \`test\` threw a catchable TypeError, 0 when it answered. */
  export function hardTestRefuses(): number {
    try {
      hard.test(joinParts(["a", "b"]));
      return 0;
    } catch (e) {
      return (e instanceof TypeError) ? 1 : 2;
    }
  }
  export function nulSourceLen(): number { return (nul.source as string).length; }
  export function nulSourceUnit1(): number { return (nul.source as string).charCodeAt(1) as number; }
`;

/** `env` import names in the emitted WAT — must be empty for a standalone module. */
function envImportNames(wat: string): string[] {
  const out: string[] = [];
  const re = /\(import\s+"env"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wat)) !== null) out.push(m[1]!);
  return out;
}

describe("#4654 — construction-time contract the adapter's RegExp arm rests on", () => {
  let ex: Record<string, () => number>;
  let wat: string;

  beforeAll(async () => {
    const compiled = await compile(CONSTRUCTION_SOURCE, {
      target: "standalone" as const,
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      emitWat: true,
      fileName: "issue-4654-construction.ts",
    });
    expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
    wat = compiled.wat ?? "";
    const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.binary!), {});
    (instance.exports as { _start?: () => void })._start?.();
    ex = instance.exports as unknown as Record<string, () => number>;
  }, 300_000);

  it("a runtime pattern INSIDE the grammar constructs, reports its source and matches", () => {
    expect(ex.simpleSourceLen!()).toBe(2);
    expect(ex.simpleTest!()).toBe(1);
  });

  it("a runtime pattern OUTSIDE the grammar still constructs and still reports its source", () => {
    // `[a-z]+` — six code units, first is `[`. If construction ever started
    // refusing, the adapter's reconstruction arm would lose every pattern that
    // is not in the runtime grammar and #4654's rows would come back.
    expect(ex.hardSourceLen!()).toBe(6);
    expect(ex.hardSourceUnit0!()).toBe(0x5b);
  });

  it("…and refuses at MATCH time, catchably", () => {
    expect(ex.hardTestRefuses!()).toBe(1);
  });

  it("a NUL code unit inside a runtime pattern survives in `source`", () => {
    expect(ex.nulSourceLen!()).toBe(3);
    expect(ex.nulSourceUnit1!()).toBe(0);
  });

  it("emits no host imports (the adapter may import only js2wasm:qjs)", () => {
    expect(envImportNames(wat)).toEqual([]);
  });
});

// ───────────────────── gated: the membrane behaviour itself ──────────────────

/**
 * Every eval source below is loop-composed (see the header). `laneRe` is parked
 * on `globalThis` so the SAME realm object can be fetched by a SECOND
 * evaluation — that pairing is what makes the identity case a measurement
 * rather than a tautology.
 */
const EVAL_REGEXP_SOURCE = `
  function joinSource(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  var re: any = null;
  /** Module-level ON PURPOSE — see \`loopProbe\`. */
  var pattern: any = null;
  var minted = 0;
  try {
    re = (0, eval)(joinSource(["globalThis.laneRe = /a", "b/gi"]));
    minted = 1;
  } catch (e) { minted = -1; }

  export function mintedProbe(): number { return minted; }
  export function isRegExpProbe(): number { return (re instanceof RegExp) ? 1 : 0; }
  export function sourceLenProbe(): number {
    var s: any = re.source;
    return (s === undefined) ? -1 : (s as string).length;
  }
  export function sourceUnitProbe(i: number): number {
    var s: any = re.source;
    return (s === undefined) ? -1 : ((s as string).charCodeAt(i) as number);
  }
  export function testProbe(): number {
    try { return re.test(joinSource(["zz", "AB", "zz"])) ? 1 : 0; } catch (e) { return -1; }
  }
  /** The SAME realm object, fetched by a second evaluation: identity must hold. */
  export function identityProbe(): number {
    try {
      var again: any = (0, eval)(joinSource(["global", "This.laneRe"]));
      return (again === re) ? 1 : 0;
    } catch (e) { return -1; }
  }
  /** A NUL code unit in an eval'd pattern — the shape the issue was filed on. */
  export function nulProbe(): number {
    try {
      var xx: any = String.fromCharCode(0);
      var p: any = (0, eval)(joinSource(["/", xx as string, "/"]));
      var s: any = p.source;
      if (s === undefined) return -1;
      return ((s as string).length as number) * 1000 + ((s as string).charCodeAt(0) as number);
    } catch (e) { return -2; }
  }
  /**
   * THE SHAPE THE SEVEN ROWS HAVE, and the one the registry index exists for.
   * \`pattern\` is MODULE-LEVEL, so each reconstructed RegExp is pushed back INTO
   * the realm as a global on every later iteration — which is the reverse
   * lookup, on the partition that grows by one row per iteration. A
   * function-local result never exercises this and is what let a
   * partition-only fix read as sufficient (#4654 record, "Correction").
   *
   * Returns the number of iterations whose \`source\` was right, or \`-(i + 1)\`
   * for the first that was not. Cost is deliberately NOT asserted here: a
   * wall-clock bound would flake under this box's load, and the timing that
   * matters is recorded in the issue.
   */
  export function loopProbe(n: number): number {
    var ok = 0;
    for (var i = 0; i < n; i += 1) {
      var unit: number = 97 + (i % 26);
      var xx: any = String.fromCharCode(unit);
      pattern = (0, eval)(joinSource(["globalThis.lastLoopRe = /", xx as string, "/"]));
      var s: any = pattern.source;
      if (s === undefined) return -(i + 1);
      if (((s as string).length as number) !== 1) return -(i + 1);
      if (((s as string).charCodeAt(0) as number) !== unit) return -(i + 1);
      ok += 1;
    }
    return ok;
  }

  /**
   * The REVERSE direction, executed rather than asserted: the realm compares
   * its own retained object against the compiled \`pattern\` pushed back in as a
   * global. True only if \`qjsHandleOf\` resolved the compiled RegExp to the
   * SAME realm handle — i.e. the content index answered. A miss would mint a
   * fresh wrapper and this would be false, with nothing else observably wrong.
   * Run AFTER \`loopProbe\`, so the index is populated rather than empty.
   */
  export function loopReverseIdentityProbe(): number {
    try {
      var r: any = (0, eval)(joinSource(["globalThis.lastLoopRe ", "=== pattern"]));
      return (r === true) ? 1 : 0;
    } catch (e) { return -1; }
  }

  /** A realm object that is NOT a regexp must still cross as the mirrored box. */
  export function plainBoxProbe(): number {
    try {
      var o: any = (0, eval)(joinSource(["({ n: 4", "1 })"]));
      return (o as any).n as number;
    } catch (e) { return -1; }
  }
`;

const availableArtifactDir = quickjsProviderAvailable();
const quickjsEnabled = process.env[ENGINE_ENV] === "quickjs" || availableArtifactDir !== null;

describe.skipIf(!quickjsEnabled)("#4654 — a RegExp crossing OUT of runtime eval", () => {
  let ex: Record<string, (arg?: number) => number>;

  beforeAll(async () => {
    const selection = withEnv(
      {
        [ENGINE_ENV]: "quickjs",
        ...(availableArtifactDir ? { JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir } : {}),
      },
      () => selectCachedRuntimeEvalProvider(),
    ) as { engine?: string; bundle?: unknown };
    expect(selection.engine).toBe("quickjs");

    const compiled = await compile(EVAL_REGEXP_SOURCE, {
      target: "standalone" as const,
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      fileName: "issue-4654-eval-regexp.ts",
    });
    expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
    const module = new WebAssembly.Module(compiled.binary!);
    // Without this the module never crosses the seam and every case is vacuous.
    expect(WebAssembly.Module.imports(module).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE)).toBe(true);
    const instance = new WebAssembly.Instance(module, {
      [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(selection.bundle),
    });
    (instance.exports as { _start?: () => void })._start?.();
    ex = instance.exports as unknown as Record<string, (arg?: number) => number>;
  }, 300_000);

  it("the evaluation itself succeeds (anti-vacuity)", () => {
    expect(ex.mintedProbe!()).toBe(1);
  });

  it("answers `source` — the seven rows' assertion", () => {
    expect(ex.sourceLenProbe!()).toBe(2);
    expect(ex.sourceUnitProbe!(0)).toBe(0x61); // a
    expect(ex.sourceUnitProbe!(1)).toBe(0x62); // b
  });

  // `flags` is deliberately NOT probed inside this module. `(x.flags as
  // string).length` on a statically-known regexp typed `any` makes the compiler
  // emit an INVALID module (`struct.get[0] expected (ref null 6), found
  // local.tee of type i32`) — measured on this branch and on base, unrelated to
  // the membrane. Including it here would take the whole suite down in
  // `beforeAll` rather than reporting one failing case. It is pinned as a
  // residual at the bottom of the file, where a bad module is contained.

  it("is a RegExp, and matches", () => {
    expect(ex.isRegExpProbe!()).toBe(1);
    expect(ex.testProbe!()).toBe(1);
  });

  it("keeps identity: the same realm object crossing twice is the same value", () => {
    expect(ex.identityProbe!()).toBe(1);
  });

  it("a NUL pattern crosses as a one-unit source (#4654's filed shape)", () => {
    // length 1, code unit 0.
    expect(ex.nulProbe!()).toBe(1000);
  });

  it("a non-RegExp object still crosses as the mirrored box (no scope creep)", () => {
    expect(ex.plainBoxProbe!()).toBe(41);
  });

  it("the seven rows' LOOP shape: a module-level result answers `source` every time", () => {
    // 64 iterations is enough to populate the registry well past the initial
    // table capacity (16) and force two rehashes.
    expect(ex.loopProbe!(64)).toBe(64);
  });

  it("…and the compiled RegExp pushed back IN resolves to the same realm object", () => {
    expect(ex.loopProbe!(64)).toBe(64);
    expect(ex.loopReverseIdentityProbe!()).toBe(1);
  });
});

// ──────────────────── residuals measured while fixing #4654 ──────────────────
//
// Each of these is a REAL defect measured on this branch, with an owner. They
// are `it.fails` rather than comments so the day one is fixed, this file says
// so instead of quietly agreeing with the old behaviour.

describe("#4654 residuals — RegExp reflection through a dynamic receiver", () => {
  /** Compile + instantiate + call, all inside the case (a bad module here must
   *  not take the whole suite's `beforeAll` with it). */
  async function runExport(source: string, name: string): Promise<number> {
    const compiled = await compile(source, {
      target: "standalone" as const,
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      fileName: "issue-4654-residual.ts",
    });
    expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.binary!), {});
    (instance.exports as { _start?: () => void })._start?.();
    return (instance.exports as unknown as Record<string, () => number>)[name]!();
  }

  const DYN_RE_PRELUDE = `
    function joinParts(parts: string[]): string {
      let out = "";
      for (let i = 0; i < parts.length; i += 1) out = out + parts[i];
      return out;
    }
    function opaque(x: any): any { return x; }
    const re: any = opaque(new RegExp(joinParts(["a", "b"]), joinParts(["g", "i"])));
  `;

  // POSITIVE CONTROL for the three `it.fails` below. The identical dynamic
  // receiver, in the identical module shape, answers `.source` correctly — so
  // those failures are about WHICH member is reachable, not about the receiver
  // being dynamic. If this control ever breaks, the three residuals below stop
  // being evidence for the root they name, and the `it.fails` would keep them
  // green while saying nothing.
  it("`.source` through the SAME dynamic receiver answers correctly (control)", async () => {
    expect(
      await runExport(
        `${DYN_RE_PRELUDE}
      export function probe(): number { const s: any = re.source; return s === undefined ? -1 : (s as string).length; }`,
        "probe",
      ),
    ).toBe(2);
  });

  // OWNER: the #2885 accessor tier (native-proto.ts — accessors are deliberately
  // NOT seeded into the proto companion; see the "ACCESSORS ARE DELIBERATELY NOT
  // SEEDED IN THIS SLICE" record). `.source` answers through a separate arm,
  // which is why it works and these do not.
  it.fails("`.flags` through a dynamic receiver answers the flags string", async () => {
    // Measured on this branch: RuntimeError "dereferencing a null pointer" —
    // an UNCATCHABLE trap, i.e. strictly worse than a wrong value.
    expect(
      await runExport(
        `${DYN_RE_PRELUDE}
      export function probe(): number { return (re.flags as string).length; }`,
        "probe",
      ),
    ).toBe(2);
  });

  it.fails("`.global` through a dynamic receiver answers true", async () => {
    // Measured: `undefined` (the getter member is not reachable from the
    // companion), so this reads -1.
    expect(
      await runExport(
        `${DYN_RE_PRELUDE}
      export function probe(): number { const g: any = re.global; return g === undefined ? -1 : (g ? 1 : 0); }`,
        "probe",
      ),
    ).toBe(1);
  });

  it.fails("`.exec` through a dynamic receiver returns a match array", async () => {
    // Measured: `null` — `emitRegExpProtoMemberBody` emits a spec-shaped
    // placeholder for `exec`/`toString`/`compile` "until their engine body
    // lands" (regexp-standalone.ts). OWNER: the same #2175 S1 follow-up.
    expect(
      await runExport(
        `${DYN_RE_PRELUDE}
      export function probe(): number { const m: any = re.exec(joinParts(["z", "ab"])); return m === null || m === undefined ? -1 : 1; }`,
        "probe",
      ),
    ).toBe(1);
  });
});
