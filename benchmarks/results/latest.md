# js2wasm Benchmark Results

Date: 2026-09-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.051ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.061ms | 0.012ms | 0.032ms | gc-native |
| string/includes | 0.019ms | 0.042ms | 0.014ms | 0.034ms | gc-native |
| string/split | 0.420ms | 7.55ms | 2.68ms | FAILED | js |
| string/replace | 0.094ms | 0.578ms | 0.272ms | FAILED | js |
| string/case-convert | 0.058ms | 0.535ms | 0.244ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.17ms | 2.33ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.45ms | 2.47ms | 0.554ms | js |
| array/push-pop | 1.63ms | 0.593ms | 0.596ms | FAILED | host-call |
| array/sort-i32 | 0.838ms | 0.559ms | 0.296ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 2.38ms | 0.609ms | 0.597ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.093ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.270ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | 0.159ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.535ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.466ms | 8.81ms | 1.11ms | FAILED | js |
| mixed/text-search | 0.403ms | 3.98ms | 2.43ms | 1.13ms | js |
| mixed/fibonacci | 0.126ms | 0.327ms | 0.327ms | 1.41ms | js |
| mixed/matrix-multiply | 0.184ms | 72.30ms | 70.89ms | 0.715ms | js |
| mixed/sieve | 1.74ms | 2.29ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.31 | 5.13 | 4.48 | — |
| string/concat-long | 1000 | 4.11 | 5.34 | 3.46 | — |
| string/indexOf | 1000 | 18.91 | 60.90 | 12.22 | 31.53 |
| string/includes | 1000 | 18.66 | 42.05 | 13.86 | 34.07 |
| string/split | 10000 | 42.05 | 754.51 | 267.88 | — |
| string/replace | 1000 | 94.45 | 577.65 | 271.70 | — |
| string/case-convert | 2000 | 28.99 | 267.57 | 122.14 | — |
| string/substring | 10000 | 10.40 | 4.00 | 3.43 | — |
| string/trim | 10000 | 17.31 | 317.03 | 232.86 | — |
| string/startsWith-endsWith | 20000 | 20.59 | 122.32 | 123.30 | 27.69 |
| array/map-filter | 30000 | 4.45 | 2.16 | 2.17 | — |
| array/indexOf | 1000 | 4458.37 | 2862.91 | 2860.81 | — |
| dom/create-elements | 2000 | 18.85 | 79.72 | — | — |
| dom/set-attributes | 6000 | 17.90 | 89.17 | — | — |
| dom/read-attributes | 3000 | 19.56 | 44.68 | — | — |
| dom/modify-text | 2000 | 14.66 | 57.74 | — | — |
| mixed/csv-parse | 11000 | 42.37 | 801.11 | 101.30 | — |
| mixed/text-search | 40000 | 10.06 | 99.52 | 60.66 | 28.30 |
| mixed/fibonacci | 10000 | 12.60 | 32.74 | 32.74 | 140.80 |
| mixed/matrix-multiply | 125000 | 1.47 | 578.38 | 567.14 | 5.72 |
| mixed/sieve | 200000 | 8.71 | 11.44 | 11.61 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.55x slower | 1.35x slower | — |
| string/concat-long | 1.30x slower | 1.19x faster | — |
| string/indexOf | 3.22x slower | 1.55x faster | 1.67x slower |
| string/includes | 2.25x slower | 1.35x faster | 1.83x slower |
| string/split | 17.94x slower | 6.37x slower | — |
| string/replace | 6.12x slower | 2.88x slower | — |
| string/case-convert | 9.23x slower | 4.21x slower | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 18.32x slower | 13.45x slower | — |
| string/startsWith-endsWith | 5.94x slower | 5.99x slower | 1.34x slower |
| array/push-pop | 2.75x faster | 2.73x faster | — |
| array/sort-i32 | 1.50x faster | 2.83x faster | — |
| array/map-filter | 2.06x faster | 2.05x faster | — |
| array/reduce | 3.90x faster | 3.98x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.12x faster | 2.06x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.29x faster | 3.28x faster | — |
| array/find | 18.58x faster | 18.55x faster | 4.46x slower |
| dom/create-elements | 4.23x slower | — | — |
| dom/set-attributes | 4.98x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.94x slower | — | — |
| mixed/csv-parse | 18.91x slower | 2.39x slower | — |
| mixed/text-search | 9.89x slower | 6.03x slower | 2.81x slower |
| mixed/fibonacci | 2.60x slower | 2.60x slower | 11.17x slower |
| mixed/matrix-multiply | 392.56x slower | 384.93x slower | 3.88x slower |
| mixed/sieve | 1.31x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.54x faster |
| string/indexOf | 4.98x faster |
| string/includes | 3.03x faster |
| string/split | 2.82x faster |
| string/replace | 2.13x faster |
| string/case-convert | 2.19x faster |
| string/substring | 1.16x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.89x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 7.91x faster |
| mixed/text-search | 1.64x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x faster |
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
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
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
| string/concat-short | 1589.3ms | 1056.8ms | — |
| string/concat-long | 755.3ms | 947.3ms | — |
| string/indexOf | 675.0ms | 939.3ms | 843.8ms |
| string/includes | 649.3ms | 960.4ms | 809.5ms |
| string/split | 806.0ms | 962.8ms | — |
| string/replace | 770.2ms | 1036.5ms | — |
| string/case-convert | 773.1ms | 830.2ms | — |
| string/substring | 644.5ms | 764.1ms | — |
| string/trim | 725.1ms | 945.6ms | — |
| string/startsWith-endsWith | 751.4ms | 948.6ms | 878.9ms |
| array/push-pop | 754.4ms | 833.2ms | — |
| array/sort-i32 | 899.6ms | 970.6ms | — |
| array/map-filter | 919.8ms | 990.8ms | — |
| array/reduce | 868.8ms | 941.4ms | — |
| array/indexOf | 848.4ms | 929.6ms | — |
| array/slice | 771.0ms | 842.0ms | — |
| array/reverse | 738.4ms | 843.9ms | — |
| array/forEach | 867.3ms | 954.9ms | — |
| array/find | 730.9ms | 838.3ms | 800.6ms |
| dom/create-elements | 699.8ms | — | — |
| dom/set-attributes | 709.4ms | — | — |
| dom/read-attributes | 681.4ms | — | — |
| dom/modify-text | 647.0ms | — | — |
| mixed/csv-parse | 753.2ms | 917.1ms | — |
| mixed/text-search | 752.0ms | 955.0ms | 874.6ms |
| mixed/fibonacci | 754.8ms | 764.9ms | 738.5ms |
| mixed/matrix-multiply | 879.0ms | 938.6ms | 785.6ms |
| mixed/sieve | 857.4ms | 907.0ms | — |
