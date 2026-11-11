//! Disposable Linux workload measurements, not a cross-platform benchmark claim.
use qpanes_core::operation_manager::{OperationIntent, OperationManager, SubmitRequest};
use qpanes_core::{
    DirectoryTarget, ListRequest, NativePath, SortDirection, SortKey, TransferRequest,
};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
fn source(path: &Path) -> qpanes_core::Entry {
    qpanes_core::list_directory(ListRequest {
        target: DirectoryTarget::Path(NativePath::from_path(path.parent().unwrap())),
        sort: SortKey::Name,
        direction: SortDirection::Ascending,
    })
    .unwrap()
    .entries
    .into_iter()
    .find(|entry| entry.path == NativePath::from_path(path))
    .unwrap()
}
fn memory(label: &str) {
    if let Ok(status) = fs::read_to_string("/proc/self/status") {
        for line in status
            .lines()
            .filter(|line| line.starts_with("VmRSS:") || line.starts_with("VmHWM:"))
        {
            println!("{label}\t{line}");
        }
    }
}
fn run(path: &Path, output: &Path, name: &str, rounds: usize) {
    let entry = source(path);
    let notifications = Arc::new(AtomicU64::new(0));
    let counter = notifications.clone();
    let manager = OperationManager::new(move |_| {
        counter.fetch_add(1, Ordering::Relaxed);
    })
    .unwrap();
    for round in 0..rounds {
        // Alternate ordering to expose cache/order variance; don't claim the
        // difference is a controlled estimate of production IPC overhead.
        for managed in if round % 2 == 0 {
            [false, true]
        } else {
            [true, false]
        } {
            let target = output.join(format!("{name}-{round}-{managed}"));
            fs::create_dir(&target).unwrap();
            let request = TransferRequest {
                source: entry.clone(),
                destination: NativePath::from_path(&target),
            };
            let before = notifications.load(Ordering::Relaxed);
            let started = Instant::now();
            let mut bytes = entry.size;
            let mut files = None;
            if managed {
                let job = manager
                    .submit(SubmitRequest {
                        client_id: "benchmark".into(),
                        sequence: (round + 1) as u32,
                        intent: OperationIntent::Copy {
                            source: request.source,
                            destination: request.destination,
                        },
                    })
                    .unwrap();
                assert!(manager.wait_idle(Duration::from_secs(60)));
                let result = manager.get(&job.id).unwrap();
                assert_eq!(
                    result.state,
                    qpanes_core::operation_manager::JobState::Completed
                );
                bytes = Some(result.progress.bytes_processed);
                files = Some(result.progress.completed_files);
            } else {
                qpanes_core::copy_entry(request).unwrap();
            }
            let elapsed = started.elapsed();
            println!(
                "workload={name}\tround={round}\tmanaged={managed}\telapsed_ms={:.3}\tbytes={bytes:?}\tfiles={files:?}\tregistry_notifications={}",
                elapsed.as_secs_f64() * 1000.,
                notifications.load(Ordering::Relaxed) - before
            );
            fs::remove_dir_all(target).unwrap();
        }
    }
    memory(name);
}
fn main() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    let output = root.join("output");
    fs::create_dir(&output).unwrap();
    let large = root.join("large.bin");
    let mut file = fs::File::create_new(&large).unwrap();
    let block = vec![19; 1024 * 1024];
    for _ in 0..256 {
        file.write_all(&block).unwrap();
    }
    drop(file);
    memory("initial");
    run(&large, &output, "256MiB", 3);
    let small = root.join("small");
    fs::create_dir(&small).unwrap();
    for n in 0..1024 {
        fs::write(small.join(format!("file-{n}")), &block[..4096]).unwrap();
    }
    run(&small, &output, "1024x4KiB", 1);
    let nested = root.join("nested");
    let mut leaf = nested.clone();
    for depth in 0..20 {
        leaf = leaf.join(format!("depth-{depth}"));
        fs::create_dir_all(&leaf).unwrap();
        for n in 0..10 {
            fs::write(leaf.join(format!("file-{n}")), &block[..4096]).unwrap();
        }
    }
    run(&nested, &output, "20levels-200files", 1);
    let many = root.join("many");
    fs::create_dir(&many).unwrap();
    for n in 0..4000 {
        fs::write(many.join(format!("empty-{n}")), b"").unwrap();
    }
    run(&many, &output, "4000empty", 1);
    let manager = OperationManager::new(|_| {}).unwrap();
    memory("before-1000-jobs");
    let started = Instant::now();
    for sequence in 1..=1000 {
        manager
            .submit(SubmitRequest {
                client_id: "retention".into(),
                sequence,
                intent: OperationIntent::Create {
                    parent: NativePath::from_path(&output),
                    name: format!("job-{sequence}"),
                },
            })
            .unwrap();
        assert!(manager.wait_idle(Duration::from_secs(5)));
    }
    println!(
        "retention\tjobs_submitted=1000\tjobs_retained={}\telapsed_ms={:.3}",
        manager.snapshot().jobs.len(),
        started.elapsed().as_secs_f64() * 1000.
    );
    memory("after-1000-jobs");
}
