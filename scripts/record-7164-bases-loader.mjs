// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7164) Loader for scripts/record-7164-bases.mts: tests/equivalence/helpers.ts
// imports `vitest`, which refuses to load outside a test run. Resolve it to an
// inert stub instead.
import { register } from "node:module";

const STUB =
  "data:text/javascript,export const expect=()=>{throw new Error('expect stub')};" +
  "export const it=()=>{};export const describe=()=>{};export const test=()=>{};export const beforeAll=()=>{};";

export async function resolve(specifier, context, next) {
  if (specifier === "vitest") return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}

if (!process.env.JS2WASM_7164_LOADER) {
  process.env.JS2WASM_7164_LOADER = "1";
  register(import.meta.url);
}
