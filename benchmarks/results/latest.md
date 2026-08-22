# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.050ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.024ms | gc-native |
| string/includes | 0.019ms | 0.125ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.422ms | 4.52ms | 0.505ms | FAILED | js |
| string/replace | 0.095ms | 0.234ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.223ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.935ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.341ms | 0.308ms | 0.560ms | gc-native |
| array/push-pop | 1.67ms | 0.605ms | 0.614ms | FAILED | host-call |
| array/sort-i32 | 0.848ms | 0.295ms | 0.554ms | FAILED | host-call |
| array/map-filter | 0.136ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.597ms | 0.611ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.038ms | 0.018ms | 0.018ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.11ms | host-call |
| dom/create-elements | 0.222ms | 0.159ms | — | — | host-call |
| dom/set-attributes | 0.112ms | 0.539ms | — | — | js |
| dom/read-attributes | 0.062ms | 0.134ms | — | — | js |
| dom/modify-text | 0.034ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.466ms | 7.44ms | 0.309ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.32ms | 0.292ms | 1.12ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.315ms | 0.313ms | js |
| mixed/matrix-multiply | 0.187ms | 0.211ms | 0.211ms | 0.729ms | js |
| mixed/sieve | 1.78ms | 1.48ms | 1.52ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.00 | 5.04 | 4.25 | — |
| string/concat-long | 1000 | 4.00 | 5.06 | 3.71 | — |
| string/indexOf | 1000 | 18.92 | 60.10 | 12.27 | 24.09 |
| string/includes | 1000 | 18.66 | 124.79 | 13.94 | 16.70 |
| string/split | 10000 | 42.22 | 451.86 | 50.46 | — |
| string/replace | 1000 | 94.89 | 233.88 | 59.53 | — |
| string/case-convert | 2000 | 29.09 | 111.44 | 2.61 | — |
| string/substring | 10000 | 10.42 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.32 | 93.46 | 19.72 | — |
| string/startsWith-endsWith | 20000 | 20.62 | 17.07 | 15.39 | 27.98 |
| array/map-filter | 30000 | 4.53 | 2.19 | 2.20 | — |
| array/indexOf | 1000 | 4458.38 | 2862.94 | 2861.27 | — |
| dom/create-elements | 2000 | 110.88 | 79.47 | — | — |
| dom/set-attributes | 6000 | 18.60 | 89.85 | — | — |
| dom/read-attributes | 3000 | 20.70 | 44.76 | — | — |
| dom/modify-text | 2000 | 16.92 | 57.21 | — | — |
| mixed/csv-parse | 11000 | 42.40 | 676.16 | 28.07 | — |
| mixed/text-search | 40000 | 10.07 | 32.93 | 7.31 | 28.01 |
| mixed/fibonacci | 10000 | 12.52 | 31.50 | 31.50 | 31.27 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.68 | 1.68 | 5.83 |
| mixed/sieve | 200000 | 8.90 | 7.40 | 7.60 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.68x slower | 1.42x slower | — |
| string/concat-long | 1.27x slower | 1.08x faster | — |
| string/indexOf | 3.18x slower | 1.54x faster | 1.27x slower |
| string/includes | 6.69x slower | 1.34x faster | 1.12x faster |
| string/split | 10.70x slower | 1.20x slower | — |
| string/replace | 2.46x slower | 1.59x faster | — |
| string/case-convert | 3.83x slower | 11.14x faster | — |
| string/substring | 2.61x faster | 3.04x faster | — |
| string/trim | 5.40x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.21x faster | 1.34x faster | 1.36x slower |
| array/push-pop | 2.76x faster | 2.72x faster | — |
| array/sort-i32 | 2.87x faster | 1.53x faster | — |
| array/map-filter | 2.07x faster | 2.06x faster | — |
| array/reduce | 4.01x faster | 3.92x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.13x faster | 2.13x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.85x faster | 1.85x faster | — |
| array/find | 18.39x faster | 18.25x faster | 4.08x slower |
| dom/create-elements | 1.40x faster | — | — |
| dom/set-attributes | 4.83x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.38x slower | — | — |
| mixed/csv-parse | 15.95x slower | 1.51x faster | — |
| mixed/text-search | 3.27x slower | 1.38x faster | 2.78x slower |
| mixed/fibonacci | 2.52x slower | 2.51x slower | 2.50x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.91x slower |
| mixed/sieve | 1.20x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.36x faster |
| string/indexOf | 4.90x faster |
| string/includes | 8.95x faster |
| string/split | 8.96x faster |
| string/replace | 3.93x faster |
| string/case-convert | 42.68x faster |
| string/substring | 1.16x faster |
| string/trim | 4.74x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.87x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 24.09x faster |
| mixed/text-search | 4.51x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.03x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1276.1ms | 1040.2ms | — |
| string/concat-long | 623.6ms | 939.5ms | — |
| string/indexOf | 638.8ms | 951.1ms | 811.1ms |
| string/includes | 644.6ms | 953.5ms | 836.8ms |
| string/split | 776.5ms | 952.8ms | — |
| string/replace | 747.4ms | 1019.1ms | — |
| string/case-convert | 750.9ms | 882.8ms | — |
| string/substring | 642.7ms | 738.8ms | — |
| string/trim | 731.7ms | 936.3ms | — |
| string/startsWith-endsWith | 768.0ms | 971.1ms | 901.4ms |
| array/push-pop | 761.0ms | 832.5ms | — |
| array/sort-i32 | 881.7ms | 988.7ms | — |
| array/map-filter | 934.8ms | 992.5ms | — |
| array/reduce | 802.3ms | 917.1ms | — |
| array/indexOf | 813.2ms | 885.3ms | — |
| array/slice | 776.9ms | 850.5ms | — |
| array/reverse | 753.2ms | 814.2ms | — |
| array/forEach | 850.9ms | 955.3ms | — |
| array/find | 764.4ms | 809.0ms | 793.9ms |
| dom/create-elements | 634.6ms | — | — |
| dom/set-attributes | 701.3ms | — | — |
| dom/read-attributes | 709.9ms | — | — |
| dom/modify-text | 605.1ms | — | — |
| mixed/csv-parse | 794.7ms | 947.0ms | — |
| mixed/text-search | 760.8ms | 1000.5ms | 894.0ms |
| mixed/fibonacci | 758.2ms | 784.3ms | 807.4ms |
| mixed/matrix-multiply | 815.9ms | 935.9ms | 791.3ms |
| mixed/sieve | 837.5ms | 924.4ms | — |
