// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4544 Part A — the Node startup denominator.
//
// Instantiates the same emitted `.wasm` under Node and calls `run`. This exists
// only as CONTEXT for the startup numbers: Node's own boot dominates, so this
// is not a lane anyone would ship a native binary as — it is the "what does the
// JS host cost" side of the ratio.
import { readFileSync } from "node:fs";

const [, , wasmPath, argText] = process.argv;
const mod = new WebAssembly.Module(readFileSync(wasmPath));
const inst = new WebAssembly.Instance(mod, {});
process.stdout.write(`${inst.exports.run(Number(argText ?? 0))}\n`);
