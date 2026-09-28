// Finite-domain enumeration for Situation product types (core.md §6.1).

/** One list of admissible values per field of `T`. */
export type Domain<T> = { readonly [K in keyof T]-?: readonly T[K][] };

export function domainSize<T>(d: Domain<T>): number {
  let n = 1;
  for (const k of Object.keys(d) as (keyof T)[]) n *= d[k].length;
  return n;
}

/** Decode the `index`-th value of the product in mixed radix (last key varies fastest). */
export function valueAt<T>(d: Domain<T>, index: number): T {
  const keys = Object.keys(d) as (keyof T)[];
  const out: Partial<T> = {};
  let rest = index;
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i] as keyof T;
    const values = d[k];
    const v = values[rest % values.length];
    if (v === undefined) throw new Error("valueAt: empty domain");
    out[k] = v;
    rest = Math.floor(rest / values.length);
  }
  return out as T;
}

/** Every value of the product, in index order. */
export function* enumerate<T>(d: Domain<T>): Generator<T> {
  const size = domainSize(d);
  for (let i = 0; i < size; i++) yield valueAt(d, i);
}

/**
 * Systematic subset: the baseline, then every value of each single field against the baseline,
 * then the full product over `combo` fields (other fields at baseline). Duplicates removed.
 */
export function systematicSubset<T extends object>(d: Domain<T>, baseline: T, combo: readonly (keyof T)[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const add = (v: T): void => {
    const key = JSON.stringify(v);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  };
  add(baseline);
  for (const k of Object.keys(d) as (keyof T)[]) for (const v of d[k]) add({ ...baseline, [k]: v });
  const sub = {} as { [K in keyof T]: readonly T[K][] };
  for (const k of Object.keys(d) as (keyof T)[]) sub[k] = combo.includes(k) ? d[k] : [baseline[k]];
  for (const v of enumerate(sub as Domain<T>)) add(v);
  return out;
}
