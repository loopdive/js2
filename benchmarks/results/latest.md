# js2wasm Benchmark Results

Date: 2026-10-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.049ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.434ms | 8.45ms | 3.00ms | FAILED | js |
| string/replace | 0.105ms | 0.704ms | 0.329ms | FAILED | js |
| string/case-convert | 0.056ms | 0.580ms | 0.276ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.07ms | 2.87ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.00ms | 3.11ms | 0.560ms | js |
| array/push-pop | 1.42ms | 0.509ms | 0.512ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.132ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.14ms | 0.512ms | 0.506ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.029ms | 0.027ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.035ms | 0.097ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.116ms | — | — | js |
| mixed/csv-parse | 0.484ms | 8.88ms | 0.643ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.10ms | 2.94ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.162ms | 72.03ms | 78.53ms | 0.721ms | js |
| mixed/sieve | 1.55ms | 2.09ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.21 | 4.91 | 4.46 | — |
| string/concat-long | 1000 | 3.68 | 4.56 | 3.75 | — |
| string/indexOf | 1000 | 19.14 | 65.62 | 12.60 | 15.36 |
| string/includes | 1000 | 19.19 | 120.10 | 14.74 | 15.45 |
| string/split | 10000 | 43.42 | 845.12 | 300.29 | — |
| string/replace | 1000 | 104.79 | 704.40 | 329.09 | — |
| string/case-convert | 2000 | 28.00 | 289.84 | 137.97 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 407.49 | 287.29 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 149.77 | 155.74 | 28.02 |
| array/map-filter | 30000 | 4.40 | 2.33 | 2.33 | — |
| array/indexOf | 1000 | 3948.90 | 2643.76 | 2643.23 | — |
| dom/create-elements | 2000 | 17.48 | 48.55 | — | — |
| dom/set-attributes | 6000 | 17.34 | 36.25 | — | — |
| dom/read-attributes | 3000 | 18.03 | 40.18 | — | — |
| dom/modify-text | 2000 | 14.60 | 57.88 | — | — |
| mixed/csv-parse | 11000 | 44.03 | 806.83 | 58.45 | — |
| mixed/text-search | 40000 | 9.72 | 127.38 | 73.49 | 27.41 |
| mixed/fibonacci | 10000 | 12.02 | 28.29 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.30 | 576.26 | 628.21 | 5.76 |
| mixed/sieve | 200000 | 7.73 | 10.47 | 10.57 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.39x slower | — |
| string/concat-long | 1.24x slower | 1.02x slower | — |
| string/indexOf | 3.43x slower | 1.52x faster | 1.25x faster |
| string/includes | 6.26x slower | 1.30x faster | 1.24x faster |
| string/split | 19.46x slower | 6.92x slower | — |
| string/replace | 6.72x slower | 3.14x slower | — |
| string/case-convert | 10.35x slower | 4.93x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.94x slower | 16.88x slower | — |
| string/startsWith-endsWith | 7.47x slower | 7.77x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.77x faster | — |
| array/sort-i32 | 2.69x faster | 2.68x faster | — |
| array/map-filter | 1.89x faster | 1.88x faster | — |
| array/reduce | 4.19x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.17x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 16.29x faster | 16.27x faster | 4.24x slower |
| dom/create-elements | 2.78x slower | — | — |
| dom/set-attributes | 2.09x slower | — | — |
| dom/read-attributes | 2.23x slower | — | — |
| dom/modify-text | 3.96x slower | — | — |
| mixed/csv-parse | 18.32x slower | 1.33x slower | — |
| mixed/text-search | 13.11x slower | 7.56x slower | 2.82x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.34x slower |
| mixed/matrix-multiply | 443.94x slower | 483.97x slower | 4.44x slower |
| mixed/sieve | 1.35x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.21x faster |
| string/includes | 8.15x faster |
| string/split | 2.81x faster |
| string/replace | 2.14x faster |
| string/case-convert | 2.10x faster |
| string/substring | 1.22x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.80x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.09x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1148.8ms | 595.9ms | — |
| string/concat-long | 428.5ms | 652.7ms | — |
| string/indexOf | 374.7ms | 664.5ms | 535.0ms |
| string/includes | 380.4ms | 656.4ms | 559.8ms |
| string/split | 510.8ms | 687.1ms | — |
| string/replace | 492.2ms | 760.2ms | — |
| string/case-convert | 524.8ms | 610.4ms | — |
| string/substring | 379.0ms | 479.2ms | — |
| string/trim | 542.3ms | 703.0ms | — |
| string/startsWith-endsWith | 503.1ms | 692.9ms | 626.3ms |
| array/push-pop | 515.5ms | 577.4ms | — |
| array/sort-i32 | 675.2ms | 739.7ms | — |
| array/map-filter | 709.8ms | 757.5ms | — |
| array/reduce | 611.4ms | 677.2ms | — |
| array/indexOf | 577.7ms | 664.2ms | — |
| array/slice | 523.6ms | 607.1ms | — |
| array/reverse | 520.5ms | 565.8ms | — |
| array/forEach | 636.7ms | 688.4ms | — |
| array/find | 481.5ms | 589.3ms | 544.8ms |
| dom/create-elements | 415.0ms | — | — |
| dom/set-attributes | 376.5ms | — | — |
| dom/read-attributes | 387.1ms | — | — |
| dom/modify-text | 376.6ms | — | — |
| mixed/csv-parse | 514.7ms | 658.2ms | — |
| mixed/text-search | 514.1ms | 682.3ms | 606.8ms |
| mixed/fibonacci | 455.8ms | 503.2ms | 475.7ms |
| mixed/matrix-multiply | 624.0ms | 701.8ms | 527.8ms |
| mixed/sieve | 607.8ms | 687.3ms | — |
