// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const FUNC_SPACE = new URL("../src/codegen/func-space.ts", import.meta.url).href;
const RESOLVE_LAYOUT = new URL("../src/emit/resolve-layout.ts", import.meta.url).href;
const TS_API = new URL("../src/ts-api.ts", import.meta.url).href;
const SOURCE_INTEGRATION = new URL("../src/codegen/multi-source-ir-integration.ts", import.meta.url).href;
const TYPE_REGISTRY = new URL("../src/codegen/registry/types.ts", import.meta.url).href;
const WRAPPER_REGISTRY = new URL("../src/codegen/closures/funcref-wrapper-types.ts", import.meta.url).href;
const CLOSURE_HEADER = new URL("../src/codegen/closures/closure-header-layout.ts", import.meta.url).href;
const ABI_PLANNING = new URL("../src/codegen/program-abi-planning.ts", import.meta.url).href;
const IMPORT_PLANNING = new URL("../src/codegen/program-abi-import-planning.ts", import.meta.url).href;

function importWithFrontendBarrier(body: string) {
  const loader = `
    export async function load(url, context, next) {
      const path = decodeURIComponent(url);
      if (/\\/src\\/(?:ts-api|compiler|ir\\/(?:from-ast|async-prepare|async-linear-prepare)|codegen\\/(?:index|multi-source-ir-integration|async-ir-planning|async-linear-planning))\\.[cm]?[jt]s(?:\\?|$)|\\/node_modules\\/typescript\\//.test(path)) {
        throw new Error('blocked frontend module: ' + url);
      }
      const result = await next(url, context);
      if (/\\/src\\//.test(path)) process.stderr.write('IR_HANDLE_LOADED:' + JSON.stringify(url) + '\\n');
      return result;
    }
  `;
  const script = `
    import assert from 'node:assert/strict';
    import { register } from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
    ${body}
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("#3518 physical runtime handle import boundary", () => {
  it("loads and uses the same stable handle registry without loading source integration", () => {
    const child = importWithFrontendBarrier(`
      const { definedFuncAt, definedFuncHandleOf } = await import(${JSON.stringify(FUNC_SPACE)});
      const { STABLE_FUNC_BASE } = await import(${JSON.stringify(RESOLVE_LAYOUT)});
      const fn = { name: 'prepared-helper', typeIdx: 0, params: [], locals: [], body: [] };
      const ctx = { numImportFuncs: 3, mod: { functions: [fn], funcOrdinalToPosition: [0] } };
      assert.equal(definedFuncAt(ctx, STABLE_FUNC_BASE), fn);
      assert.equal(definedFuncHandleOf(ctx, fn), STABLE_FUNC_BASE);
      assert.equal(definedFuncAt(ctx, STABLE_FUNC_BASE + 1), undefined);
      console.log(JSON.stringify({ stableHandleLookup: true }));
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ stableHandleLookup: true });
    const loaded = child.stderr
      .split("\n")
      .filter((line) => line.startsWith("IR_HANDLE_LOADED:"))
      .map((line) => JSON.parse(line.slice("IR_HANDLE_LOADED:".length)));
    expect(loaded).toContain(FUNC_SPACE);
    expect(loaded).toContain(RESOLVE_LAYOUT);
  });

  it("rejects deliberate frontend and source-integration imports in a fresh process", () => {
    const child = importWithFrontendBarrier(`
      const blocked = [];
      for (const url of ${JSON.stringify([TS_API, SOURCE_INTEGRATION])}) {
        try { await import(url); }
        catch (error) {
          if (!String(error).includes('blocked frontend module: ' + url)) throw error;
          blocked.push(url);
        }
      }
      console.log(JSON.stringify({ blocked }));
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ blocked: [TS_API, SOURCE_INTEGRATION] });
  });

  it("loads the physical type, closure, and ABI planning leaves without the frontend", () => {
    const child = importWithFrontendBarrier(`
      const registry = await import(${JSON.stringify(TYPE_REGISTRY)});
      const wrappers = await import(${JSON.stringify(WRAPPER_REGISTRY)});
      const header = await import(${JSON.stringify(CLOSURE_HEADER)});
      const plans = await import(${JSON.stringify(ABI_PLANNING)});
      const imports = await import(${JSON.stringify(IMPORT_PLANNING)});
      const ctx = {
        mod: { types: [] }, funcTypeCache: new Map(), closureCounter: 0,
        funcRefWrapperCache: new Map(), closureInfoByTypeIdx: new Map(),
        closureMinimumArgumentCountByFuncTypeIdx: new Map(),
      };
      const params = [{ kind: 'f64' }];
      const results = [{ kind: 'externref' }];
      const first = wrappers.getOrCreateFuncRefWrapperTypes(ctx, params, results, 'host-one-shot');
      assert.ok(first);
      assert.equal(first.closureInfo.hostOneShotOnly, true);
      const reused = wrappers.getOrCreateFuncRefWrapperTypes(ctx, params, results, 'ordinary');
      assert.equal(reused.closureInfo, first.closureInfo);
      assert.equal(first.closureInfo.hostOneShotOnly, false);
      assert.equal(ctx.closureCounter, 1);
      assert.equal(ctx.mod.types.length, 2);
      const lifted = ctx.mod.types[first.liftedFuncTypeIdx];
      assert.equal(registry.addFuncType(ctx, lifted.params, results), first.liftedFuncTypeIdx);
      assert.equal(ctx.mod.types.length, 2);
      assert.equal(wrappers.getClosureFuncSelfTypeIdx(ctx, first.liftedFuncTypeIdx), first.structTypeIdx);
      assert.equal(wrappers.getFuncRefWrapperRootTypeIdx(ctx), first.structTypeIdx);
      assert.equal(wrappers.closureBagField, header.closureBagField);
      assert.equal(wrappers.closureBagInitInstr, header.closureBagInitInstr);
      assert.equal(typeof plans.planProgramAbiSupportCallable, 'function');
      assert.equal(typeof imports.ProgramAbiCallableImportRegistry, 'function');
      console.log(JSON.stringify({ canonicalTypeCount: ctx.mod.types.length, sharedHeaderFactories: true }));
    `);
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ canonicalTypeCount: 2, sharedHeaderFactories: true });
    const loaded = child.stderr
      .split("\n")
      .filter((line) => line.startsWith("IR_HANDLE_LOADED:"))
      .map((line) => JSON.parse(line.slice("IR_HANDLE_LOADED:".length)));
    for (const url of [TYPE_REGISTRY, WRAPPER_REGISTRY, CLOSURE_HEADER, ABI_PLANNING, IMPORT_PLANNING]) {
      expect(loaded).toContain(url);
    }
  });
});
