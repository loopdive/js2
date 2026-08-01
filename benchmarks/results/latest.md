# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.047ms | 0.036ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.084ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.153ms | 0.023ms | FAILED | js |
| string/split | 0.433ms | 5.89ms | 1.42ms | FAILED | js |
| string/replace | 0.047ms | 0.303ms | 0.100ms | FAILED | js |
| string/case-convert | 0.061ms | 0.238ms | 0.106ms | FAILED | js |
| string/substring | 0.098ms | 1.98ms | 0.904ms | FAILED | js |
| string/trim | 0.171ms | 1.33ms | 0.644ms | FAILED | js |
| string/startsWith-endsWith | 0.389ms | 2.93ms | 0.523ms | FAILED | js |
| array/push-pop | 1.45ms | 2.17ms | 2.20ms | FAILED | js |
| array/sort-i32 | 0.790ms | 0.391ms | 0.397ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.641ms | 0.641ms | FAILED | js |
| array/reduce | 1.36ms | 2.18ms | 2.17ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.025ms | 0.034ms | 0.035ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | gc-native |
| array/forEach | 0.085ms | 0.116ms | 0.115ms | FAILED | js |
| array/find | 0.239ms | 0.460ms | 0.459ms | 4.84ms | js |
| dom/create-elements | 0.197ms | 0.304ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.367ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.173ms | — | — | js |
| dom/modify-text | 0.048ms | 0.169ms | — | — | js |
| mixed/csv-parse | 1.21ms | 7.54ms | 0.833ms | FAILED | gc-native |
| mixed/text-search | 0.391ms | 6.33ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.158ms | 0.555ms | 0.555ms | 2.13ms | js |
| mixed/sieve | 1.58ms | 1.40ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 4.47 | 4.65 | 3.55 | — |
| string/concat-long | 1000 | 3.59 | 7.48 | 8.13 | — |
| string/indexOf | 1000 | 19.17 | 83.66 | 23.51 | — |
| string/includes | 1000 | 19.22 | 152.58 | 22.57 | — |
| string/split | 10000 | 43.29 | 589.14 | 141.99 | — |
| string/replace | 1000 | 46.65 | 302.81 | 100.00 | — |
| string/case-convert | 2000 | 30.42 | 119.12 | 52.78 | — |
| string/substring | 10000 | 9.85 | 197.92 | 90.38 | — |
| string/trim | 10000 | 17.08 | 132.76 | 64.37 | — |
| string/startsWith-endsWith | 20000 | 19.46 | 146.57 | 26.14 | — |
| mixed/csv-parse | 11000 | 109.61 | 685.59 | 75.72 | — |
| mixed/text-search | 40000 | 9.77 | 158.36 | 26.50 | — |
| mixed/fibonacci | 10000 | 12.17 | 26.11 | 26.10 | 25.91 |
| mixed/matrix-multiply | 125000 | 1.27 | 4.44 | 4.44 | 17.01 |
| mixed/sieve | 200000 | 7.90 | 6.99 | 6.90 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.04x slower | 1.26x faster | — |
| string/concat-long | 2.08x slower | 2.26x slower | — |
| string/indexOf | 4.36x slower | 1.23x slower | — |
| string/includes | 7.94x slower | 1.17x slower | — |
| string/split | 13.61x slower | 3.28x slower | — |
| string/replace | 6.49x slower | 2.14x slower | — |
| string/case-convert | 3.92x slower | 1.74x slower | — |
| string/substring | 20.10x slower | 9.18x slower | — |
| string/trim | 7.77x slower | 3.77x slower | — |
| string/startsWith-endsWith | 7.53x slower | 1.34x slower | — |
| array/push-pop | 1.49x slower | 1.51x slower | — |
| array/sort-i32 | 2.02x faster | 1.99x faster | — |
| array/map-filter | 4.98x slower | 4.99x slower | — |
| array/reduce | 1.61x slower | 1.60x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.38x slower | 1.39x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 1.36x slower | 1.35x slower | — |
| array/find | 1.93x slower | 1.92x slower | 20.29x slower |
| dom/create-elements | 1.54x slower | — | — |
| dom/set-attributes | 3.51x slower | — | — |
| dom/read-attributes | 3.16x slower | — | — |
| dom/modify-text | 3.50x slower | — | — |
| mixed/csv-parse | 6.25x slower | 1.45x faster | — |
| mixed/text-search | 16.21x slower | 2.71x slower | — |
| mixed/fibonacci | 2.15x slower | 2.14x slower | 2.13x slower |
| mixed/matrix-multiply | 3.51x slower | 3.51x slower | 13.44x slower |
| mixed/sieve | 1.13x faster | 1.14x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.31x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.56x faster |
| string/includes | 6.76x faster |
| string/split | 4.15x faster |
| string/replace | 3.03x faster |
| string/case-convert | 2.26x faster |
| string/substring | 2.19x faster |
| string/trim | 2.06x faster |
| string/startsWith-endsWith | 5.61x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.05x faster |
| mixed/text-search | 5.97x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
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
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1303.9ms | 1183.6ms | — |
| string/concat-long | 647.0ms | 1033.2ms | — |
| string/indexOf | 785.4ms | 1057.0ms | — |
| string/includes | 772.6ms | 1027.9ms | — |
| string/split | 821.3ms | 1089.9ms | — |
| string/replace | 797.8ms | 1119.2ms | — |
| string/case-convert | 800.1ms | 1051.0ms | — |
| string/substring | 715.2ms | 977.2ms | — |
| string/trim | 791.2ms | 994.9ms | — |
| string/startsWith-endsWith | 813.2ms | 1027.8ms | — |
| array/push-pop | 748.6ms | 797.1ms | — |
| array/sort-i32 | 922.3ms | 972.5ms | — |
| array/map-filter | 974.7ms | 1026.1ms | — |
| array/reduce | 870.1ms | 912.2ms | — |
| array/indexOf | 761.2ms | 832.4ms | — |
| array/slice | 770.3ms | 839.4ms | — |
| array/reverse | 791.7ms | 830.5ms | — |
| array/forEach | 863.3ms | 923.4ms | — |
| array/find | 884.2ms | 964.8ms | 848.0ms |
| dom/create-elements | 649.0ms | — | — |
| dom/set-attributes | 728.7ms | — | — |
| dom/read-attributes | 688.7ms | — | — |
| dom/modify-text | 716.0ms | — | — |
| mixed/csv-parse | 871.5ms | 1032.8ms | — |
| mixed/text-search | 838.3ms | 1011.9ms | — |
| mixed/fibonacci | 762.6ms | 877.9ms | 777.5ms |
| mixed/matrix-multiply | 847.5ms | 964.4ms | 780.2ms |
| mixed/sieve | 834.0ms | 895.2ms | — |
