# js2wasm Benchmark Results

Date: 2026-08-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.051ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.006ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.013ms | 0.040ms | gc-native |
| string/includes | 0.019ms | 0.102ms | 0.014ms | 0.025ms | gc-native |
| string/split | 0.422ms | 4.66ms | 0.506ms | FAILED | js |
| string/replace | 0.097ms | 0.223ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.226ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.939ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.336ms | 0.309ms | 0.557ms | gc-native |
| array/push-pop | 1.71ms | 0.616ms | 0.620ms | FAILED | host-call |
| array/sort-i32 | 0.850ms | 0.305ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.138ms | 0.067ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.40ms | 0.616ms | 0.612ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.040ms | 0.017ms | 0.018ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.055ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.274ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | 0.159ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.536ms | — | — | js |
| dom/read-attributes | 0.065ms | 0.138ms | — | — | js |
| dom/modify-text | 0.030ms | 0.111ms | — | — | js |
| mixed/csv-parse | 0.473ms | 6.80ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.37ms | 0.292ms | 1.62ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.306ms | 0.307ms | 1.27ms | js |
| mixed/matrix-multiply | 0.188ms | 0.211ms | 0.211ms | 0.727ms | js |
| mixed/sieve | 1.84ms | 1.49ms | 1.51ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.09 | 5.11 | 4.40 | — |
| string/concat-long | 1000 | 4.11 | 5.50 | 3.59 | — |
| string/indexOf | 1000 | 19.07 | 59.77 | 12.55 | 40.39 |
| string/includes | 1000 | 18.80 | 102.23 | 14.42 | 24.81 |
| string/split | 10000 | 42.18 | 465.83 | 50.55 | — |
| string/replace | 1000 | 96.84 | 223.33 | 59.74 | — |
| string/case-convert | 2000 | 29.07 | 113.12 | 2.61 | — |
| string/substring | 10000 | 10.48 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.31 | 93.87 | 19.70 | — |
| string/startsWith-endsWith | 20000 | 20.62 | 16.79 | 15.47 | 27.87 |
| array/map-filter | 30000 | 4.61 | 2.22 | 2.21 | — |
| array/indexOf | 1000 | 4461.84 | 2864.19 | 2862.65 | — |
| dom/create-elements | 2000 | 18.91 | 79.34 | — | — |
| dom/set-attributes | 6000 | 18.38 | 89.36 | — | — |
| dom/read-attributes | 3000 | 21.66 | 46.13 | — | — |
| dom/modify-text | 2000 | 15.16 | 55.62 | — | — |
| mixed/csv-parse | 11000 | 42.97 | 618.57 | 27.91 | — |
| mixed/text-search | 40000 | 10.07 | 34.16 | 7.31 | 40.58 |
| mixed/fibonacci | 10000 | 12.54 | 30.57 | 30.75 | 126.85 |
| mixed/matrix-multiply | 125000 | 1.50 | 1.68 | 1.68 | 5.81 |
| mixed/sieve | 200000 | 9.19 | 7.46 | 7.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.65x slower | 1.42x slower | — |
| string/concat-long | 1.34x slower | 1.14x faster | — |
| string/indexOf | 3.13x slower | 1.52x faster | 2.12x slower |
| string/includes | 5.44x slower | 1.30x faster | 1.32x slower |
| string/split | 11.04x slower | 1.20x slower | — |
| string/replace | 2.31x slower | 1.62x faster | — |
| string/case-convert | 3.89x slower | 11.13x faster | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 5.42x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.33x faster | 1.35x slower |
| array/push-pop | 2.77x faster | 2.75x faster | — |
| array/sort-i32 | 2.79x faster | 2.84x faster | — |
| array/map-filter | 2.08x faster | 2.09x faster | — |
| array/reduce | 3.90x faster | 3.93x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.31x faster | 2.23x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.89x faster | 1.89x faster | — |
| array/find | 18.33x faster | 18.26x faster | 4.43x slower |
| dom/create-elements | 4.20x slower | — | — |
| dom/set-attributes | 4.86x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.67x slower | — | — |
| mixed/csv-parse | 14.39x slower | 1.54x faster | — |
| mixed/text-search | 3.39x slower | 1.38x faster | 4.03x slower |
| mixed/fibonacci | 2.44x slower | 2.45x slower | 10.11x slower |
| mixed/matrix-multiply | 1.12x slower | 1.12x slower | 3.87x slower |
| mixed/sieve | 1.23x faster | 1.22x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.53x faster |
| string/indexOf | 4.76x faster |
| string/includes | 7.09x faster |
| string/split | 9.21x faster |
| string/replace | 3.74x faster |
| string/case-convert | 43.30x faster |
| string/substring | 1.16x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 22.16x faster |
| mixed/text-search | 4.67x faster |
| mixed/fibonacci | 1.01x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

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
| array/forEach | 2.5KB | 3.0KB | — |
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
| string/concat-short | 1326.1ms | 1085.8ms | — |
| string/concat-long | 658.2ms | 958.8ms | — |
| string/indexOf | 702.5ms | 939.1ms | 860.9ms |
| string/includes | 654.8ms | 963.5ms | 835.3ms |
| string/split | 765.3ms | 969.5ms | — |
| string/replace | 758.6ms | 1042.6ms | — |
| string/case-convert | 782.9ms | 866.1ms | — |
| string/substring | 670.0ms | 736.7ms | — |
| string/trim | 749.7ms | 984.9ms | — |
| string/startsWith-endsWith | 780.7ms | 1010.1ms | 919.2ms |
| array/push-pop | 787.5ms | 844.7ms | — |
| array/sort-i32 | 925.7ms | 974.6ms | — |
| array/map-filter | 931.8ms | 998.6ms | — |
| array/reduce | 872.9ms | 954.1ms | — |
| array/indexOf | 846.2ms | 909.8ms | — |
| array/slice | 763.5ms | 885.8ms | — |
| array/reverse | 755.2ms | 866.0ms | — |
| array/forEach | 889.3ms | 954.8ms | — |
| array/find | 744.6ms | 860.1ms | 841.4ms |
| dom/create-elements | 629.1ms | — | — |
| dom/set-attributes | 710.7ms | — | — |
| dom/read-attributes | 710.6ms | — | — |
| dom/modify-text | 646.6ms | — | — |
| mixed/csv-parse | 818.7ms | 996.1ms | — |
| mixed/text-search | 786.3ms | 975.4ms | 922.2ms |
| mixed/fibonacci | 775.4ms | 819.2ms | 827.8ms |
| mixed/matrix-multiply | 877.9ms | 941.9ms | 831.1ms |
| mixed/sieve | 871.7ms | 914.8ms | — |
