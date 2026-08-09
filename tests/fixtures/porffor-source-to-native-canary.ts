export function porfforSourceNativeCanary(seed: number): number {
  const first = { x: seed, y: seed + 1 };
  const second = { x: seed + 3, y: 5 };
  const alias = first;
  alias.x = alias.x + 2;
  return first.x * 100 + second.x * 10 + second.y;
}
