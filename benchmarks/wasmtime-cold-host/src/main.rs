// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Minimal Wasmtime embedding host for the #1764 hot-runtime benchmark cold
// lane. The process owns a warm Engine plus compiled artifact(s), then each
// sample allocates a fresh Store + Instance and calls the exported run once.

use std::env;
use std::error::Error;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use wasmtime::component::{
    Component, Instance as ComponentInstance, InstancePre as ComponentInstancePre,
    Linker as ComponentLinker,
};
use wasmtime::{Caller, Config, Engine, Instance, Linker, Memory, Module, Store};

#[derive(Clone, Copy)]
enum RunSignature {
    UnitToUnit,
    I32ToI32,
    I32ToF64,
    F64ToI32,
    F64ToF64,
}

struct Options {
    artifact_path: String,
    arg_text: String,
    runs: usize,
    component: bool,
    preloads: Vec<Preload>,
}

struct Preload {
    name: String,
    path: String,
}

struct TimedSamples {
    elapsed_ms: Vec<f64>,
    outputs: Vec<Option<f64>>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("wasmtime-cold-host: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    if env::args().nth(1).as_deref() == Some("--version") {
        println!("wasmtime {}", wasmtime_environ::VERSION);
        return Ok(());
    }
    let options = parse_args()?;
    let arg_i32: i32 = options.arg_text.parse()?;
    let arg_f64: f64 = options.arg_text.parse()?;

    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_exceptions(true);
    config.wasm_function_references(true);
    config.wasm_gc(true);

    let engine = Engine::new(&config)?;
    let samples = if options.component {
        let component = Component::from_file(&engine, Path::new(&options.artifact_path))?;
        let linker = ComponentLinker::new(&engine);
        let instance_pre = linker.instantiate_pre(&component)?;
        let signature = detect_component_run_signature(&engine, &instance_pre)?;
        time_component_runs(
            &engine,
            &instance_pre,
            signature,
            arg_i32,
            arg_f64,
            options.runs,
        )?
    } else if options.preloads.is_empty() {
        let module = Module::from_file(&engine, Path::new(&options.artifact_path))?;
        let signature = detect_core_run_signature_direct(&engine, &module)?;
        time_core_runs_direct(&engine, &module, signature, arg_i32, arg_f64, options.runs)?
    } else {
        let module = Module::from_file(&engine, Path::new(&options.artifact_path))?;
        let preloads = options
            .preloads
            .iter()
            .map(|preload| {
                Ok::<_, Box<dyn Error>>((
                    preload.name.clone(),
                    Module::from_file(&engine, Path::new(&preload.path))?,
                ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let signature = detect_core_run_signature_linked(&engine, &module, &preloads)?;
        time_core_runs_linked(
            &engine,
            &module,
            &preloads,
            signature,
            arg_i32,
            arg_f64,
            options.runs,
        )?
    };

    let samples_json = samples
        .elapsed_ms
        .iter()
        .map(|sample| sample.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let outputs_json = samples
        .outputs
        .iter()
        .map(|output| output.map_or_else(|| "null".to_string(), |value| value.to_string()))
        .collect::<Vec<_>>()
        .join(",");
    println!("{{\"samplesMs\":[{samples_json}],\"outputs\":[{outputs_json}]}}");
    Ok(())
}

fn parse_args() -> Result<Options, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mut component = false;
    let mut preloads = Vec::new();
    let mut positional = Vec::new();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--component" => component = true,
            "--preload" => {
                let value = args.next().ok_or(USAGE)?;
                preloads.push(parse_preload(&value)?);
            }
            _ if arg.starts_with("--preload=") => {
                preloads.push(parse_preload(&arg["--preload=".len()..])?);
            }
            "-h" | "--help" => return Err(USAGE.into()),
            _ => positional.push(arg),
        }
    }

    if positional.len() != 3 {
        return Err(USAGE.into());
    }
    if component && !preloads.is_empty() {
        return Err("--component and --preload cannot be combined".into());
    }

    let runs: usize = positional[2].parse()?;
    if runs == 0 {
        return Err("runs must be greater than zero".into());
    }

    Ok(Options {
        artifact_path: positional.remove(0),
        arg_text: positional.remove(0),
        runs,
        component,
        preloads,
    })
}

const USAGE: &str = "usage: wasmtime-cold-host [--component] [--preload name=module.wasm] <artifact.wasm> <arg> <runs>";

fn parse_preload(value: &str) -> Result<Preload, Box<dyn Error>> {
    let (name, path) = value
        .split_once('=')
        .ok_or("preload must be formatted as name=module.wasm")?;
    if name.is_empty() || path.is_empty() {
        return Err("preload must be formatted as name=module.wasm".into());
    }
    Ok(Preload {
        name: name.to_string(),
        path: path.to_string(),
    })
}

fn detect_core_run_signature_direct(
    engine: &Engine,
    module: &Module,
) -> Result<RunSignature, Box<dyn Error>> {
    let mut store = Store::new(engine, ());
    let instance = Instance::new(&mut store, module, &[])?;
    detect_core_run_signature(&mut store, &instance)
}

fn detect_core_run_signature_linked(
    engine: &Engine,
    module: &Module,
    preloads: &[(String, Module)],
) -> Result<RunSignature, Box<dyn Error>> {
    let mut store = Store::new(engine, ());
    let mut linker = wasi_linker(engine)?;
    define_preloads(&mut linker, &mut store, preloads)?;
    let instance = linker.instantiate(&mut store, module)?;
    detect_core_run_signature(&mut store, &instance)
}

fn detect_core_run_signature(
    store: &mut Store<()>,
    instance: &Instance,
) -> Result<RunSignature, Box<dyn Error>> {
    if instance
        .get_typed_func::<(), ()>(&mut *store, "run")
        .is_ok()
    {
        return Ok(RunSignature::UnitToUnit);
    }
    if instance
        .get_typed_func::<i32, i32>(&mut *store, "run")
        .is_ok()
    {
        return Ok(RunSignature::I32ToI32);
    }
    if instance
        .get_typed_func::<i32, f64>(&mut *store, "run")
        .is_ok()
    {
        return Ok(RunSignature::I32ToF64);
    }
    if instance
        .get_typed_func::<f64, i32>(&mut *store, "run")
        .is_ok()
    {
        return Ok(RunSignature::F64ToI32);
    }
    if instance
        .get_typed_func::<f64, f64>(&mut *store, "run")
        .is_ok()
    {
        return Ok(RunSignature::F64ToF64);
    }

    Err("exported run function must be () -> () or i32/f64 -> i32/f64".into())
}

fn detect_component_run_signature(
    engine: &Engine,
    instance_pre: &ComponentInstancePre<()>,
) -> Result<RunSignature, Box<dyn Error>> {
    let mut store = Store::new(engine, ());
    let instance = instance_pre.instantiate(&mut store)?;

    if instance.get_typed_func::<(), ()>(&mut store, "run").is_ok() {
        return Ok(RunSignature::UnitToUnit);
    }
    if instance
        .get_typed_func::<(i32,), (i32,)>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::I32ToI32);
    }
    if instance
        .get_typed_func::<(i32,), (f64,)>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::I32ToF64);
    }
    if instance
        .get_typed_func::<(f64,), (i32,)>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::F64ToI32);
    }
    if instance
        .get_typed_func::<(f64,), (f64,)>(&mut store, "run")
        .is_ok()
    {
        return Ok(RunSignature::F64ToF64);
    }

    Err("component export run must be () -> () or i32/f64 -> i32/f64".into())
}

fn time_core_runs_direct(
    engine: &Engine,
    module: &Module,
    signature: RunSignature,
    arg_i32: i32,
    arg_f64: f64,
    runs: usize,
) -> Result<TimedSamples, Box<dyn Error>> {
    let mut elapsed_ms = Vec::with_capacity(runs);
    let mut outputs = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        let mut store = Store::new(engine, ());
        let instance = Instance::new(&mut store, module, &[])?;
        outputs.push(call_core_run_once(
            signature, &mut store, &instance, arg_i32, arg_f64,
        )?);
        elapsed_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(TimedSamples {
        elapsed_ms,
        outputs,
    })
}

fn time_core_runs_linked(
    engine: &Engine,
    module: &Module,
    preloads: &[(String, Module)],
    signature: RunSignature,
    arg_i32: i32,
    arg_f64: f64,
    runs: usize,
) -> Result<TimedSamples, Box<dyn Error>> {
    let mut elapsed_ms = Vec::with_capacity(runs);
    let mut outputs = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        let mut store = Store::new(engine, ());
        let mut linker = wasi_linker(engine)?;
        define_preloads(&mut linker, &mut store, preloads)?;
        let instance = linker.instantiate(&mut store, module)?;
        outputs.push(call_core_run_once(
            signature, &mut store, &instance, arg_i32, arg_f64,
        )?);
        elapsed_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(TimedSamples {
        elapsed_ms,
        outputs,
    })
}

fn time_component_runs(
    engine: &Engine,
    instance_pre: &ComponentInstancePre<()>,
    signature: RunSignature,
    arg_i32: i32,
    arg_f64: f64,
    runs: usize,
) -> Result<TimedSamples, Box<dyn Error>> {
    let mut elapsed_ms = Vec::with_capacity(runs);
    let mut outputs = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        let mut store = Store::new(engine, ());
        let instance = instance_pre.instantiate(&mut store)?;
        outputs.push(call_component_run_once(
            signature, &mut store, &instance, arg_i32, arg_f64,
        )?);
        elapsed_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
    }
    Ok(TimedSamples {
        elapsed_ms,
        outputs,
    })
}

fn define_preloads(
    linker: &mut Linker<()>,
    store: &mut Store<()>,
    preloads: &[(String, Module)],
) -> Result<(), Box<dyn Error>> {
    for (name, module) in preloads {
        linker.module(&mut *store, name, module)?;
    }
    Ok(())
}

fn call_core_run_once(
    signature: RunSignature,
    store: &mut Store<()>,
    instance: &Instance,
    arg_i32: i32,
    arg_f64: f64,
) -> Result<Option<f64>, Box<dyn Error>> {
    match signature {
        RunSignature::UnitToUnit => {
            let run = instance.get_typed_func::<(), ()>(&mut *store, "run")?;
            black_box(run.call(&mut *store, ())?);
            Ok(None)
        }
        RunSignature::I32ToI32 => {
            let run = instance.get_typed_func::<i32, i32>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, arg_i32)?) as f64))
        }
        RunSignature::I32ToF64 => {
            let run = instance.get_typed_func::<i32, f64>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, arg_i32)?)))
        }
        RunSignature::F64ToI32 => {
            let run = instance.get_typed_func::<f64, i32>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, arg_f64)?) as f64))
        }
        RunSignature::F64ToF64 => {
            let run = instance.get_typed_func::<f64, f64>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, arg_f64)?)))
        }
    }
}

fn call_component_run_once(
    signature: RunSignature,
    store: &mut Store<()>,
    instance: &ComponentInstance,
    arg_i32: i32,
    arg_f64: f64,
) -> Result<Option<f64>, Box<dyn Error>> {
    match signature {
        RunSignature::UnitToUnit => {
            let run = instance.get_typed_func::<(), ()>(&mut *store, "run")?;
            black_box(run.call(&mut *store, ())?);
            Ok(None)
        }
        RunSignature::I32ToI32 => {
            let run = instance.get_typed_func::<(i32,), (i32,)>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, (arg_i32,))?.0) as f64))
        }
        RunSignature::I32ToF64 => {
            let run = instance.get_typed_func::<(i32,), (f64,)>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, (arg_i32,))?.0)))
        }
        RunSignature::F64ToI32 => {
            let run = instance.get_typed_func::<(f64,), (i32,)>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, (arg_f64,))?.0) as f64))
        }
        RunSignature::F64ToF64 => {
            let run = instance.get_typed_func::<(f64,), (f64,)>(&mut *store, "run")?;
            Ok(Some(black_box(run.call(&mut *store, (arg_f64,))?.0)))
        }
    }
}

fn wasi_linker(engine: &Engine) -> Result<Linker<()>, Box<dyn Error>> {
    let mut linker = Linker::new(engine);
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "environ_get",
        |_caller: Caller<'_, ()>, _environ: i32, _environ_buf: i32| -> i32 { 0 },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "environ_sizes_get",
        |mut caller: Caller<'_, ()>, count_ptr: i32, size_ptr: i32| -> i32 {
            let status = write_u32(&mut caller, count_ptr, 0);
            if status != 0 {
                return status;
            }
            write_u32(&mut caller, size_ptr, 0)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "clock_time_get",
        |mut caller: Caller<'_, ()>, _clock_id: i32, _precision: i64, time_ptr: i32| -> i32 {
            write_u64(&mut caller, time_ptr, 0)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "random_get",
        |mut caller: Caller<'_, ()>, ptr: i32, len: i32| -> i32 {
            write_zeroes(&mut caller, ptr, len)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_close",
        |_caller: Caller<'_, ()>, _fd: i32| -> i32 { 0 },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_fdstat_get",
        |mut caller: Caller<'_, ()>, _fd: i32, stat_ptr: i32| -> i32 {
            write_zeroes(&mut caller, stat_ptr, 24)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_read",
        |mut caller: Caller<'_, ()>, _fd: i32, _iovs: i32, _iovs_len: i32, nread: i32| -> i32 {
            write_u32(&mut caller, nread, 0)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_seek",
        |mut caller: Caller<'_, ()>, _fd: i32, _offset: i64, _whence: i32, newoffset: i32| -> i32 {
            write_u64(&mut caller, newoffset, 0)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_write",
        |mut caller: Caller<'_, ()>, _fd: i32, iovs: i32, iovs_len: i32, nwritten: i32| -> i32 {
            let mut written = 0u32;
            for i in 0..iovs_len {
                let Some(base) = iovs.checked_add(i.saturating_mul(8)) else {
                    return 21;
                };
                let Some(len_ptr) = base.checked_add(4) else {
                    return 21;
                };
                let Some(len) = read_u32(&mut caller, len_ptr) else {
                    return 21;
                };
                written = written.saturating_add(len);
            }
            write_u32(&mut caller, nwritten, written)
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "proc_exit",
        |_caller: Caller<'_, ()>, _status: i32| {},
    )?;
    Ok(linker)
}

fn memory(caller: &mut Caller<'_, ()>) -> Option<Memory> {
    caller.get_export("memory")?.into_memory()
}

fn read_u32(caller: &mut Caller<'_, ()>, ptr: i32) -> Option<u32> {
    let offset = usize::try_from(ptr).ok()?;
    let mut bytes = [0u8; 4];
    let memory = memory(caller)?;
    memory.read(caller, offset, &mut bytes).ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn write_u32(caller: &mut Caller<'_, ()>, ptr: i32, value: u32) -> i32 {
    write_bytes(caller, ptr, &value.to_le_bytes())
}

fn write_u64(caller: &mut Caller<'_, ()>, ptr: i32, value: u64) -> i32 {
    write_bytes(caller, ptr, &value.to_le_bytes())
}

fn write_zeroes(caller: &mut Caller<'_, ()>, ptr: i32, len: i32) -> i32 {
    let Ok(len) = usize::try_from(len) else {
        return 21;
    };
    let bytes = vec![0; len];
    write_bytes(caller, ptr, &bytes)
}

fn write_bytes(caller: &mut Caller<'_, ()>, ptr: i32, bytes: &[u8]) -> i32 {
    let Ok(offset) = usize::try_from(ptr) else {
        return 21;
    };
    let Some(memory) = memory(caller) else {
        return 21;
    };
    match memory.write(caller, offset, bytes) {
        Ok(()) => 0,
        Err(_) => 21,
    }
}
