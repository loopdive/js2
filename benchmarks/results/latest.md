# js2wasm Benchmark Results

Date: 2026-09-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.054ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.021ms | gc-native |
| string/includes | 0.019ms | 0.122ms | 0.014ms | 0.025ms | gc-native |
| string/split | 0.422ms | 7.86ms | 2.60ms | FAILED | js |
| string/replace | 0.097ms | 0.584ms | 0.275ms | FAILED | js |
| string/case-convert | 0.058ms | 0.513ms | 0.237ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.19ms | 2.35ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.48ms | 2.46ms | 0.564ms | js |
| array/push-pop | 1.64ms | 0.602ms | 0.594ms | FAILED | gc-native |
| array/sort-i32 | 0.838ms | 0.317ms | 0.302ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.58ms | 0.593ms | 0.605ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.092ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | gc-native |
| dom/create-elements | 0.034ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.537ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.133ms | — | — | js |
| dom/modify-text | 0.029ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.470ms | 7.80ms | 1.12ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.18ms | 2.47ms | 1.12ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 1.41ms | js |
| mixed/matrix-multiply | 0.184ms | 66.28ms | 66.11ms | 0.723ms | js |
| mixed/sieve | 1.82ms | 2.28ms | 2.30ms | FAILED | js |

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
| string/concat-short | 10000 | 3.37 | 5.39 | 4.94 | — |
| string/concat-long | 1000 | 4.26 | 5.30 | 3.49 | — |
| string/indexOf | 1000 | 18.94 | 59.90 | 12.18 | 20.62 |
| string/includes | 1000 | 18.67 | 122.28 | 13.76 | 25.10 |
| string/split | 10000 | 42.18 | 785.79 | 260.13 | — |
| string/replace | 1000 | 96.90 | 583.79 | 275.21 | — |
| string/case-convert | 2000 | 28.94 | 256.49 | 118.50 | — |
| string/substring | 10000 | 10.39 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.29 | 319.49 | 234.68 | — |
| string/startsWith-endsWith | 20000 | 20.66 | 124.04 | 123.00 | 28.22 |
| array/map-filter | 30000 | 4.43 | 2.17 | 2.17 | — |
| array/indexOf | 1000 | 4456.54 | 2862.63 | 2862.17 | — |
| dom/create-elements | 2000 | 17.12 | 77.55 | — | — |
| dom/set-attributes | 6000 | 17.95 | 89.54 | — | — |
| dom/read-attributes | 3000 | 19.37 | 44.28 | — | — |
| dom/modify-text | 2000 | 14.68 | 56.71 | — | — |
| mixed/csv-parse | 11000 | 42.70 | 709.02 | 102.00 | — |
| mixed/text-search | 40000 | 10.07 | 104.41 | 61.64 | 27.94 |
| mixed/fibonacci | 10000 | 12.53 | 32.75 | 32.74 | 140.88 |
| mixed/matrix-multiply | 125000 | 1.47 | 530.24 | 528.85 | 5.78 |
| mixed/sieve | 200000 | 9.10 | 11.42 | 11.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.60x slower | 1.47x slower | — |
| string/concat-long | 1.25x slower | 1.22x faster | — |
| string/indexOf | 3.16x slower | 1.56x faster | 1.09x slower |
| string/includes | 6.55x slower | 1.36x faster | 1.34x slower |
| string/split | 18.63x slower | 6.17x slower | — |
| string/replace | 6.02x slower | 2.84x slower | — |
| string/case-convert | 8.86x slower | 4.09x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 18.48x slower | 13.57x slower | — |
| string/startsWith-endsWith | 6.00x slower | 5.95x slower | 1.37x slower |
| array/push-pop | 2.72x faster | 2.76x faster | — |
| array/sort-i32 | 2.65x faster | 2.77x faster | — |
| array/map-filter | 2.04x faster | 2.04x faster | — |
| array/reduce | 2.66x faster | 2.61x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.01x faster | 1.99x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.21x faster | 3.22x faster | — |
| array/find | 18.44x faster | 18.45x faster | 4.45x slower |
| dom/create-elements | 4.53x slower | — | — |
| dom/set-attributes | 4.99x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.86x slower | — | — |
| mixed/csv-parse | 16.60x slower | 2.39x slower | — |
| mixed/text-search | 10.37x slower | 6.12x slower | 2.77x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 11.24x slower |
| mixed/matrix-multiply | 360.35x slower | 359.40x slower | 3.93x slower |
| mixed/sieve | 1.26x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.52x faster |
| string/indexOf | 4.92x faster |
| string/includes | 8.89x faster |
| string/split | 3.02x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.16x faster |
| string/substring | 1.16x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.05x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 6.95x faster |
| mixed/text-search | 1.69x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1567.5ms | 1045.3ms | — |
| string/concat-long | 739.6ms | 951.7ms | — |
| string/indexOf | 635.3ms | 914.9ms | 823.0ms |
| string/includes | 634.9ms | 925.6ms | 853.8ms |
| string/split | 737.9ms | 940.0ms | — |
| string/replace | 752.5ms | 1011.1ms | — |
| string/case-convert | 761.9ms | 829.0ms | — |
| string/substring | 634.1ms | 725.2ms | — |
| string/trim | 735.3ms | 938.5ms | — |
| string/startsWith-endsWith | 729.7ms | 969.5ms | 893.9ms |
| array/push-pop | 766.2ms | 863.6ms | — |
| array/sort-i32 | 927.1ms | 1004.8ms | — |
| array/map-filter | 939.3ms | 953.8ms | — |
| array/reduce | 838.1ms | 942.9ms | — |
| array/indexOf | 837.3ms | 908.9ms | — |
| array/slice | 763.4ms | 844.5ms | — |
| array/reverse | 735.8ms | 864.7ms | — |
| array/forEach | 874.3ms | 988.2ms | — |
| array/find | 745.7ms | 814.7ms | 823.5ms |
| dom/create-elements | 678.9ms | — | — |
| dom/set-attributes | 720.9ms | — | — |
| dom/read-attributes | 680.6ms | — | — |
| dom/modify-text | 658.6ms | — | — |
| mixed/csv-parse | 782.1ms | 925.7ms | — |
| mixed/text-search | 783.1ms | 971.9ms | 877.5ms |
| mixed/fibonacci | 725.6ms | 779.9ms | 724.4ms |
| mixed/matrix-multiply | 895.4ms | 950.1ms | 798.1ms |
| mixed/sieve | 831.0ms | 809.2ms | — |
