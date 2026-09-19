// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6637 (#5383 S63) — a CONSUMER-built `Proxy` read inside a linked PROVIDER
// threw `TypeError: Proxy get trap is not callable` under `--target
// standalone`, which is what `Temporal.PlainDate.from(fields, new Proxy(opts,
// {get(){…}}))` does in six test262 `order-of-operations` /
// `observable-get-*` rows and four `options-read-before-algorithmic-validation`
// rows.
//
// ROOT CAUSE (measured, `.tmp/s63/probe1.out`): the provider's
// `__typeof_function` classifies callables by `ref.test`ing the closure wrapper
// types IT registered, so it answers 0 for EVERY consumer-owned closure —
// named function, arrow, object-literal method alike. The proxy dispatch reads
// the trap out of the foreign `$Proxy`'s `ptraps` field, asks that classifier,
// and throws. (S52b/S55 built the opposite fix — a reverse-peer channel that
// teaches the provider to CLASSIFY a foreign closure. It classifies correctly
// and still cannot run a trap: invoking one also needs the owner's `this`
// binding and its own `__apply_closure` arity ladder.)
//
// THE FIX: on the one path that throws today, hand the WHOLE `[[Get]]` back to
// the module that owns the Proxy, over the #5383 S17 reverse channel, through
// a dedicated RAW terminal (`__js2wasm_link_local_proxy_get`) that returns
// `__extern_get` verbatim. The consumer re-performs `proxy[key]` with its own
// dispatch, its own trap and its own closure call — ONE trap invocation, and
// an `undefined` answer survives as the boxed-NaN undefined carrier instead of
// being normalised to "not mine".
//
// Host-free: `hostBridge: "off"` and an EMPTY import object, so every value
// crosses purely in Wasm with no host decode step to mask a boundary bug.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/** The provider half: plain untyped readers, exactly the shape a polyfill has. */
const PROVIDER = `
  export function readOverflow(o) { return o.overflow; }
  export function readTwo(o) { return o.a + o.b; }
  export function isRelativeToUndefined(o) { return o.relativeTo === undefined ? 1 : 0; }
  export function hasOverflow(o) { return ("overflow" in o) ? 1 : 0; }
`;

/**
 * The same provider plus a Proxy of its OWN — NOT a cosmetic difference, see
 * the second `it` below. Compiling one registers a closure wrapper type in the
 * PROVIDER; a consumer trap closure of matching shape then passes the
 * provider's `ref.test` ladder, so `__typeof_function` answers "callable", the
 * guard this fix hangs off never fires, and the provider tries to run a
 * foreign closure through its own `__apply_closure`, which silently answers
 * nothing. That is #6628's foreign-closure class — older and wider than this
 * fix, and measured here rather than left to be rediscovered.
 */
const PROVIDER_WITH_OWN_PROXY = `${PROVIDER}
  export function readLocalProxy() {
    const p = new Proxy({ overflow: 11 }, { get(t, k) { return t[k]; } });
    return p.overflow;
  }
`;

const BASE_EXPORTS = ["readOverflow", "readTwo", "isRelativeToUndefined", "hasOverflow"] as const;

async function linkedPair(
  consumer: string,
  provider: string = PROVIDER,
  PROVIDER_EXPORTS: readonly string[] = BASE_EXPORTS,
): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6637-"));
  const packageRoot = join(root, "node_modules", "pkg6637");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pkg6637", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(
    entry,
    `import { ${PROVIDER_EXPORTS.join(", ")} } from "pkg6637";\n` +
      `export function __probe() { return ${PROVIDER_EXPORTS.map((n) => `typeof ${n}`).join(" + ")}; }\n`,
  );
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "pkg6637")!;
  const fields = new Map(PROVIDER_EXPORTS.map((name) => [name, artifact.exportBoundaries![name]!.field]));
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      // `readLocalProxy` takes no argument; a uniform `(o: any)` stub would be a
      // signature mismatch at instantiation, not a compile error.
      "/__ns_stub.ts": [...fields.entries()]
        .map(([name, f]) =>
          name === "readLocalProxy"
            ? `export declare function ${f}(): any;\n`
            : `export declare function ${f}(o: any): any;\n`,
        )
        .join(""),
      [consumerEntry]:
        `import { ${[...fields.entries()].map(([name, f]) => `${f} as ${name}`).join(", ")} } from "/__ns_stub";\n` +
        consumer,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([...fields.values()].map((f) => [f, { module: artifact.namespace, field: f }])),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

// A real top-level side-effecting statement is REQUIRED: without one the
// consumer's `__module_init` is folded away, the reverse-peer install never
// runs, and every one of these reports the base-tree answer for a reason that
// has nothing to do with the fix (S55 lost a session to this).
const CONSUMER = `
  let __forceInit = 1;
  __forceInit = 2;

  function namedGetTrap(t: any, k: any) { return t[k]; }

  // TEETH — all threw "Proxy get trap is not callable" on the base tree.
  export function objectLiteralTrap(): number {
    const p = new Proxy({ overflow: 7 }, { get(t: any, k: any) { return t[k]; } });
    return readOverflow(p);
  }
  export function namedFunctionTrap(): number {
    const p = new Proxy({ overflow: 7 }, { get: namedGetTrap });
    return readOverflow(p);
  }
  export function trapCalledOncePerRead(): number {
    let n = 0;
    const p = new Proxy({ a: 3, b: 4 }, { get(t: any, k: any) { n = n + 1; return t[k]; } });
    const v = readTwo(p);
    return v === 7 ? n : -1;
  }
  export function trapSeesTargetAndKey(): number {
    // Bit 8 = the trap ran at all; 1/2/4 = target, key, receiver identity.
    // \`p\` is annotated \`any\` deliberately: without it TypeScript types the
    // binding as its TARGET (\`ProxyConstructor\`'s \`new <T>(target: T, …): T\`)
    // and the #6637 S53 escape analysis is what decides its storage — a
    // separate mechanism this witness should not be entangled with.
    let ok = 0;
    const target = { overflow: 7 };
    const p: any = new Proxy(target, {
      get(t: any, k: any, r: any) {
        ok = ok + 8;
        if (t === target) ok = ok + 1;
        if (String(k) === "overflow") ok = ok + 2;
        if (r === p) ok = ok + 4;
        return t[k];
      },
    });
    readOverflow(p);
    return ok;
  }
  export function trapReturnValueIsForwarded(): number {
    const p = new Proxy({ overflow: 7 }, { get(_t: any, _k: any) { return 42; } });
    return readOverflow(p);
  }
  export function undefinedTrapResultSurvives(): number {
    // The value is genuinely \`undefined\`, which the ORIGINAL reverse \`get\`
    // terminal normalises to "not mine". One trap call, answer preserved.
    let n = 0;
    const p = new Proxy({ relativeTo: undefined }, { get(t: any, k: any) { n = n + 1; return t[k]; } });
    const v = isRelativeToUndefined(p);
    return v === 1 ? n : -1;
  }
  export function trapThrowPropagates(): number {
    const p = new Proxy({ overflow: 7 }, { get(_t: any, _k: any) { throw new RangeError("boom"); } });
    try { readOverflow(p); return 0; } catch (e: any) { return e instanceof RangeError ? 1 : 2; }
  }

  // CONTROLS — must answer the same on both trees.
  export function nonCallableTrapStillThrows(): number {
    const p = new Proxy({ overflow: 7 }, { get: 1 as any });
    try { readOverflow(p); return 0; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
  }
  export function consumerLocalProxyUnchanged(): number {
    const p = new Proxy({ overflow: 7 }, { get: namedGetTrap });
    return p.overflow;
  }
  export function plainBagUnchanged(): number { return readOverflow({ overflow: 7 }); }
  export function hasTrapUnchanged(): number {
    // \`in\` does NOT route through the get-trap guard; this pins that it keeps
    // whatever it answered before (the trap-absent forward to the target).
    const p = new Proxy({ overflow: 7 }, {});
    return hasOverflow(p);
  }
  export function emptyHandlerReadForwards(): number {
    const p = new Proxy({ overflow: 7 }, {});
    return readOverflow(p);
  }
`;

describe("#6637 a consumer-built Proxy read inside a linked standalone provider", () => {
  it(
    "runs the trap in the module that owns it instead of throwing 'get trap is not callable'",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(CONSUMER);
      // TEETH
      expect(ex.objectLiteralTrap()).toBe(7);
      expect(ex.namedFunctionTrap()).toBe(7);
      expect(ex.trapCalledOncePerRead()).toBe(2);
      expect(ex.trapSeesTargetAndKey()).toBe(15);
      expect(ex.trapReturnValueIsForwarded()).toBe(42);
      expect(ex.undefinedTrapResultSurvives()).toBe(1);
      expect(ex.trapThrowPropagates()).toBe(1);
      // CONTROLS
      expect(ex.nonCallableTrapStillThrows()).toBe(1);
      expect(ex.consumerLocalProxyUnchanged()).toBe(7);
      expect(ex.plainBagUnchanged()).toBe(7);
      expect(ex.hasTrapUnchanged()).toBe(1);
      expect(ex.emptyHandlerReadForwards()).toBe(7);
    },
  );

  // The RESIDUAL, pinned so it is a finding rather than a surprise. Bisected
  // 2026-09-19 (`.tmp/s63/probe4.mts`): a provider that compiles a Proxy of its
  // own registers a closure wrapper type, the consumer's trap closure then
  // passes the provider's `ref.test` callable ladder, and control never reaches
  // the guard this fix hangs off — the provider calls a foreign closure through
  // its own `__apply_closure`, which runs NOTHING and answers `undefined`. The
  // real @js-temporal/polyfill provider contains no `new Proxy` (verified on
  // the compiled artifact), which is why all ten target rows pass regardless.
  // When #6628's foreign-closure class is fixed, `crossTrapRuns` becomes 15 and
  // this expectation has to be tightened, not deleted.
  it(
    "is BYPASSED when the provider owns a Proxy of its own (#6628 residual, documented not fixed)",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(
        `
        let __forceInit = 1;
        __forceInit = 2;
        export function providerLocalProxyStillWorks(): number { return readLocalProxy(); }
        export function crossTrapRuns(): number {
          let ok = 0;
          const target = { overflow: 7 };
          const p: any = new Proxy(target, {
            get(t: any, k: any, r: any) {
              ok = ok + 8;
              if (t === target) ok = ok + 1;
              if (String(k) === "overflow") ok = ok + 2;
              if (r === p) ok = ok + 4;
              return t[k];
            },
          });
          readOverflow(p);
          return ok;
        }
      `,
        PROVIDER_WITH_OWN_PROXY,
        [...BASE_EXPORTS, "readLocalProxy"],
      );
      // The provider's OWN proxy is unaffected by anything here.
      expect(ex.providerLocalProxyStillWorks()).toBe(11);
      // …and the consumer's trap is never invoked: 0, not 15.
      expect(ex.crossTrapRuns()).toBe(0);
    },
  );
});
