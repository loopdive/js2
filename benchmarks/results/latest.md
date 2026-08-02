# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.019ms | 0.081ms | 0.023ms | FAILED | js |
| string/includes | 0.019ms | 0.127ms | 0.022ms | FAILED | js |
| string/split | 0.425ms | 5.41ms | 1.52ms | FAILED | js |
| string/replace | 0.046ms | 0.226ms | 0.078ms | FAILED | js |
| string/case-convert | 0.062ms | 0.258ms | 0.112ms | FAILED | js |
| string/substring | 0.104ms | 0.959ms | 0.931ms | FAILED | js |
| string/trim | 0.182ms | 1.37ms | 0.724ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.78ms | 0.527ms | FAILED | js |
| array/push-pop | 1.67ms | 2.54ms | 2.54ms | FAILED | js |
| array/sort-i32 | 0.847ms | 0.407ms | 0.406ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.681ms | 0.699ms | FAILED | js |
| array/reduce | 2.38ms | 2.53ms | 2.55ms | FAILED | js |
| array/indexOf | 4.45ms | 3.85ms | 3.85ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.025ms | 0.024ms | FAILED | gc-native |
| array/reverse | 8.83ms | 3.69ms | 3.68ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.122ms | 0.122ms | FAILED | js |
| array/find | 0.281ms | 0.510ms | 0.509ms | 1.11ms | js |
| dom/create-elements | 0.234ms | 0.269ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.372ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.183ms | — | — | js |
| dom/modify-text | 0.054ms | 0.165ms | — | — | js |
| mixed/csv-parse | 0.956ms | 6.72ms | 0.799ms | FAILED | gc-native |
| mixed/text-search | 0.408ms | 5.44ms | 1.16ms | FAILED | js |
| mixed/fibonacci | 0.125ms | 0.304ms | 0.304ms | 0.302ms | js |
| mixed/matrix-multiply | 0.185ms | 0.567ms | 0.567ms | 0.718ms | js |
| mixed/sieve | 1.74ms | 1.49ms | 1.48ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.24 | 4.91 | 4.19 | — |
| string/concat-long | 1000 | 4.28 | 8.40 | 9.05 | — |
| string/indexOf | 1000 | 18.94 | 80.92 | 23.44 | — |
| string/includes | 1000 | 18.67 | 127.18 | 22.37 | — |
| string/split | 10000 | 42.54 | 541.30 | 151.77 | — |
| string/replace | 1000 | 45.79 | 226.11 | 77.90 | — |
| string/case-convert | 2000 | 31.09 | 129.11 | 56.06 | — |
| string/substring | 10000 | 10.43 | 95.92 | 93.08 | — |
| string/trim | 10000 | 18.18 | 137.17 | 72.39 | — |
| string/startsWith-endsWith | 20000 | 21.42 | 138.99 | 26.36 | — |
| mixed/csv-parse | 11000 | 86.87 | 610.49 | 72.59 | — |
| mixed/text-search | 40000 | 10.20 | 136.04 | 29.09 | — |
| mixed/fibonacci | 10000 | 12.52 | 30.44 | 30.44 | 30.17 |
| mixed/matrix-multiply | 125000 | 1.48 | 4.54 | 4.53 | 5.74 |
| mixed/sieve | 200000 | 8.72 | 7.44 | 7.39 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.29x slower | — |
| string/concat-long | 1.96x slower | 2.11x slower | — |
| string/indexOf | 4.27x slower | 1.24x slower | — |
| string/includes | 6.81x slower | 1.20x slower | — |
| string/split | 12.73x slower | 3.57x slower | — |
| string/replace | 4.94x slower | 1.70x slower | — |
| string/case-convert | 4.15x slower | 1.80x slower | — |
| string/substring | 9.19x slower | 8.92x slower | — |
| string/trim | 7.55x slower | 3.98x slower | — |
| string/startsWith-endsWith | 6.49x slower | 1.23x slower | — |
| array/push-pop | 1.52x slower | 1.52x slower | — |
| array/sort-i32 | 2.08x faster | 2.09x faster | — |
| array/map-filter | 5.04x slower | 5.18x slower | — |
| array/reduce | 1.06x slower | 1.07x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.34x faster | 1.39x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.36x slower | 2.36x slower | — |
| array/find | 1.82x slower | 1.81x slower | 3.97x slower |
| dom/create-elements | 1.15x slower | — | — |
| dom/set-attributes | 3.37x slower | — | — |
| dom/read-attributes | 3.03x slower | — | — |
| dom/modify-text | 3.06x slower | — | — |
| mixed/csv-parse | 7.03x slower | 1.20x faster | — |
| mixed/text-search | 13.33x slower | 2.85x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.41x slower |
| mixed/matrix-multiply | 3.08x slower | 3.07x slower | 3.89x slower |
| mixed/sieve | 1.17x faster | 1.18x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 3.45x faster |
| string/includes | 5.69x faster |
| string/split | 3.57x faster |
| string/replace | 2.90x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.03x faster |
| string/trim | 1.89x faster |
| string/startsWith-endsWith | 5.27x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.03x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.41x faster |
| mixed/text-search | 4.68x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/substring | 645B | 1.0KB | — |
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
| array/find | 2.7KB | 3.0KB | 635B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 297B | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1207.6ms | 1050.1ms | — |
| string/concat-long | 594.2ms | 937.7ms | — |
| string/indexOf | 735.8ms | 976.2ms | — |
| string/includes | 749.6ms | 970.4ms | — |
| string/split | 805.5ms | 1010.6ms | — |
| string/replace | 804.3ms | 1073.0ms | — |
| string/case-convert | 772.8ms | 1046.0ms | — |
| string/substring | 773.0ms | 899.2ms | — |
| string/trim | 779.4ms | 955.1ms | — |
| string/startsWith-endsWith | 786.9ms | 954.9ms | — |
| array/push-pop | 732.7ms | 793.0ms | — |
| array/sort-i32 | 923.6ms | 945.2ms | — |
| array/map-filter | 913.1ms | 953.1ms | — |
| array/reduce | 814.6ms | 885.6ms | — |
| array/indexOf | 755.3ms | 796.8ms | — |
| array/slice | 741.6ms | 783.6ms | — |
| array/reverse | 724.4ms | 808.7ms | — |
| array/forEach | 836.9ms | 881.7ms | — |
| array/find | 872.9ms | 911.1ms | 788.0ms |
| dom/create-elements | 622.2ms | — | — |
| dom/set-attributes | 700.8ms | — | — |
| dom/read-attributes | 670.0ms | — | — |
| dom/modify-text | 686.9ms | — | — |
| mixed/csv-parse | 810.2ms | 996.4ms | — |
| mixed/text-search | 775.9ms | 981.2ms | — |
| mixed/fibonacci | 770.8ms | 803.0ms | 739.1ms |
| mixed/matrix-multiply | 844.4ms | 917.2ms | 752.0ms |
| mixed/sieve | 787.4ms | 856.9ms | — |
