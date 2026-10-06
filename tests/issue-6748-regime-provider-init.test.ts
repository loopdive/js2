// #6748 (S3-g of #5385) — the regime-compiled Temporal provider linked but
// every Temporal row died with an opaque "wasm exception during module init".
//
// Two findings, each pinned here without the 40 s provider build:
//
//  1. THE RENDER. A provider's `__module_init` runs inside
//     `instantiateLinkedProviders`, BEFORE the consumer instance exists, so the
//     embedder only ever held a `WebAssembly.Exception` whose payload is a
//     WasmGC struct no host can stringify. The provider's own `__exn_render_*`
//     exports can read it; the init throw now surfaces as an `Error` naming the
//     provider and the rendered text (original exception as `cause`).
//
//  2. THE CAUSE. Rendered, the Temporal throw read
//     `TypeError: Cannot access property on null or undefined at 4:10198` —
//     the polyfill's top-level `ct = Intl.DateTimeFormat`. The native regime
//     reads the bare `Intl` identifier as null (as standalone does); only the
//     host-assisted lane binds the host's `Intl`. The standalone provider had
//     always been given the module-scoped `Intl` shim for exactly this reason;
//     the regime provider was not. `providerSource` now prepends it for any
//     provider compiled under the native regime.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile, compileProject, instantiateLinkedProject } from "../src/index.js";
import { standaloneIntlShimSource } from "../src/temporal-intl-shim.js";

const REGIME = { semanticProviders: "native-first", hostBridge: "always" } as const;

async function linkedRegimeProject(provider: string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "issue-6748-"));
  const packageRoot = join(root, "node_modules", "init6748");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "init6748", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "main.js");
  writeFileSync(entry, `import { probe } from "init6748";\nexport function run() { return probe(); }\n`);
  const result = await compileProject(entry, {
    ...REGIME,
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
  } as never);
  expect(result.success).toBe(true);
  // Load-bearing: a `bundled` plan would inline the package, and the throw
  // would happen in the consumer's own init — not the path under test.
  expect(result.linkPlan?.mode).toBe("separate");
  try {
    await instantiateLinkedProject(result);
    return "no-throw";
  } catch (error) {
    return error;
  }
}

describe("#6748 — a regime provider's module-init throw is rendered", () => {
  it("names the provider and the native TypeError instead of an opaque exception", { timeout: 300_000 }, async () => {
    const thrown = await linkedRegimeProject(
      `const box = null;\nexport const value = box.missing;\nexport function probe() { return 1; }\n`,
    );
    // Base: a bare `WebAssembly.Exception` (String() of its payload throws
    // "Cannot convert object to primitive value"), which the test262 worker
    // could only label "wasm exception during module init".
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/^Linked provider js2wasm:npm:init6748:\S+ threw during module init: /);
    expect(message).toContain("TypeError: Cannot access property on null or undefined");
    expect((thrown as Error).cause).toBeInstanceOf(WebAssembly.Exception);
  });

  it("leaves a provider whose init returns untouched", { timeout: 300_000 }, async () => {
    expect(await linkedRegimeProject(`export function probe() { return 1; }\n`)).toBe("no-throw");
  });
});

describe("#6748 — a regime consumer uses a regime provider's class across the link", () => {
  // Once init returned, every regime Temporal row failed on the seam itself:
  //  - the runtime handed the consumer a JS host MIRROR of the provider value
  //    (built for host-lane providers), which the consumer's native MOP can
  //    only treat as an unadmitted foreign object → "value is not a constructor";
  //  - with the raw struct, `new` paired the wasm peer's "constructible" verdict
  //    with the JS boundary's construct → "not an admitted JavaScript constructor";
  //  - member reads / method calls asked only the JS boundary (`boundary ?? peer`),
  //    so an accessor read answered `undefined` and a static call "is not a function".
  // A regime module in a JavaScript environment has BOTH families; each now asks
  // the wasm peer first. (Reduced from `new Temporal.PlainTime(1, 2, 3).hour` and
  // `Temporal.PlainTime.from("12:34")`.)
  const PROVIDER = `
class Clock {
  constructor(h) { this._h = h; }
  get hour() { return this._h; }
  plus(n) { return new Clock(this._h + n); }
  static from(h) { return new Clock(h * 10); }
}
export const NS = { Clock };
export function probe() { return 0; }
`;

  it("constructs, reads an accessor, and calls static and instance methods", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-6748-seam-"));
    const packageRoot = join(root, "node_modules", "seam6748");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "seam6748", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER);
    const entry = join(root, "main.js");
    writeFileSync(
      entry,
      `import { NS } from "seam6748";
export function ctorHour() { return new NS.Clock(7).hour; }
export function methodHour() { return new NS.Clock(7).plus(2).hour; }
export function staticHour() { return NS.Clock.from(4).hour; }
`,
    );
    const result = await compileProject(entry, {
      ...REGIME,
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    } as never);
    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode).toBe("separate");
    const { instance } = await instantiateLinkedProject(result);
    const exports = instance.exports as unknown as Record<string, () => unknown>;
    const read = (name: string): unknown => {
      try {
        return exports[name]!();
      } catch (error) {
        return `THREW: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    expect({ ctor: read("ctorHour"), method: read("methodHour"), static: read("staticHour") }).toEqual({
      ctor: 7,
      method: 9,
      static: 40,
    });
  });
});

describe("#6748 — the regime reads the bare Intl identifier natively", () => {
  // The Temporal polyfill's first module-init statement that needs a host
  // global, reduced. Single-module, so it isolates the regime's Intl answer
  // from the provider seam.
  const POLYFILL_HEAD = `const ct = Intl.DateTimeFormat;\nexport function probe() { return typeof ct === "function" ? 1 : 0; }\n`;

  async function runInit(source: string): Promise<string> {
    const result = await compile(source, { ...REGIME, allowJs: true, fileName: "probe.js" } as never);
    expect(result.success).toBe(true);
    const imports = result.importObject as WebAssembly.Imports & {
      __setInstance?: (instance: WebAssembly.Instance) => void;
    };
    try {
      const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
      imports.__setInstance?.(instance);
      (instance.exports as { __module_init?: () => void }).__module_init?.();
      return String((instance.exports as { probe: () => unknown }).probe());
    } catch {
      return "init-threw";
    }
  }

  it("throws at init without the shim — the cause of every regime Temporal failure", { timeout: 120_000 }, async () => {
    expect(await runInit(POLYFILL_HEAD)).toBe("init-threw");
  });

  it("initializes with the module-scoped Intl shim the provider now carries", { timeout: 120_000 }, async () => {
    expect(await runInit(`${standaloneIntlShimSource()}\n${POLYFILL_HEAD}`)).toBe("1");
  });
});
