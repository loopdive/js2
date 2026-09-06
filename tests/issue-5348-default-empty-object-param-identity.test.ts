// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5348 — `ensureStructForType` eagerly registers the single non-nullish member
// of a two-member `T | nullish` union (#5390 / PR 5390). A parameter written
// `state = {}` gives its call sites the contextual type `{} | undefined`, so
// passing an object literal registered the EMPTY object type `{}` as a closed
// ZERO-FIELD struct.
//
// Registration is a global mutation of `ctx.anonTypeMap`, so the damage lands
// far from the trigger: every later `{}`-typed value resolves to that empty
// struct, and `Object.keys(x)` enumerates its zero fields instead of the live
// host object. In redux's `combineReducers` that made
// `finalReducerKeys.length !== Object.keys(state).length` permanently true, so
// `combination` returned a fresh `nextState` instead of the `state` it was
// handed — silently losing referential identity.
//
// SCOPE OF THIS TEST: it pins the referential-equality property end to end on
// the redux `combineReducers` shape (untyped JS implementation + TypeScript
// consumer, which is how redux ships: dist/redux.mjs + redux.d.ts). It is a
// property guard, NOT a reproduction — a synthetic project registers `{}`
// through other paths too, which masks the specific fault. The discriminating
// reproduction is the redux upstream dogfood suite, where
// `test/combineReducers.spec.ts` moved 10/16 -> 13/16 and the package moved
// 61/82 -> 64/82 on this fix.
import { describe, expect, it } from "vitest";

import { compileMulti, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports;
}

const PROJECT = {
  // Untyped JavaScript, shaped like redux's published dist/redux.mjs.
  "./store.js": `
    export function combineReducers(reducers) {
      const reducerKeys = Object.keys(reducers);
      const finalReducers = {};
      for (let i = 0; i < reducerKeys.length; i++) {
        const key = reducerKeys[i];
        if (typeof reducers[key] === "function") {
          finalReducers[key] = reducers[key];
        }
      }
      const finalReducerKeys = Object.keys(finalReducers);
      // The \`= {}\` default is what gives call sites the \`{} | undefined\`
      // contextual type that used to register the empty object type.
      return function combination(state = {}, action) {
        let hasChanged = false;
        const nextState = {};
        for (let i = 0; i < finalReducerKeys.length; i++) {
          const key = finalReducerKeys[i];
          const reducer = finalReducers[key];
          const previousStateForKey = state[key];
          const nextStateForKey = reducer(previousStateForKey, action);
          nextState[key] = nextStateForKey;
          hasChanged = hasChanged || nextStateForKey !== previousStateForKey;
        }
        hasChanged = hasChanged || finalReducerKeys.length !== Object.keys(state).length;
        return hasChanged ? nextState : state;
      };
    }
  `,
  "./entry.ts": `
    import { combineReducers } from "./store.js";

    function counter(state: any, action: any) {
      if (state === undefined) return { count: 1 };
      return state;
    }
    function todos(state: any, action: any) {
      if (state === undefined) return { items: 2 };
      return state;
    }

    // Referential equality decided INSIDE Wasm with \`===\`. A structural copy
    // scores 0, so this cannot be satisfied by an equal-but-distinct object.
    export function sameStateObjectReturned(): number {
      const reducer = combineReducers({ counter, todos });
      const initial = reducer(undefined, { type: "INIT" });
      const next = reducer(initial, { type: "NOOP" });
      return next === initial ? 1 : 0;
    }

    // Same property one dispatch deeper: identity must survive repeatedly.
    export function stableAcrossRepeatedDispatch(): number {
      const reducer = combineReducers({ counter, todos });
      const initial = reducer(undefined, { type: "INIT" });
      let state = initial;
      for (let i = 0; i < 3; i++) state = reducer(state, { type: "NOOP" });
      return state === initial ? 1 : 0;
    }

    // An INLINE object literal in the \`state\` position is the construct whose
    // contextual type is \`{} | undefined\` — the trigger this fix guards.
    export function inlineLiteralArgumentStillWorks(): number {
      const reducer = combineReducers({ counter, todos });
      const out = reducer({ counter: { count: 7 }, todos: { items: 9 } }, { type: "NOOP" });
      return out.counter.count * 10 + out.todos.items;
    }

    // A shaped \`T | undefined\` member must STILL pre-register: the guard is
    // narrowed to shapeless members only, so this side of #5390 keeps working.
    export function shapedOptionalStillFlows(): number {
      const box: { value: number } | undefined = { value: 41 };
      return box === undefined ? 0 : box.value + 1;
    }
  `,
};

describe("#5348 `= {}` default parameter keeps object identity", () => {
  it("returns the identical state object when no slice reducer changed", async () => {
    const result = await compileMulti(PROJECT, "./entry.ts", {
      allowJs: true,
      platform: "node",
      skipSemanticDiagnostics: true,
      target: "gc",
    });
    const exports = await instantiate(result);

    expect((exports.sameStateObjectReturned as () => number)()).toBe(1);
    expect((exports.stableAcrossRepeatedDispatch as () => number)()).toBe(1);
    expect((exports.inlineLiteralArgumentStillWorks as () => number)()).toBe(79);
    expect((exports.shapedOptionalStillFlows as () => number)()).toBe(42);
  });
});
