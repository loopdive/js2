# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.046ms | 0.035ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.082ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.149ms | 0.023ms | FAILED | js |
| string/split | 0.425ms | 6.06ms | 1.38ms | FAILED | js |
| string/replace | 0.047ms | 0.269ms | 0.100ms | FAILED | js |
| string/case-convert | 0.060ms | 0.242ms | 0.106ms | FAILED | js |
| string/substring | 0.104ms | 1.94ms | 0.912ms | FAILED | js |
| string/trim | 0.169ms | 1.33ms | 0.652ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 2.95ms | 0.529ms | FAILED | js |
| array/push-pop | 1.45ms | 2.23ms | 2.20ms | FAILED | js |
| array/sort-i32 | 0.791ms | 0.395ms | 0.394ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.646ms | 0.644ms | FAILED | js |
| array/reduce | 2.16ms | 2.20ms | 2.22ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.035ms | 0.036ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.116ms | 0.115ms | FAILED | js |
| array/find | 0.239ms | 0.461ms | 0.459ms | 4.84ms | js |
| dom/create-elements | 0.035ms | 0.291ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.373ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.178ms | — | — | js |
| dom/modify-text | 0.047ms | 0.169ms | — | — | js |
| mixed/csv-parse | 0.482ms | 7.57ms | 0.829ms | FAILED | js |
| mixed/text-search | 0.378ms | 6.06ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.157ms | 0.555ms | 0.556ms | 2.13ms | js |
| mixed/sieve | 1.60ms | 1.40ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.07 | 4.62 | 3.52 | — |
| string/concat-long | 1000 | 3.61 | 7.51 | 8.17 | — |
| string/indexOf | 1000 | 19.14 | 82.21 | 23.59 | — |
| string/includes | 1000 | 19.19 | 149.04 | 22.56 | — |
| string/split | 10000 | 42.53 | 605.79 | 138.33 | — |
| string/replace | 1000 | 46.52 | 269.38 | 100.49 | — |
| string/case-convert | 2000 | 30.22 | 121.14 | 53.20 | — |
| string/substring | 10000 | 10.41 | 194.00 | 91.20 | — |
| string/trim | 10000 | 16.90 | 133.14 | 65.17 | — |
| string/startsWith-endsWith | 20000 | 19.52 | 147.66 | 26.46 | — |
| mixed/csv-parse | 11000 | 43.81 | 688.42 | 75.36 | — |
| mixed/text-search | 40000 | 9.44 | 151.46 | 26.56 | — |
| mixed/fibonacci | 10000 | 12.18 | 26.10 | 26.12 | 25.90 |
| mixed/matrix-multiply | 125000 | 1.26 | 4.44 | 4.45 | 17.01 |
| mixed/sieve | 200000 | 8.02 | 7.01 | 6.92 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.15x slower | — |
| string/concat-long | 2.08x slower | 2.27x slower | — |
| string/indexOf | 4.30x slower | 1.23x slower | — |
| string/includes | 7.76x slower | 1.18x slower | — |
| string/split | 14.24x slower | 3.25x slower | — |
| string/replace | 5.79x slower | 2.16x slower | — |
| string/case-convert | 4.01x slower | 1.76x slower | — |
| string/substring | 18.63x slower | 8.76x slower | — |
| string/trim | 7.88x slower | 3.86x slower | — |
| string/startsWith-endsWith | 7.57x slower | 1.36x slower | — |
| array/push-pop | 1.54x slower | 1.52x slower | — |
| array/sort-i32 | 2.00x faster | 2.01x faster | — |
| array/map-filter | 4.99x slower | 4.97x slower | — |
| array/reduce | 1.02x slower | 1.02x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.34x slower | 1.36x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.37x slower | 2.36x slower | — |
| array/find | 1.93x slower | 1.92x slower | 20.27x slower |
| dom/create-elements | 8.23x slower | — | — |
| dom/set-attributes | 3.59x slower | — | — |
| dom/read-attributes | 3.10x slower | — | — |
| dom/modify-text | 3.56x slower | — | — |
| mixed/csv-parse | 15.71x slower | 1.72x slower | — |
| mixed/text-search | 16.04x slower | 2.81x slower | — |
| mixed/fibonacci | 2.14x slower | 2.14x slower | 2.13x slower |
| mixed/matrix-multiply | 3.53x slower | 3.53x slower | 13.50x slower |
| mixed/sieve | 1.14x faster | 1.16x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.31x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.48x faster |
| string/includes | 6.61x faster |
| string/split | 4.38x faster |
| string/replace | 2.68x faster |
| string/case-convert | 2.28x faster |
| string/substring | 2.13x faster |
| string/trim | 2.04x faster |
| string/startsWith-endsWith | 5.58x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.14x faster |
| mixed/text-search | 5.70x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1314.3ms | 1129.2ms | — |
| string/concat-long | 643.8ms | 988.9ms | — |
| string/indexOf | 783.2ms | 1040.5ms | — |
| string/includes | 773.2ms | 974.3ms | — |
| string/split | 843.3ms | 1043.3ms | — |
| string/replace | 829.9ms | 1097.5ms | — |
| string/case-convert | 833.1ms | 1084.3ms | — |
| string/substring | 737.7ms | 959.4ms | — |
| string/trim | 814.4ms | 1013.9ms | — |
| string/startsWith-endsWith | 832.1ms | 1074.3ms | — |
| array/push-pop | 775.0ms | 856.8ms | — |
| array/sort-i32 | 943.7ms | 1050.1ms | — |
| array/map-filter | 934.6ms | 1001.5ms | — |
| array/reduce | 875.5ms | 908.3ms | — |
| array/indexOf | 757.6ms | 850.5ms | — |
| array/slice | 792.5ms | 836.5ms | — |
| array/reverse | 780.9ms | 815.7ms | — |
| array/forEach | 874.4ms | 936.1ms | — |
| array/find | 888.1ms | 984.0ms | 833.1ms |
| dom/create-elements | 619.6ms | — | — |
| dom/set-attributes | 727.4ms | — | — |
| dom/read-attributes | 701.9ms | — | — |
| dom/modify-text | 684.4ms | — | — |
| mixed/csv-parse | 877.0ms | 1029.9ms | — |
| mixed/text-search | 871.6ms | 1020.9ms | — |
| mixed/fibonacci | 819.0ms | 862.6ms | 806.0ms |
| mixed/matrix-multiply | 899.7ms | 995.3ms | 830.7ms |
| mixed/sieve | 852.2ms | 892.7ms | — |
