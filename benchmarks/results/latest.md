# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.128ms | 0.023ms | FAILED | js |
| string/split | 0.422ms | 5.62ms | 1.42ms | FAILED | js |
| string/replace | 0.045ms | 0.216ms | 0.078ms | FAILED | js |
| string/case-convert | 0.062ms | 0.240ms | 0.112ms | FAILED | js |
| string/substring | 0.105ms | 1.96ms | 0.926ms | FAILED | js |
| string/trim | 0.174ms | 1.35ms | 0.738ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.78ms | 0.531ms | FAILED | js |
| array/push-pop | 1.69ms | 2.58ms | 2.57ms | FAILED | js |
| array/sort-i32 | 0.842ms | 0.413ms | 0.409ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.696ms | 0.694ms | FAILED | js |
| array/reduce | 2.49ms | 2.62ms | 2.62ms | FAILED | js |
| array/indexOf | 4.45ms | 3.85ms | 3.85ms | FAILED | gc-native |
| array/slice | 0.040ms | 0.027ms | 0.027ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.69ms | 3.69ms | FAILED | host-call |
| array/forEach | 0.093ms | 0.123ms | 0.123ms | FAILED | js |
| array/find | 0.283ms | 0.511ms | 0.510ms | 4.94ms | js |
| dom/create-elements | 0.039ms | 0.274ms | — | — | js |
| dom/set-attributes | 0.111ms | 0.371ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.182ms | — | — | js |
| dom/modify-text | 0.052ms | 0.164ms | — | — | js |
| mixed/csv-parse | 0.960ms | 6.78ms | 0.806ms | FAILED | gc-native |
| mixed/text-search | 0.397ms | 5.36ms | 1.17ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.304ms | 0.304ms | 0.304ms | js |
| mixed/matrix-multiply | 0.187ms | 0.567ms | 0.566ms | 2.03ms | js |
| mixed/sieve | 1.82ms | 1.50ms | 1.49ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.38 | 4.88 | 4.38 | — |
| string/concat-long | 1000 | 4.03 | 8.42 | 9.16 | — |
| string/indexOf | 1000 | 19.04 | 81.11 | 23.58 | — |
| string/includes | 1000 | 18.75 | 127.80 | 22.53 | — |
| string/split | 10000 | 42.17 | 561.77 | 142.17 | — |
| string/replace | 1000 | 45.03 | 216.31 | 78.38 | — |
| string/case-convert | 2000 | 31.10 | 120.11 | 56.14 | — |
| string/substring | 10000 | 10.49 | 195.81 | 92.64 | — |
| string/trim | 10000 | 17.39 | 135.47 | 73.79 | — |
| string/startsWith-endsWith | 20000 | 21.42 | 138.86 | 26.55 | — |
| mixed/csv-parse | 11000 | 87.26 | 616.09 | 73.31 | — |
| mixed/text-search | 40000 | 9.93 | 134.02 | 29.20 | — |
| mixed/fibonacci | 10000 | 12.53 | 30.44 | 30.43 | 30.43 |
| mixed/matrix-multiply | 125000 | 1.50 | 4.54 | 4.53 | 16.23 |
| mixed/sieve | 200000 | 9.10 | 7.51 | 7.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.30x slower | — |
| string/concat-long | 2.09x slower | 2.27x slower | — |
| string/indexOf | 4.26x slower | 1.24x slower | — |
| string/includes | 6.82x slower | 1.20x slower | — |
| string/split | 13.32x slower | 3.37x slower | — |
| string/replace | 4.80x slower | 1.74x slower | — |
| string/case-convert | 3.86x slower | 1.80x slower | — |
| string/substring | 18.67x slower | 8.83x slower | — |
| string/trim | 7.79x slower | 4.24x slower | — |
| string/startsWith-endsWith | 6.48x slower | 1.24x slower | — |
| array/push-pop | 1.53x slower | 1.53x slower | — |
| array/sort-i32 | 2.04x faster | 2.06x faster | — |
| array/map-filter | 5.01x slower | 5.00x slower | — |
| array/reduce | 1.05x slower | 1.05x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.46x faster | 1.45x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 1.32x slower | 1.32x slower | — |
| array/find | 1.80x slower | 1.80x slower | 17.46x slower |
| dom/create-elements | 6.98x slower | — | — |
| dom/set-attributes | 3.36x slower | — | — |
| dom/read-attributes | 3.08x slower | — | — |
| dom/modify-text | 3.13x slower | — | — |
| mixed/csv-parse | 7.06x slower | 1.19x faster | — |
| mixed/text-search | 13.49x slower | 2.94x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.43x slower |
| mixed/matrix-multiply | 3.03x slower | 3.02x slower | 10.83x slower |
| mixed/sieve | 1.21x faster | 1.22x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.44x faster |
| string/includes | 5.67x faster |
| string/split | 3.95x faster |
| string/replace | 2.76x faster |
| string/case-convert | 2.14x faster |
| string/substring | 2.11x faster |
| string/trim | 1.84x faster |
| string/startsWith-endsWith | 5.23x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.40x faster |
| mixed/text-search | 4.59x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1278.8ms | 1110.6ms | — |
| string/concat-long | 628.4ms | 955.6ms | — |
| string/indexOf | 779.0ms | 986.7ms | — |
| string/includes | 762.5ms | 1013.3ms | — |
| string/split | 811.7ms | 1006.2ms | — |
| string/replace | 837.4ms | 1090.8ms | — |
| string/case-convert | 810.4ms | 1136.6ms | — |
| string/substring | 715.4ms | 931.5ms | — |
| string/trim | 825.1ms | 1014.7ms | — |
| string/startsWith-endsWith | 840.6ms | 974.2ms | — |
| array/push-pop | 772.1ms | 840.4ms | — |
| array/sort-i32 | 1002.4ms | 968.3ms | — |
| array/map-filter | 903.0ms | 983.1ms | — |
| array/reduce | 850.7ms | 906.2ms | — |
| array/indexOf | 744.9ms | 787.9ms | — |
| array/slice | 768.8ms | 797.2ms | — |
| array/reverse | 773.7ms | 802.1ms | — |
| array/forEach | 883.3ms | 905.2ms | — |
| array/find | 881.4ms | 924.5ms | 828.8ms |
| dom/create-elements | 616.6ms | — | — |
| dom/set-attributes | 730.8ms | — | — |
| dom/read-attributes | 704.9ms | — | — |
| dom/modify-text | 675.4ms | — | — |
| mixed/csv-parse | 861.2ms | 996.6ms | — |
| mixed/text-search | 855.9ms | 1040.4ms | — |
| mixed/fibonacci | 835.8ms | 829.5ms | 773.8ms |
| mixed/matrix-multiply | 871.7ms | 907.2ms | 772.2ms |
| mixed/sieve | 797.1ms | 859.8ms | — |
