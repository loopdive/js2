// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6697 — out-of-process compiler for tests/issue-3520-closure-host-bridge-abi.test.ts.
// A standalone/WASI compile loads its own lib set and pushes the 512 MB Vitest
// fork over its heap limit (measured: 413 MB after the test file loads, 596 MB
// at the first standalone test). The test sends its compile jobs here, run with
// an explicit heap, and instantiates the returned binaries in-process.
// Reads a JSON array of { source, options } on stdin; prints a JSON array of
// the serialisable CompileResult fields the test reads.
import { compile } from "../../src/index.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const jobs = JSON.parse(input) as { source: string; options: Record<string, unknown> }[];
const out = [];
for (const job of jobs) {
  const r = await compile(job.source, job.options as never);
  out.push({
    success: r.success,
    errors: r.errors.map((error) => ({ message: error.message, severity: error.severity })),
    imports: r.imports,
    stringPool: r.stringPool,
    binary: Buffer.from(r.binary).toString("base64"),
  });
}
process.stdout.write(JSON.stringify(out));
