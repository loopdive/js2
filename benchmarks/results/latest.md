# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.009ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.078ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.131ms | 0.022ms | FAILED | js |
| string/split | 0.423ms | 5.55ms | 1.49ms | FAILED | js |
| string/replace | 0.046ms | 0.220ms | 0.078ms | FAILED | js |
| string/case-convert | 0.062ms | 0.237ms | 0.113ms | FAILED | js |
| string/substring | 0.105ms | 1.98ms | 0.943ms | FAILED | js |
| string/trim | 0.174ms | 1.38ms | 0.731ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.75ms | 0.528ms | FAILED | js |
| array/push-pop | 1.69ms | 2.59ms | 2.57ms | FAILED | js |
| array/sort-i32 | 0.849ms | 0.430ms | 0.405ms | FAILED | gc-native |
| array/map-filter | 0.137ms | 0.700ms | 0.697ms | FAILED | js |
| array/reduce | 2.40ms | 2.61ms | 2.59ms | FAILED | js |
| array/indexOf | 4.45ms | 3.85ms | 3.85ms | FAILED | host-call |
| array/slice | 0.039ms | 0.025ms | 0.026ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.69ms | 3.68ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.123ms | 0.123ms | FAILED | js |
| array/find | 0.284ms | 0.510ms | 0.510ms | 4.93ms | js |
| dom/create-elements | 0.232ms | 0.260ms | — | — | js |
| dom/set-attributes | 0.113ms | 0.398ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.185ms | — | — | js |
| dom/modify-text | 0.059ms | 0.165ms | — | — | js |
| mixed/csv-parse | 0.461ms | 6.68ms | 0.804ms | FAILED | js |
| mixed/text-search | 0.408ms | 5.40ms | 1.17ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.304ms | 0.304ms | 1.23ms | js |
| mixed/matrix-multiply | 0.187ms | 0.567ms | 0.567ms | 2.03ms | js |
| mixed/sieve | 1.81ms | 1.49ms | 1.50ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.37 | 4.95 | 3.94 | — |
| string/concat-long | 1000 | 4.14 | 8.55 | 9.18 | — |
| string/indexOf | 1000 | 19.00 | 78.37 | 23.77 | — |
| string/includes | 1000 | 18.75 | 131.17 | 22.48 | — |
| string/split | 10000 | 42.34 | 554.54 | 148.96 | — |
| string/replace | 1000 | 45.65 | 219.89 | 77.99 | — |
| string/case-convert | 2000 | 31.10 | 118.45 | 56.43 | — |
| string/substring | 10000 | 10.47 | 198.06 | 94.27 | — |
| string/trim | 10000 | 17.42 | 137.53 | 73.12 | — |
| string/startsWith-endsWith | 20000 | 21.42 | 137.43 | 26.39 | — |
| mixed/csv-parse | 11000 | 41.91 | 607.69 | 73.11 | — |
| mixed/text-search | 40000 | 10.19 | 135.02 | 29.18 | — |
| mixed/fibonacci | 10000 | 12.52 | 30.37 | 30.42 | 123.38 |
| mixed/matrix-multiply | 125000 | 1.49 | 4.54 | 4.53 | 16.21 |
| mixed/sieve | 200000 | 9.07 | 7.43 | 7.48 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.17x slower | — |
| string/concat-long | 2.07x slower | 2.22x slower | — |
| string/indexOf | 4.12x slower | 1.25x slower | — |
| string/includes | 6.99x slower | 1.20x slower | — |
| string/split | 13.10x slower | 3.52x slower | — |
| string/replace | 4.82x slower | 1.71x slower | — |
| string/case-convert | 3.81x slower | 1.81x slower | — |
| string/substring | 18.92x slower | 9.01x slower | — |
| string/trim | 7.90x slower | 4.20x slower | — |
| string/startsWith-endsWith | 6.41x slower | 1.23x slower | — |
| array/push-pop | 1.53x slower | 1.52x slower | — |
| array/sort-i32 | 1.98x faster | 2.09x faster | — |
| array/map-filter | 5.11x slower | 5.09x slower | — |
| array/reduce | 1.09x slower | 1.08x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.55x faster | 1.48x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.29x slower | 2.29x slower | — |
| array/find | 1.80x slower | 1.80x slower | 17.37x slower |
| dom/create-elements | 1.12x slower | — | — |
| dom/set-attributes | 3.52x slower | — | — |
| dom/read-attributes | 2.94x slower | — | — |
| dom/modify-text | 2.80x slower | — | — |
| mixed/csv-parse | 14.50x slower | 1.74x slower | — |
| mixed/text-search | 13.24x slower | 2.86x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 9.85x slower |
| mixed/matrix-multiply | 3.04x slower | 3.04x slower | 10.86x slower |
| mixed/sieve | 1.22x faster | 1.21x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.26x faster |
| string/concat-long | 1.07x slower |
| string/indexOf | 3.30x faster |
| string/includes | 5.84x faster |
| string/split | 3.72x faster |
| string/replace | 2.82x faster |
| string/case-convert | 2.10x faster |
| string/substring | 2.10x faster |
| string/trim | 1.88x faster |
| string/startsWith-endsWith | 5.21x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.06x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.05x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.31x faster |
| mixed/text-search | 4.63x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1263.9ms | 1096.0ms | — |
| string/concat-long | 643.5ms | 995.1ms | — |
| string/indexOf | 781.2ms | 1012.3ms | — |
| string/includes | 761.7ms | 1042.1ms | — |
| string/split | 826.8ms | 1044.6ms | — |
| string/replace | 828.6ms | 1103.3ms | — |
| string/case-convert | 881.1ms | 1108.0ms | — |
| string/substring | 720.0ms | 944.0ms | — |
| string/trim | 820.8ms | 1036.1ms | — |
| string/startsWith-endsWith | 821.5ms | 1035.7ms | — |
| array/push-pop | 785.4ms | 841.8ms | — |
| array/sort-i32 | 949.6ms | 1029.7ms | — |
| array/map-filter | 939.7ms | 998.1ms | — |
| array/reduce | 879.7ms | 928.0ms | — |
| array/indexOf | 797.1ms | 829.1ms | — |
| array/slice | 768.9ms | 842.9ms | — |
| array/reverse | 785.2ms | 852.1ms | — |
| array/forEach | 909.2ms | 969.4ms | — |
| array/find | 924.6ms | 973.9ms | 844.1ms |
| dom/create-elements | 660.8ms | — | — |
| dom/set-attributes | 741.0ms | — | — |
| dom/read-attributes | 719.6ms | — | — |
| dom/modify-text | 712.9ms | — | — |
| mixed/csv-parse | 892.1ms | 1049.5ms | — |
| mixed/text-search | 839.1ms | 1012.5ms | — |
| mixed/fibonacci | 806.4ms | 854.1ms | 792.9ms |
| mixed/matrix-multiply | 916.1ms | 971.7ms | 786.7ms |
| mixed/sieve | 857.6ms | 900.7ms | — |
