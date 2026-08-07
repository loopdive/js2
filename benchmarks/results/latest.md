# js2wasm Benchmark Results

Date: 2026-08-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.047ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.141ms | 0.023ms | FAILED | js |
| string/split | 0.412ms | 5.59ms | 0.449ms | FAILED | js |
| string/replace | 0.108ms | 0.307ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.242ms | 0.110ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.947ms | 0.244ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 2.94ms | 0.287ms | FAILED | gc-native |
| array/push-pop | 1.50ms | 0.511ms | 0.510ms | FAILED | gc-native |
| array/sort-i32 | 0.795ms | 0.301ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.064ms | 0.064ms | FAILED | gc-native |
| array/reduce | 2.18ms | 0.506ms | 0.504ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 3.56ms | 3.55ms | FAILED | gc-native |
| array/slice | 0.028ms | 0.029ms | 0.030ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.087ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.242ms | 0.017ms | 0.017ms | 1.08ms | gc-native |
| dom/create-elements | 0.038ms | 0.175ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.604ms | — | — | js |
| dom/read-attributes | 0.057ms | 0.141ms | — | — | js |
| dom/modify-text | 0.051ms | 0.124ms | — | — | js |
| mixed/csv-parse | 0.485ms | 8.65ms | 0.627ms | FAILED | js |
| mixed/text-search | 0.391ms | 2.39ms | 0.331ms | FAILED | gc-native |
| mixed/fibonacci | 0.119ms | 0.118ms | 0.118ms | 0.047ms | linear-memory |
| mixed/matrix-multiply | 0.158ms | 0.192ms | 0.191ms | 0.719ms | js |
| mixed/sieve | 1.60ms | 1.41ms | 1.42ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.86 | 4.70 | 3.87 | — |
| string/concat-long | 1000 | 3.72 | 4.59 | 4.67 | — |
| string/indexOf | 1000 | 19.24 | 66.25 | 24.07 | — |
| string/includes | 1000 | 19.25 | 140.94 | 23.27 | — |
| string/split | 10000 | 41.22 | 559.44 | 44.90 | — |
| string/replace | 1000 | 107.60 | 306.98 | 82.18 | — |
| string/case-convert | 2000 | 27.88 | 120.95 | 54.99 | — |
| string/substring | 10000 | 9.94 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.04 | 94.74 | 24.41 | — |
| string/startsWith-endsWith | 20000 | 20.15 | 146.87 | 14.33 | — |
| array/map-filter | 30000 | 4.37 | 2.14 | 2.14 | — |
| array/indexOf | 1000 | 3953.22 | 3556.60 | 3554.77 | — |
| dom/create-elements | 2000 | 19.21 | 87.44 | — | — |
| dom/set-attributes | 6000 | 17.67 | 100.66 | — | — |
| dom/read-attributes | 3000 | 19.09 | 47.11 | — | — |
| dom/modify-text | 2000 | 25.56 | 61.99 | — | — |
| mixed/csv-parse | 11000 | 44.08 | 786.24 | 56.97 | — |
| mixed/text-search | 40000 | 9.77 | 59.65 | 8.28 | — |
| mixed/fibonacci | 10000 | 11.88 | 11.83 | 11.83 | 4.67 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.54 | 1.53 | 5.75 |
| mixed/sieve | 200000 | 8.00 | 7.04 | 7.08 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.64x slower | 1.35x slower | — |
| string/concat-long | 1.23x slower | 1.26x slower | — |
| string/indexOf | 3.44x slower | 1.25x slower | — |
| string/includes | 7.32x slower | 1.21x slower | — |
| string/split | 13.57x slower | 1.09x slower | — |
| string/replace | 2.85x slower | 1.31x faster | — |
| string/case-convert | 4.34x slower | 1.97x slower | — |
| string/substring | 2.64x faster | 3.23x faster | — |
| string/trim | 5.56x slower | 1.43x slower | — |
| string/startsWith-endsWith | 7.29x slower | 1.41x faster | — |
| array/push-pop | 2.93x faster | 2.94x faster | — |
| array/sort-i32 | 2.64x faster | 2.65x faster | — |
| array/map-filter | 2.04x faster | 2.04x faster | — |
| array/reduce | 4.30x faster | 4.32x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.03x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.08x faster | 3.09x faster | — |
| array/find | 14.07x faster | 14.11x faster | 4.48x slower |
| dom/create-elements | 4.55x slower | — | — |
| dom/set-attributes | 5.70x slower | — | — |
| dom/read-attributes | 2.47x slower | — | — |
| dom/modify-text | 2.42x slower | — | — |
| mixed/csv-parse | 17.84x slower | 1.29x slower | — |
| mixed/text-search | 6.11x slower | 1.18x faster | — |
| mixed/fibonacci | 1.00x faster | 1.00x faster | 2.54x faster |
| mixed/matrix-multiply | 1.22x slower | 1.21x slower | 4.54x slower |
| mixed/sieve | 1.14x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.02x slower |
| string/indexOf | 2.75x faster |
| string/includes | 6.06x faster |
| string/split | 12.46x faster |
| string/replace | 3.74x faster |
| string/case-convert | 2.20x faster |
| string/substring | 1.22x faster |
| string/trim | 3.88x faster |
| string/startsWith-endsWith | 10.25x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.80x faster |
| mixed/text-search | 7.21x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1339.1ms | 1170.7ms | — |
| string/concat-long | 671.8ms | 1022.7ms | — |
| string/indexOf | 848.2ms | 1068.9ms | — |
| string/includes | 836.0ms | 1080.3ms | — |
| string/split | 820.5ms | 1040.5ms | — |
| string/replace | 882.1ms | 1218.9ms | — |
| string/case-convert | 837.0ms | 1192.5ms | — |
| string/substring | 676.6ms | 784.2ms | — |
| string/trim | 782.0ms | 1078.6ms | — |
| string/startsWith-endsWith | 795.0ms | 1016.2ms | — |
| array/push-pop | 807.1ms | 877.6ms | — |
| array/sort-i32 | 1012.1ms | 1064.1ms | — |
| array/map-filter | 916.5ms | 1058.4ms | — |
| array/reduce | 850.2ms | 921.9ms | — |
| array/indexOf | 877.6ms | 949.2ms | — |
| array/slice | 773.8ms | 860.1ms | — |
| array/reverse | 770.8ms | 845.8ms | — |
| array/forEach | 889.2ms | 1007.1ms | — |
| array/find | 795.0ms | 847.3ms | 909.9ms |
| dom/create-elements | 639.1ms | — | — |
| dom/set-attributes | 763.7ms | — | — |
| dom/read-attributes | 709.0ms | — | — |
| dom/modify-text | 764.6ms | — | — |
| mixed/csv-parse | 831.4ms | 1076.5ms | — |
| mixed/text-search | 820.4ms | 1079.2ms | — |
| mixed/fibonacci | 824.6ms | 898.6ms | 780.4ms |
| mixed/matrix-multiply | 882.5ms | 937.9ms | 819.5ms |
| mixed/sieve | 884.7ms | 921.8ms | — |
