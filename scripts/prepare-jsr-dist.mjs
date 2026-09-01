import { existsSync, readFileSync, writeFileSync } from "node:fs";

const entries = ["index", "runtime", "optimize"];

for (const entry of entries) {
  const javascriptPath = `dist/${entry}.js`;
  const declarationPath = `dist/${entry}.d.ts`;
  if (!existsSync(javascriptPath) || !existsSync(declarationPath)) {
    throw new Error(`JSR build is missing ${javascriptPath} or ${declarationPath}`);
  }

  const source = readFileSync(javascriptPath, "utf8");
  if (source.includes("@ts-self-types")) {
    throw new Error(`JSR build already contains an unexpected @ts-self-types directive in ${javascriptPath}`);
  }

  const directive = `/* @ts-self-types="./${entry}.d.ts" */`;
  writeFileSync(javascriptPath, `${directive}\n${source}`);
}
