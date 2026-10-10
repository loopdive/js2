# js2wasm Benchmark Results

Date: 2026-10-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.021ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.021ms | 0.110ms | 0.014ms | 0.019ms | gc-native |
| string/split | 0.423ms | 8.63ms | 2.86ms | FAILED | js |
| string/replace | 0.112ms | 0.693ms | 0.327ms | FAILED | js |
| string/case-convert | 0.056ms | 0.580ms | 0.273ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.175ms | 3.94ms | 2.84ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.95ms | 2.96ms | 0.560ms | js |
| array/push-pop | 1.40ms | 0.492ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.802ms | 0.293ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.069ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.13ms | 0.497ms | 0.497ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.047ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.252ms | 0.016ms | 0.015ms | 1.07ms | gc-native |
| dom/create-elements | 0.040ms | 0.099ms | — | — | js |
| dom/set-attributes | 0.101ms | 0.216ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.119ms | — | — | js |
| dom/modify-text | 0.028ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.491ms | 8.85ms | 0.643ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.23ms | 2.89ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 76.39ms | 81.16ms | 0.718ms | js |
| mixed/sieve | 1.52ms | 2.11ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 3.44 | 4.73 | 4.32 | — |
| string/concat-long | 1000 | 3.55 | 4.44 | 3.50 | — |
| string/indexOf | 1000 | 21.22 | 63.57 | 11.96 | 15.20 |
| string/includes | 1000 | 21.45 | 110.24 | 14.45 | 18.75 |
| string/split | 10000 | 42.33 | 862.53 | 286.21 | — |
| string/replace | 1000 | 111.54 | 693.38 | 327.14 | — |
| string/case-convert | 2000 | 28.04 | 289.99 | 136.40 | — |
| string/substring | 10000 | 9.82 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.54 | 393.61 | 283.58 | — |
| string/startsWith-endsWith | 20000 | 20.12 | 147.70 | 148.22 | 28.02 |
| array/map-filter | 30000 | 4.24 | 2.31 | 2.30 | — |
| array/indexOf | 1000 | 3950.46 | 2644.35 | 2640.85 | — |
| dom/create-elements | 2000 | 20.04 | 49.69 | — | — |
| dom/set-attributes | 6000 | 16.91 | 36.01 | — | — |
| dom/read-attributes | 3000 | 17.85 | 39.51 | — | — |
| dom/modify-text | 2000 | 13.80 | 53.22 | — | — |
| mixed/csv-parse | 11000 | 44.65 | 804.12 | 58.45 | — |
| mixed/text-search | 40000 | 9.73 | 130.80 | 72.34 | 27.16 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 611.09 | 649.29 | 5.74 |
| mixed/sieve | 200000 | 7.62 | 10.53 | 10.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.37x slower | 1.25x slower | — |
| string/concat-long | 1.25x slower | 1.02x faster | — |
| string/indexOf | 3.00x slower | 1.77x faster | 1.40x faster |
| string/includes | 5.14x slower | 1.48x faster | 1.14x faster |
| string/split | 20.37x slower | 6.76x slower | — |
| string/replace | 6.22x slower | 2.93x slower | — |
| string/case-convert | 10.34x slower | 4.86x slower | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 22.44x slower | 16.17x slower | — |
| string/startsWith-endsWith | 7.34x slower | 7.37x slower | 1.39x slower |
| array/push-pop | 2.84x faster | 2.79x faster | — |
| array/sort-i32 | 2.73x faster | 2.73x faster | — |
| array/map-filter | 1.84x faster | 1.85x faster | — |
| array/reduce | 4.28x faster | 4.28x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.72x faster | 1.72x faster | — |
| array/find | 16.14x faster | 16.33x faster | 4.25x slower |
| dom/create-elements | 2.48x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.86x slower | — | — |
| mixed/csv-parse | 18.01x slower | 1.31x slower | — |
| mixed/text-search | 13.44x slower | 7.44x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 485.99x slower | 516.37x slower | 4.57x slower |
| mixed/sieve | 1.38x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 5.31x faster |
| string/includes | 7.63x faster |
| string/split | 3.01x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.13x faster |
| string/substring | 1.22x faster |
| string/trim | 1.39x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.76x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1115.0ms | 600.4ms | — |
| string/concat-long | 416.8ms | 652.2ms | — |
| string/indexOf | 369.2ms | 636.7ms | 544.1ms |
| string/includes | 362.1ms | 671.1ms | 544.4ms |
| string/split | 496.9ms | 682.5ms | — |
| string/replace | 506.1ms | 722.3ms | — |
| string/case-convert | 525.3ms | 592.9ms | — |
| string/substring | 370.0ms | 450.0ms | — |
| string/trim | 481.2ms | 675.8ms | — |
| string/startsWith-endsWith | 490.1ms | 680.3ms | 611.6ms |
| array/push-pop | 494.5ms | 599.4ms | — |
| array/sort-i32 | 647.1ms | 715.0ms | — |
| array/map-filter | 650.0ms | 709.3ms | — |
| array/reduce | 596.5ms | 663.2ms | — |
| array/indexOf | 596.6ms | 652.3ms | — |
| array/slice | 502.1ms | 582.8ms | — |
| array/reverse | 492.4ms | 549.9ms | — |
| array/forEach | 620.3ms | 685.6ms | — |
| array/find | 495.3ms | 493.4ms | 527.4ms |
| dom/create-elements | 403.8ms | — | — |
| dom/set-attributes | 386.4ms | — | — |
| dom/read-attributes | 368.7ms | — | — |
| dom/modify-text | 360.9ms | — | — |
| mixed/csv-parse | 506.5ms | 656.8ms | — |
| mixed/text-search | 522.8ms | 677.0ms | 604.2ms |
| mixed/fibonacci | 421.4ms | 490.5ms | 457.1ms |
| mixed/matrix-multiply | 638.8ms | 698.3ms | 518.0ms |
| mixed/sieve | 602.2ms | 696.4ms | — |
