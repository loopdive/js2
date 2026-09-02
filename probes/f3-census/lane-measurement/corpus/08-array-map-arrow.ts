export function entry(n: number): number {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i);
  const ys = xs.map((v: number): number => v * v);
  let s = 0;
  for (const y of ys) s += y;
  return s;
}
