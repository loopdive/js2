// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import {
  beforeRuntimePreparationRelocation,
  runtimePreparationRelocationCurrentPaths,
} from "./ir-runtime-preparation-relocation.js";

type Reader = (path: string) => string;
const [support, implementation] = runtimePreparationRelocationCurrentPaths;
const currentPin = {
  bytes: 49704,
  sha256: "171aa93513aacb9bebf80897f2c67a827b71f082647ced04a689ca17d116ba82",
} as const;
const priorPin = {
  bytes: 49541,
  sha256: "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",
} as const;
const edits = [
  {
    beforeOffset: 1142,
    afterOffset: 1142,
    before: "",
    after: 'import { irNumberRemainderCallableDeclaration } from "./number-remainder-callables.js";\n',
  },
  {
    beforeOffset: 39459,
    afterOffset: 39547,
    before: "                  irOrdinaryObjectCallableDeclaration(declaration.ref))\n",
    after:
      "                  irOrdinaryObjectCallableDeclaration(declaration.ref) ||\n                  irNumberRemainderCallableDeclaration(declaration.ref))\n",
  },
] as const;
function fail(detail: string): never {
  throw new Error("remainder runtime preparation relocation: " + detail);
}
function pin(bytes: Buffer, expected: typeof currentPin | typeof priorPin): void {
  if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
    fail("complete source SHA256/length mismatch: " + implementation);
}
function priorCurrentSource(source: string): string {
  if (typeof source !== "string" || source.length === 0) fail("missing nonempty source: " + implementation);
  const current = Buffer.from(source);
  pin(current, currentPin);
  const inverse: Buffer[] = [];
  let cursor = 0;
  for (const edit of edits) {
    const after = Buffer.from(edit.after);
    if (!current.subarray(edit.afterOffset, edit.afterOffset + after.length).equals(after))
      fail("fixed current source span mismatch: " + implementation);
    inverse.push(current.subarray(cursor, edit.afterOffset), Buffer.from(edit.before));
    cursor = edit.afterOffset + after.length;
  }
  inverse.push(current.subarray(cursor));
  const previous = Buffer.concat(inverse);
  pin(previous, priorPin);
  const replay: Buffer[] = [];
  cursor = 0;
  for (const edit of edits) {
    const before = Buffer.from(edit.before);
    if (!previous.subarray(edit.beforeOffset, edit.beforeOffset + before.length).equals(before))
      fail("fixed prior source span mismatch: " + implementation);
    replay.push(previous.subarray(cursor, edit.beforeOffset), Buffer.from(edit.after));
    cursor = edit.beforeOffset + before.length;
  }
  replay.push(previous.subarray(cursor));
  const forward = Buffer.concat(replay);
  pin(forward, currentPin);
  if (!forward.equals(current)) fail("current source reciprocal mismatch: " + implementation);
  return previous.toString("utf8");
}
/** Historical test readers only: keep live/unknown reads on the supplied current-source channel. */
export function beforeRemainderRuntimePreparationRelocation(rawRead: Reader): Reader {
  if (typeof rawRead !== "function") fail("supplied reader required");
  const historical = beforeRuntimePreparationRelocation((path) => {
    const source = rawRead(path);
    return path === implementation ? priorCurrentSource(source) : source;
  });
  return (path) => (path === support ? historical(path) : rawRead(path));
}
