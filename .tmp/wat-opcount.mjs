// Count opcodes inside a named function of a .wat dump, so the "why" behind the
// linear-vs-GC numbers is mechanical rather than anecdotal.
// Usage: npx tsx .tmp/wat-opcount.mjs <file.wat> <funcName> [op...]
import { readFileSync } from "node:fs";

const [file, fn] = process.argv.slice(2);
const ops = process.argv.slice(4);
const lines = readFileSync(file, "utf8").split("\n");
const start = lines.findIndex((l) => l.trimStart().startsWith(`(func ${fn} `) || l.trimStart().startsWith(`(func ${fn}\n`));
if (start < 0) {
  console.error("function not found:", fn);
  process.exit(1);
}
let depth = 0;
let end = start;
for (let i = start; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  if (depth <= 0) {
    end = i;
    break;
  }
}
const body = lines.slice(start, end + 1).join("\n");
const DEFAULT = [
  "array.get_u",
  "array.get",
  "array.new",
  "array.len",
  "struct.get",
  "struct.set",
  "struct.new",
  "ref.cast",
  "ref.as_non_null",
  "ref.test",
  "ref.is_null",
  "i32.load8_u",
  "i32.load16_u",
  "i32.load",
  "i32.store",
  "i64.load",
  "f64.load",
  "memory.grow",
  "memory.size",
  "call ",
  "call_indirect",
  "call_ref",
  "loop",
  "block",
  "br_if",
];
const counts = {};
for (const op of ops.length ? ops : DEFAULT) {
  const n = (body.match(new RegExp(op.replace(/[.$]/g, "\\$&"), "g")) ?? []).length;
  if (n) counts[op.trim()] = n;
}
console.log(`${file}  ${fn}   lines=${end - start + 1}`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(16)} ${v}`);
