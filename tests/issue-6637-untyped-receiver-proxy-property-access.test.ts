// #6637 — dynamic ("any"-typed) property access on a value that turns out to
// be a Proxy at runtime must dispatch through the Proxy trap machinery, not
// throw "Cannot access property on null or undefined".
//
// Root cause: `new Proxy(target, handler)` is typed by TypeScript AS ITS
// TARGET (`ProxyConstructor` in lib.es5.d.ts returns `T`, not a Proxy-branded
// type), so the checker sees `const p = new Proxy({overflow:1}, {})` as
// `{overflow: number}`. The compiler stores `p`'s local using a WasmGC struct
// matching that CHECKER-FICTIONAL shape UNLESS a narrow analysis
// (`proxyBindingNeedsExternref` / `proxyBindingEscapesToCall`,
// `src/codegen/analysis/proxy-binding-escape.ts`) forces the raw externref
// carrier instead. That analysis treats ANY call-argument use as an "escape"
// that keeps the struct typing (#2615's fix, narrowed by #2615's own
// regression for host generic-method receivers like
// `Object.prototype.toString.call(p)`). But when the callee's OWN parameter
// has no type annotation (implicit "any" — exactly the shape every
// compiled-package link-stub parameter has, and every plain untyped helper
// function), passing the raw Proxy externref is always safe: an untyped
// parameter reads its argument through the generic dynamic member-access
// path (`__dyn_member_get`/`__extern_get`), which already recognizes
// `$Proxy` via its own `ref.test` front-guard. Forcing the struct slot here
// instead guarded-casts the live Proxy to the checker-fictional target
// struct, the cast fails (the runtime value is `$Proxy`, not that struct),
// the local becomes `ref.null`, and every later dynamic read on it misreads
// "wrong static shape" as "receiver is null or undefined".
//
// Fix: `src/codegen/analysis/proxy-binding-escape.ts`'s
// `expressionIsEscapingArgument` no longer counts a plain call `f(...)` to a
// bare-identifier callee as an escape when the matching parameter is
// genuinely untyped (`ctx.oracle.signatureOf`'s `{kind:"any"}` fact). Method/
// `.call`/`.apply` receivers (the #2615 regression class) all have a
// PropertyAccessExpression callee and are unaffected — they keep declining
// (struct-typed storage) exactly as before.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function compileAndRun(src: string): Promise<Record<string, () => unknown>> {
  const result = await compile(src, { ...STANDALONE });
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(result.binary as unknown as BufferSource);
  const instance = new WebAssembly.Instance(mod, result.importObject ?? {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

describe("#6637 untyped-receiver Proxy property access (single module)", () => {
  it("read: untyped fn reading an empty-handler Proxy sees the target's field", async () => {
    const ex = await compileAndRun(`
      function readOverflow(o) { return o.overflow; }
      export function main() {
        const options = new Proxy({ overflow: 1 }, {});
        return readOverflow(options) === 1 ? 1 : 2;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("read: untyped fn reading a Proxy with a real get trap runs the trap (not the target field)", async () => {
    const ex = await compileAndRun(`
      let trapCalls = 0;
      function readOverflow(o) { return o.overflow; }
      export function main() {
        trapCalls = 0;
        const options = new Proxy({ overflow: 1 }, { get(t, k) { trapCalls++; return 99; } });
        const v = readOverflow(options);
        return v === 99 && trapCalls === 1 ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("write: untyped fn writing through a Proxy with a real set trap runs the trap", async () => {
    const ex = await compileAndRun(`
      let setCalls = 0;
      let lastValue = 0;
      function writeOverflow(o) { o.overflow = 5; }
      export function main() {
        setCalls = 0;
        lastValue = 0;
        const options = new Proxy({ overflow: 1 }, {
          set(t, k, v) { setCalls++; lastValue = v; return true; },
        });
        writeOverflow(options);
        return setCalls === 1 && lastValue === 5 ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  // NOTE: `proxy.m()` (calling a METHOD through a Proxy receiver, any
  // handler) throws even in the fully statically-typed direct case on this
  // tree and on base — confirmed with `.tmp/s53/debug-call3.mjs`
  // (`options.m()` with no untyped indirection at all still throws). That is
  // a separate, pre-existing method-call-dispatch-on-Proxy gap, not sharing
  // this issue's untyped-receiver-storage defect (this fix changes nothing
  // about it either way), so it is out of scope here — filed separately.

  it("`in`: untyped fn testing membership through a has trap", async () => {
    const ex = await compileAndRun(`
      function hasOverflow(o) { return "overflow" in o ? 1 : 0; }
      export function main() {
        const options = new Proxy({}, { has(t, k) { return k === "overflow"; } });
        return hasOverflow(options);
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("Object.keys: untyped fn enumerating through an ownKeys trap", async () => {
    const ex = await compileAndRun(`
      function keyCount(o) { return Object.keys(o).length; }
      export function main() {
        const options = new Proxy(
          { overflow: 1, extra: 2 },
          {
            ownKeys(t) { return ["overflow"]; },
            getOwnPropertyDescriptor(t, k) {
              return { value: t[k], writable: true, enumerable: true, configurable: true };
            },
          },
        );
        return keyCount(options);
      }
    `);
    expect(ex.main()).toBe(1);
  });

  // NOTE: an `isExtensible` TRAP specifically (`new Proxy(t, {isExtensible(){
  // ...}})`) also throws even in the fully statically-typed direct case on
  // this tree and on base — confirmed with `.tmp/s53/debug-isext2.mjs`
  // (`Object.isExtensible(options)` with no untyped indirection at all still
  // throws). Separate, pre-existing gap, out of scope here — filed
  // separately. The empty-handler (no trap, forwards to the target) case
  // below IS in this fix's scope and is the one #6637's original 10 sample
  // rows exercised.
  it("Object.isExtensible: untyped fn through an empty-handler Proxy forwards to the target", async () => {
    const ex = await compileAndRun(`
      function extensible(o) { return Object.isExtensible(o) ? 1 : 0; }
      export function main() {
        const options = new Proxy({}, {});
        return extensible(options);
      }
    `);
    expect(ex.main()).toBe(1);
  });
});

describe("#6637 controls — the fix must not change these", () => {
  it("untyped receiver that IS genuinely null still throws", async () => {
    const ex = await compileAndRun(`
      function readOverflow(o) { return o.overflow; }
      export function main() {
        try {
          readOverflow(null);
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("untyped receiver holding a plain object still answers correctly", async () => {
    const ex = await compileAndRun(`
      function readOverflow(o) { return o.overflow; }
      export function main() {
        return readOverflow({ overflow: 1 }) === 1 ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("untyped receiver holding a class instance still answers correctly", async () => {
    const ex = await compileAndRun(`
      class C { constructor() { this.overflow = 1; } }
      function readOverflow(o) { return o.overflow; }
      export function main() {
        return readOverflow(new C()) === 1 ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("untyped receiver holding an array still answers correctly", async () => {
    const ex = await compileAndRun(`
      function readLength(o) { return o.length; }
      export function main() {
        return readLength([1, 2, 3]) === 3 ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("statically-typed direct Proxy property read is unchanged", async () => {
    const ex = await compileAndRun(`
      export function main() {
        const options = new Proxy({ overflow: 1 }, {});
        return options.overflow === 1 ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });

  it("a Proxy binding escaping to a TYPED (non-any) call keeps working (#2615 class unaffected)", async () => {
    const ex = await compileAndRun(`
      export function main() {
        const options = new Proxy({ overflow: 1 }, {});
        // Object.getPrototypeOf is a well-known Object.* static — already on
        // the consumesExternrefCarrier allowlist, unaffected by this fix.
        const proto = Object.getPrototypeOf(options);
        return proto !== undefined ? 1 : 0;
      }
    `);
    expect(ex.main()).toBe(1);
  });
});

describe("#6637 two-module control — provider reads a consumer-built Proxy across the link", () => {
  it("a linked provider's untyped parameter reads a consumer Proxy correctly", { timeout: 600_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-6637-witness-"));
    const packageRoot = join(root, "node_modules", "ns6637w");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns6637w", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), "export function readOverflowW(o) { return o.overflow; }\n");
    const entry = join(root, "entry.js");
    writeFileSync(
      entry,
      `import { readOverflowW } from "ns6637w";\nexport function __probe() { return typeof readOverflowW; }\n`,
    );
    const built = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
      ...STANDALONE,
    } as never);
    expect(built.success, (built.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
    const artifact = (built.linkedModules ?? []).find((m) => m.packageName === "ns6637w")!;
    expect(artifact, "expected separate-link artifact for ns6637w").toBeTruthy();
    const field = artifact.exportBoundaries!.readOverflowW!.field;

    const consumerEntry = "/__main.js";
    const CONSUMER = `
      export function main() {
        const options = new Proxy({ overflow: 1 }, {});
        try {
          const v = readOverflowW(options);
          return v === 1 ? 1 : 2;
        } catch (e) {
          return -1;
        }
      }
    `;
    const result = await compileMulti(
      {
        "/__stub.ts": `export declare function ${field}(o: any): any;\n`,
        [consumerEntry]: `import { ${field} as readOverflowW } from "/__stub";\n${CONSUMER}`,
      },
      consumerEntry,
      {
        allowJs: true,
        skipSemanticDiagnostics: true,
        canonicalRuntimeTypes: true,
        link: [artifact.namespace],
        linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
        ...STANDALONE,
      } as never,
    );
    (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
    expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await instantiateLinkedProject(result, {});
    const ex = instance.exports as unknown as Record<string, () => number>;
    expect(ex.main()).toBe(1);
  });
});
