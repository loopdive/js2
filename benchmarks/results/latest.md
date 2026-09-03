# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.047ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.020ms | 0.069ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.020ms | 0.122ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.412ms | 8.34ms | 2.75ms | FAILED | js |
| string/replace | 0.107ms | 0.682ms | 0.321ms | FAILED | js |
| string/case-convert | 0.056ms | 0.629ms | 0.261ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.83ms | 2.63ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.83ms | 3.00ms | 0.560ms | js |
| array/push-pop | 1.44ms | 0.521ms | 0.511ms | FAILED | gc-native |
| array/sort-i32 | 0.794ms | 0.294ms | 0.446ms | FAILED | host-call |
| array/map-filter | 0.131ms | 0.072ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.508ms | 0.515ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.026ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.029ms | FAILED | host-call |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.165ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.474ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.121ms | — | — | js |
| dom/modify-text | 0.032ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.483ms | 8.78ms | 0.604ms | FAILED | js |
| mixed/text-search | 0.385ms | 4.65ms | 2.88ms | 1.15ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 72.15ms | 71.62ms | 0.723ms | js |
| mixed/sieve | 1.58ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 2.80 | 4.65 | 4.62 | — |
| string/concat-long | 1000 | 3.52 | 4.52 | 3.67 | — |
| string/indexOf | 1000 | 19.64 | 68.92 | 12.30 | 14.75 |
| string/includes | 1000 | 19.65 | 121.74 | 14.82 | 15.47 |
| string/split | 10000 | 41.23 | 833.86 | 275.20 | — |
| string/replace | 1000 | 107.37 | 681.56 | 321.12 | — |
| string/case-convert | 2000 | 27.81 | 314.69 | 130.53 | — |
| string/substring | 10000 | 9.90 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.02 | 382.80 | 263.04 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 141.52 | 149.93 | 28.02 |
| array/map-filter | 30000 | 4.35 | 2.40 | 2.36 | — |
| array/indexOf | 1000 | 3948.95 | 2642.42 | 2639.91 | — |
| dom/create-elements | 2000 | 18.24 | 82.60 | — | — |
| dom/set-attributes | 6000 | 17.24 | 79.07 | — | — |
| dom/read-attributes | 3000 | 18.34 | 40.42 | — | — |
| dom/modify-text | 2000 | 15.82 | 57.59 | — | — |
| mixed/csv-parse | 11000 | 43.92 | 798.20 | 54.89 | — |
| mixed/text-search | 40000 | 9.63 | 116.22 | 72.07 | 28.84 |
| mixed/fibonacci | 10000 | 12.17 | 28.28 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 577.22 | 572.94 | 5.79 |
| mixed/sieve | 200000 | 7.88 | 10.59 | 10.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.66x slower | 1.65x slower | — |
| string/concat-long | 1.29x slower | 1.04x slower | — |
| string/indexOf | 3.51x slower | 1.60x faster | 1.33x faster |
| string/includes | 6.20x slower | 1.33x faster | 1.27x faster |
| string/split | 20.23x slower | 6.68x slower | — |
| string/replace | 6.35x slower | 2.99x slower | — |
| string/case-convert | 11.32x slower | 4.69x slower | — |
| string/substring | 2.64x faster | 3.23x faster | — |
| string/trim | 22.49x slower | 15.45x slower | — |
| string/startsWith-endsWith | 7.06x slower | 7.48x slower | 1.40x slower |
| array/push-pop | 2.76x faster | 2.81x faster | — |
| array/sort-i32 | 2.70x faster | 1.78x faster | — |
| array/map-filter | 1.81x faster | 1.84x faster | — |
| array/reduce | 4.23x faster | 4.17x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.03x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.70x faster | — |
| array/find | 15.69x faster | 15.66x faster | 4.25x slower |
| dom/create-elements | 4.53x slower | — | — |
| dom/set-attributes | 4.59x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.64x slower | — | — |
| mixed/csv-parse | 18.17x slower | 1.25x slower | — |
| mixed/text-search | 12.07x slower | 7.48x slower | 2.99x slower |
| mixed/fibonacci | 2.32x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 457.63x slower | 454.24x slower | 4.59x slower |
| mixed/sieve | 1.34x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 5.60x faster |
| string/includes | 8.22x faster |
| string/split | 3.03x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.41x faster |
| string/substring | 1.23x faster |
| string/trim | 1.46x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.52x slower |
| array/map-filter | 1.02x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.03x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 14.54x faster |
| mixed/text-search | 1.61x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1713.0ms | 1098.8ms | — |
| string/concat-long | 811.6ms | 1006.5ms | — |
| string/indexOf | 687.4ms | 962.7ms | 864.8ms |
| string/includes | 675.0ms | 1009.2ms | 849.2ms |
| string/split | 788.2ms | 990.0ms | — |
| string/replace | 856.5ms | 1061.7ms | — |
| string/case-convert | 796.6ms | 909.8ms | — |
| string/substring | 684.0ms | 818.7ms | — |
| string/trim | 788.7ms | 982.6ms | — |
| string/startsWith-endsWith | 781.2ms | 1010.2ms | 920.6ms |
| array/push-pop | 805.2ms | 879.1ms | — |
| array/sort-i32 | 979.1ms | 1006.9ms | — |
| array/map-filter | 978.4ms | 1053.0ms | — |
| array/reduce | 908.2ms | 993.2ms | — |
| array/indexOf | 859.1ms | 976.8ms | — |
| array/slice | 782.2ms | 897.8ms | — |
| array/reverse | 809.4ms | 881.8ms | — |
| array/forEach | 921.8ms | 1013.6ms | — |
| array/find | 784.6ms | 860.8ms | 872.3ms |
| dom/create-elements | 723.5ms | — | — |
| dom/set-attributes | 761.9ms | — | — |
| dom/read-attributes | 713.9ms | — | — |
| dom/modify-text | 697.8ms | — | — |
| mixed/csv-parse | 809.9ms | 971.2ms | — |
| mixed/text-search | 818.6ms | 989.4ms | 952.3ms |
| mixed/fibonacci | 772.8ms | 800.9ms | 772.2ms |
| mixed/matrix-multiply | 932.0ms | 965.6ms | 835.9ms |
| mixed/sieve | 886.2ms | 959.8ms | — |
