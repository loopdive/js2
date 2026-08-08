# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.046ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.154ms | 0.023ms | FAILED | js |
| string/split | 0.412ms | 5.76ms | 0.449ms | FAILED | js |
| string/replace | 0.103ms | 0.310ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.234ms | 0.110ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.918ms | 0.248ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.91ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.44ms | 0.501ms | 0.503ms | FAILED | host-call |
| array/sort-i32 | 0.789ms | 0.299ms | 0.299ms | FAILED | gc-native |
| array/map-filter | 0.124ms | 0.067ms | 0.067ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.499ms | 0.500ms | FAILED | host-call |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | host-call |
| array/slice | 0.026ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.238ms | 0.017ms | 0.016ms | 1.01ms | gc-native |
| dom/create-elements | 0.191ms | 0.181ms | — | — | host-call |
| dom/set-attributes | 0.106ms | 0.526ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.164ms | — | — | js |
| dom/modify-text | 0.049ms | 0.130ms | — | — | js |
| mixed/csv-parse | 0.478ms | 8.46ms | 0.612ms | FAILED | js |
| mixed/text-search | 0.397ms | 2.39ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.088ms | linear-memory |
| mixed/matrix-multiply | 0.157ms | 0.203ms | 0.192ms | 0.720ms | js |
| mixed/sieve | 1.55ms | 1.39ms | 1.39ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.06 | 4.57 | 3.93 | — |
| string/concat-long | 1000 | 3.59 | 4.51 | 4.60 | — |
| string/indexOf | 1000 | 19.16 | 65.78 | 23.88 | — |
| string/includes | 1000 | 19.17 | 154.03 | 23.39 | — |
| string/split | 10000 | 41.21 | 575.53 | 44.88 | — |
| string/replace | 1000 | 103.11 | 310.25 | 81.76 | — |
| string/case-convert | 2000 | 27.87 | 116.97 | 55.22 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.08 | — |
| string/trim | 10000 | 16.95 | 91.77 | 24.77 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 145.26 | 14.32 | — |
| array/map-filter | 30000 | 4.15 | 2.25 | 2.25 | — |
| array/indexOf | 1000 | 3948.38 | 3549.55 | 3550.85 | — |
| dom/create-elements | 2000 | 95.48 | 90.40 | — | — |
| dom/set-attributes | 6000 | 17.64 | 87.60 | — | — |
| dom/read-attributes | 3000 | 18.76 | 54.61 | — | — |
| dom/modify-text | 2000 | 24.52 | 64.92 | — | — |
| mixed/csv-parse | 11000 | 43.50 | 769.52 | 55.63 | — |
| mixed/text-search | 40000 | 9.92 | 59.86 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.17 | 11.83 | 11.82 | 8.84 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.62 | 1.53 | 5.76 |
| mixed/sieve | 200000 | 7.75 | 6.93 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.29x slower | — |
| string/concat-long | 1.26x slower | 1.28x slower | — |
| string/indexOf | 3.43x slower | 1.25x slower | — |
| string/includes | 8.03x slower | 1.22x slower | — |
| string/split | 13.97x slower | 1.09x slower | — |
| string/replace | 3.01x slower | 1.26x faster | — |
| string/case-convert | 4.20x slower | 1.98x slower | — |
| string/substring | 2.64x faster | 3.20x faster | — |
| string/trim | 5.42x slower | 1.46x slower | — |
| string/startsWith-endsWith | 7.23x slower | 1.40x faster | — |
| array/push-pop | 2.87x faster | 2.86x faster | — |
| array/sort-i32 | 2.64x faster | 2.64x faster | — |
| array/map-filter | 1.84x faster | 1.84x faster | — |
| array/reduce | 4.28x faster | 4.28x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.05x slower | 1.04x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 14.34x faster | 14.43x faster | 4.24x slower |
| dom/create-elements | 1.06x faster | — | — |
| dom/set-attributes | 4.97x slower | — | — |
| dom/read-attributes | 2.91x slower | — | — |
| dom/modify-text | 2.65x slower | — | — |
| mixed/csv-parse | 17.69x slower | 1.28x slower | — |
| mixed/text-search | 6.04x slower | 1.21x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 1.38x faster |
| mixed/matrix-multiply | 1.29x slower | 1.22x slower | 4.58x slower |
| mixed/sieve | 1.12x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.02x slower |
| string/indexOf | 2.75x faster |
| string/includes | 6.58x faster |
| string/split | 12.82x faster |
| string/replace | 3.79x faster |
| string/case-convert | 2.12x faster |
| string/substring | 1.21x faster |
| string/trim | 3.71x faster |
| string/startsWith-endsWith | 10.14x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.83x faster |
| mixed/text-search | 7.30x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x faster |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1258.6ms | 1097.8ms | — |
| string/concat-long | 622.0ms | 973.3ms | — |
| string/indexOf | 765.7ms | 983.3ms | — |
| string/includes | 751.6ms | 1026.9ms | — |
| string/split | 758.3ms | 992.3ms | — |
| string/replace | 822.0ms | 1096.5ms | — |
| string/case-convert | 802.4ms | 1110.0ms | — |
| string/substring | 639.2ms | 720.5ms | — |
| string/trim | 698.3ms | 1021.7ms | — |
| string/startsWith-endsWith | 730.9ms | 974.8ms | — |
| array/push-pop | 768.1ms | 805.7ms | — |
| array/sort-i32 | 939.6ms | 949.3ms | — |
| array/map-filter | 878.6ms | 993.8ms | — |
| array/reduce | 814.8ms | 852.2ms | — |
| array/indexOf | 803.6ms | 888.4ms | — |
| array/slice | 744.1ms | 813.6ms | — |
| array/reverse | 755.4ms | 802.6ms | — |
| array/forEach | 834.9ms | 913.8ms | — |
| array/find | 731.4ms | 795.7ms | 808.9ms |
| dom/create-elements | 662.4ms | — | — |
| dom/set-attributes | 728.3ms | — | — |
| dom/read-attributes | 770.0ms | — | — |
| dom/modify-text | 677.2ms | — | — |
| mixed/csv-parse | 801.3ms | 964.6ms | — |
| mixed/text-search | 729.5ms | 1029.5ms | — |
| mixed/fibonacci | 778.1ms | 851.9ms | 726.4ms |
| mixed/matrix-multiply | 876.1ms | 892.1ms | 781.7ms |
| mixed/sieve | 828.6ms | 886.1ms | — |
