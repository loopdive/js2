# js2wasm Benchmark Results

Date: 2026-08-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.059ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.124ms | 0.015ms | 0.017ms | gc-native |
| string/split | 0.539ms | 4.62ms | 0.508ms | FAILED | gc-native |
| string/replace | 0.096ms | 0.219ms | 0.069ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.223ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.176ms | 0.940ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.348ms | 0.329ms | 0.559ms | gc-native |
| array/push-pop | 1.64ms | 0.599ms | 0.598ms | FAILED | gc-native |
| array/sort-i32 | 0.842ms | 0.383ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.38ms | 0.601ms | 0.591ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.039ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.553ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.136ms | — | — | js |
| dom/modify-text | 0.030ms | 0.111ms | — | — | js |
| mixed/csv-parse | 0.510ms | 6.52ms | 0.308ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.30ms | 0.292ms | 1.12ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.315ms | 0.303ms | js |
| mixed/matrix-multiply | 0.186ms | 0.210ms | 0.210ms | 0.719ms | js |
| mixed/sieve | 1.74ms | 1.51ms | 1.49ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.28 | 4.88 | 4.20 | — |
| string/concat-long | 1000 | 4.03 | 5.13 | 3.54 | — |
| string/indexOf | 1000 | 18.96 | 59.46 | 12.45 | 16.21 |
| string/includes | 1000 | 18.87 | 124.28 | 14.52 | 16.70 |
| string/split | 10000 | 53.88 | 462.38 | 50.77 | — |
| string/replace | 1000 | 95.59 | 219.09 | 68.55 | — |
| string/case-convert | 2000 | 29.13 | 111.61 | 2.61 | — |
| string/substring | 10000 | 10.40 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.56 | 93.99 | 19.66 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 17.40 | 16.45 | 27.96 |
| array/map-filter | 30000 | 4.48 | 2.19 | 2.18 | — |
| array/indexOf | 1000 | 4457.07 | 2861.32 | 2860.81 | — |
| dom/create-elements | 2000 | 19.42 | 77.17 | — | — |
| dom/set-attributes | 6000 | 17.92 | 92.14 | — | — |
| dom/read-attributes | 3000 | 19.68 | 45.23 | — | — |
| dom/modify-text | 2000 | 14.93 | 55.27 | — | — |
| mixed/csv-parse | 11000 | 46.38 | 592.53 | 27.96 | — |
| mixed/text-search | 40000 | 10.07 | 32.59 | 7.29 | 28.01 |
| mixed/fibonacci | 10000 | 12.53 | 31.50 | 31.50 | 30.30 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 8.70 | 7.56 | 7.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.28x slower | — |
| string/concat-long | 1.27x slower | 1.14x faster | — |
| string/indexOf | 3.14x slower | 1.52x faster | 1.17x faster |
| string/includes | 6.59x slower | 1.30x faster | 1.13x faster |
| string/split | 8.58x slower | 1.06x faster | — |
| string/replace | 2.29x slower | 1.39x faster | — |
| string/case-convert | 3.83x slower | 11.14x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.35x slower | 1.12x slower | — |
| string/startsWith-endsWith | 1.19x faster | 1.25x faster | 1.35x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.20x faster | 2.81x faster | — |
| array/map-filter | 2.04x faster | 2.05x faster | — |
| array/reduce | 3.96x faster | 4.03x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.14x faster | 2.21x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.85x faster | — |
| array/find | 18.49x faster | 18.38x faster | 4.44x slower |
| dom/create-elements | 3.97x slower | — | — |
| dom/set-attributes | 5.14x slower | — | — |
| dom/read-attributes | 2.30x slower | — | — |
| dom/modify-text | 3.70x slower | — | — |
| mixed/csv-parse | 12.78x slower | 1.66x faster | — |
| mixed/text-search | 3.24x slower | 1.38x faster | 2.78x slower |
| mixed/fibonacci | 2.51x slower | 2.51x slower | 2.42x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.87x slower |
| mixed/sieve | 1.15x faster | 1.16x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.78x faster |
| string/includes | 8.56x faster |
| string/split | 9.11x faster |
| string/replace | 3.20x faster |
| string/case-convert | 42.70x faster |
| string/substring | 1.16x faster |
| string/trim | 4.78x faster |
| string/startsWith-endsWith | 1.06x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.28x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 21.19x faster |
| mixed/text-search | 4.47x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.6KB | 3.9KB | — |
| string/case-convert | 1.4KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.8KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.6KB | 1.9KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 405B | 405B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1314.4ms | 1061.0ms | — |
| string/concat-long | 608.5ms | 938.3ms | — |
| string/indexOf | 646.5ms | 939.4ms | 809.7ms |
| string/includes | 636.0ms | 927.9ms | 826.3ms |
| string/split | 716.5ms | 976.8ms | — |
| string/replace | 735.1ms | 1031.2ms | — |
| string/case-convert | 734.7ms | 789.7ms | — |
| string/substring | 618.9ms | 714.4ms | — |
| string/trim | 704.6ms | 942.3ms | — |
| string/startsWith-endsWith | 746.8ms | 956.7ms | 891.3ms |
| array/push-pop | 725.6ms | 847.7ms | — |
| array/sort-i32 | 885.3ms | 911.5ms | — |
| array/map-filter | 935.8ms | 953.0ms | — |
| array/reduce | 833.6ms | 872.6ms | — |
| array/indexOf | 811.5ms | 864.9ms | — |
| array/slice | 748.2ms | 797.8ms | — |
| array/reverse | 774.6ms | 813.3ms | — |
| array/forEach | 830.1ms | 897.8ms | — |
| array/find | 722.0ms | 802.5ms | 809.7ms |
| dom/create-elements | 606.6ms | — | — |
| dom/set-attributes | 701.6ms | — | — |
| dom/read-attributes | 723.7ms | — | — |
| dom/modify-text | 602.3ms | — | — |
| mixed/csv-parse | 772.3ms | 967.6ms | — |
| mixed/text-search | 794.1ms | 974.5ms | 918.0ms |
| mixed/fibonacci | 802.4ms | 836.6ms | 764.5ms |
| mixed/matrix-multiply | 810.2ms | 893.3ms | 798.5ms |
| mixed/sieve | 817.6ms | 851.7ms | — |
