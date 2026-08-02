# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.126ms | 0.023ms | FAILED | js |
| string/split | 0.422ms | 5.54ms | 1.44ms | FAILED | js |
| string/replace | 0.046ms | 0.214ms | 0.084ms | FAILED | js |
| string/case-convert | 0.062ms | 0.231ms | 0.112ms | FAILED | js |
| string/substring | 0.105ms | 1.92ms | 0.927ms | FAILED | js |
| string/trim | 0.174ms | 1.36ms | 0.743ms | FAILED | js |
| string/startsWith-endsWith | 0.429ms | 2.66ms | 0.527ms | FAILED | js |
| array/push-pop | 1.71ms | 2.58ms | 2.58ms | FAILED | js |
| array/sort-i32 | 0.851ms | 0.411ms | 0.414ms | FAILED | host-call |
| array/map-filter | 0.138ms | 0.692ms | 0.700ms | FAILED | js |
| array/reduce | 2.41ms | 2.53ms | 2.56ms | FAILED | js |
| array/indexOf | 4.46ms | 3.85ms | 3.85ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.026ms | 0.026ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.69ms | 3.69ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.123ms | 0.123ms | FAILED | js |
| array/find | 0.283ms | 0.510ms | 0.510ms | 4.93ms | js |
| dom/create-elements | 0.049ms | 0.288ms | — | — | js |
| dom/set-attributes | 0.113ms | 0.381ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.180ms | — | — | js |
| dom/modify-text | 0.055ms | 0.165ms | — | — | js |
| mixed/csv-parse | 0.459ms | 6.82ms | 0.804ms | FAILED | js |
| mixed/text-search | 0.408ms | 5.54ms | 1.17ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.304ms | 0.304ms | 0.302ms | js |
| mixed/matrix-multiply | 0.187ms | 0.567ms | 0.570ms | 2.04ms | js |
| mixed/sieve | 1.79ms | 1.47ms | 1.50ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
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
| string/concat-short | 10000 | 3.32 | 4.88 | 4.19 | — |
| string/concat-long | 1000 | 4.32 | 8.42 | 9.11 | — |
| string/indexOf | 1000 | 18.93 | 81.04 | 23.55 | — |
| string/includes | 1000 | 18.70 | 125.65 | 22.56 | — |
| string/split | 10000 | 42.20 | 553.54 | 144.28 | — |
| string/replace | 1000 | 46.12 | 213.91 | 83.53 | — |
| string/case-convert | 2000 | 31.14 | 115.29 | 56.02 | — |
| string/substring | 10000 | 10.47 | 191.91 | 92.66 | — |
| string/trim | 10000 | 17.41 | 136.19 | 74.30 | — |
| string/startsWith-endsWith | 20000 | 21.43 | 133.19 | 26.34 | — |
| mixed/csv-parse | 11000 | 41.69 | 619.91 | 73.08 | — |
| mixed/text-search | 40000 | 10.20 | 138.41 | 29.17 | — |
| mixed/fibonacci | 10000 | 12.53 | 30.44 | 30.43 | 30.19 |
| mixed/matrix-multiply | 125000 | 1.50 | 4.54 | 4.56 | 16.28 |
| mixed/sieve | 200000 | 8.93 | 7.35 | 7.52 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.26x slower | — |
| string/concat-long | 1.95x slower | 2.11x slower | — |
| string/indexOf | 4.28x slower | 1.24x slower | — |
| string/includes | 6.72x slower | 1.21x slower | — |
| string/split | 13.12x slower | 3.42x slower | — |
| string/replace | 4.64x slower | 1.81x slower | — |
| string/case-convert | 3.70x slower | 1.80x slower | — |
| string/substring | 18.33x slower | 8.85x slower | — |
| string/trim | 7.82x slower | 4.27x slower | — |
| string/startsWith-endsWith | 6.22x slower | 1.23x slower | — |
| array/push-pop | 1.51x slower | 1.51x slower | — |
| array/sort-i32 | 2.07x faster | 2.06x faster | — |
| array/map-filter | 5.02x slower | 5.08x slower | — |
| array/reduce | 1.05x slower | 1.07x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.41x faster | 1.40x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.31x slower | 2.31x slower | — |
| array/find | 1.80x slower | 1.80x slower | 17.42x slower |
| dom/create-elements | 5.91x slower | — | — |
| dom/set-attributes | 3.38x slower | — | — |
| dom/read-attributes | 2.96x slower | — | — |
| dom/modify-text | 2.99x slower | — | — |
| mixed/csv-parse | 14.87x slower | 1.75x slower | — |
| mixed/text-search | 13.57x slower | 2.86x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.41x slower |
| mixed/matrix-multiply | 3.03x slower | 3.05x slower | 10.89x slower |
| mixed/sieve | 1.21x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 3.44x faster |
| string/includes | 5.57x faster |
| string/split | 3.84x faster |
| string/replace | 2.56x faster |
| string/case-convert | 2.06x faster |
| string/substring | 2.07x faster |
| string/trim | 1.83x faster |
| string/startsWith-endsWith | 5.06x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.48x faster |
| mixed/text-search | 4.74x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 233B | 964B | — |
| string/indexOf | 412B | 1.3KB | — |
| string/includes | 398B | 1.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 1.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 297B | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1258.4ms | 1053.6ms | — |
| string/concat-long | 604.4ms | 939.5ms | — |
| string/indexOf | 755.9ms | 1001.0ms | — |
| string/includes | 755.3ms | 984.0ms | — |
| string/split | 823.5ms | 1036.8ms | — |
| string/replace | 805.5ms | 1076.5ms | — |
| string/case-convert | 814.7ms | 1153.8ms | — |
| string/substring | 707.5ms | 974.1ms | — |
| string/trim | 821.5ms | 1033.1ms | — |
| string/startsWith-endsWith | 822.7ms | 989.6ms | — |
| array/push-pop | 767.6ms | 807.0ms | — |
| array/sort-i32 | 961.1ms | 1005.8ms | — |
| array/map-filter | 975.4ms | 994.3ms | — |
| array/reduce | 852.4ms | 919.4ms | — |
| array/indexOf | 776.7ms | 792.0ms | — |
| array/slice | 744.1ms | 837.0ms | — |
| array/reverse | 744.0ms | 797.6ms | — |
| array/forEach | 860.4ms | 938.1ms | — |
| array/find | 884.5ms | 946.0ms | 845.8ms |
| dom/create-elements | 637.8ms | — | — |
| dom/set-attributes | 745.9ms | — | — |
| dom/read-attributes | 693.2ms | — | — |
| dom/modify-text | 698.6ms | — | — |
| mixed/csv-parse | 861.6ms | 988.3ms | — |
| mixed/text-search | 804.1ms | 1006.4ms | — |
| mixed/fibonacci | 798.1ms | 835.4ms | 794.2ms |
| mixed/matrix-multiply | 894.0ms | 965.7ms | 779.1ms |
| mixed/sieve | 807.7ms | 842.7ms | — |
