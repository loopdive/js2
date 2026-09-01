import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const budgetBytes = 18 * 1024 * 1024;
const files = ["README.md", "LICENSE", "package.json", "jsr.json"];
const directories = ["dist"];

while (directories.length > 0) {
  const directory = directories.pop();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) directories.push(path);
    else if (entry.isFile() && (path.endsWith(".js") || path.endsWith(".d.ts"))) files.push(path);
  }
}

const sizes = files.map((path) => ({ path, bytes: statSync(path).size }));
const totalBytes = sizes.reduce((total, file) => total + file.bytes, 0);
const largest = sizes.reduce((current, file) => (file.bytes > current.bytes ? file : current));

console.log(
  `JSR package budget: ${totalBytes.toLocaleString()} / ${budgetBytes.toLocaleString()} bytes; largest file: ${largest.path} (${largest.bytes.toLocaleString()} bytes)`,
);

if (totalBytes >= budgetBytes) {
  console.error(
    "JSR package exceeds the 18 MiB release budget (2 MiB below the registry hard cap). Refusing to publish.",
  );
  process.exit(1);
}
