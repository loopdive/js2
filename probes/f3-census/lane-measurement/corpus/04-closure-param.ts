export function entry(base: number, n: number): number {
  const addBase = (k: number): number => base + k;
  let s = 0;
  for (let i = 0; i < n; i++) s += addBase(i);
  return s;
}
