export { value, bump, calculate, __module_init } from "./entry-scalar";
export async function twoAwait(x: number): Promise<number> {
  const first = await Promise.resolve(x + 1);
  const second = await Promise.resolve(first * 2);
  return second + 3;
}
