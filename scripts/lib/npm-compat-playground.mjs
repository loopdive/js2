export function summarizePlaygroundFiles(files) {
  return files.reduce(
    (counts, file) => {
      const total = file.total ?? 1;
      const passed = file.passed ?? (file.status === "pass" ? total : 0);
      counts.total += total;
      counts.pass += passed;

      if (file.status === "fail") counts.fail += Math.max(total - passed, 1);
      else if (file.status === "compile_error") counts.compile_error += total;
      else if (file.status === "skip") counts.skip += total;

      return counts;
    },
    { pass: 0, fail: 0, compile_error: 0, skip: 0, total: 0 },
  );
}
