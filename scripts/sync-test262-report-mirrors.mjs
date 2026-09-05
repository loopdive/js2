import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const lanes = [
  {
    name: "host",
    source: "benchmarks/results/test262-current.json",
    targets: [
      "benchmarks/results/test262-report.json",
      "public/benchmarks/results/test262-report.json",
      "website/public/benchmarks/results/test262-report.json",
    ],
  },
  {
    name: "standalone",
    source: "benchmarks/results/test262-standalone-current.json",
    targets: [
      "benchmarks/results/test262-standalone-report.json",
      "public/benchmarks/results/test262-standalone-report.json",
      "website/public/benchmarks/results/test262-standalone-report.json",
    ],
  },
];

let synced = 0;

for (const lane of lanes) {
  const source = resolve(ROOT, lane.source);
  if (!existsSync(source)) {
    console.warn(`Skipping ${lane.name} Test262 report mirror: ${lane.source} is absent`);
    continue;
  }

  for (const targetPath of lane.targets) {
    const target = resolve(ROOT, targetPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    synced += 1;
  }
}

if (synced === 0) {
  throw new Error("No Test262 current report snapshots were found to mirror");
}

console.log(`Synchronized ${synced} Test262 report mirrors from canonical snapshots.`);
