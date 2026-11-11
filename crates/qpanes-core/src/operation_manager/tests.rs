use super::*;
use crate::{DirectoryTarget, ListRequest, SortDirection, SortKey};
use std::{fs, sync::mpsc};

fn intent(name: &str) -> OperationIntent {
    OperationIntent::Create {
        parent: NativePath::from_path(std::path::Path::new("/disposable-test-intent")),
        name: name.into(),
    }
}
fn submit(manager: &OperationManager, sequence: u32, intent: OperationIntent) -> OperationJob {
    manager
        .submit(SubmitRequest {
            client_id: "test".into(),
            sequence,
            intent,
        })
        .unwrap()
}
fn start_shutdown(manager: &OperationManager, grace: Duration) -> ShutdownAttempt {
    let expected = manager.snapshot().shutdown_attempt;
    manager
        .begin_shutdown(grace, expected.as_ref())
        .unwrap()
        .unwrap()
}
fn keep_working(manager: &OperationManager) {
    let expected = manager.snapshot().shutdown_attempt;
    manager.keep_working(expected.as_ref()).unwrap();
}
fn ok() -> Result<OperationResult, FsError> {
    Ok(OperationResult {
        path: None,
        warnings: vec![],
    })
}
fn stub() -> OperationManager {
    OperationManager::with_executor(Arc::new(|_| {}), Arc::new(|_, _| ok())).unwrap()
}
fn idle(manager: &OperationManager) {
    assert!(
        manager.wait_idle(Duration::from_secs(5)),
        "worker failed to finish: {:?}",
        manager.snapshot()
    );
}
struct Gate {
    entered: mpsc::Receiver<OperationIntent>,
    release: mpsc::SyncSender<()>,
}
fn gated() -> (OperationManager, Gate) {
    let (entered_tx, entered) = mpsc::sync_channel(64);
    let (release, release_rx) = mpsc::sync_channel(64);
    let receiver = Mutex::new(release_rx);
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(move |intent, _| {
            entered_tx.send(intent).unwrap();
            receiver
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            ok()
        }),
    )
    .unwrap();
    (manager, Gate { entered, release })
}
fn receive(gate: &Gate) -> OperationIntent {
    gate.entered.recv_timeout(Duration::from_secs(5)).unwrap()
}
#[test]
fn state_machine_rejects_every_transition_out_of_terminal_states() {
    for state in [JobState::Completed, JobState::Failed, JobState::Cancelled] {
        for target in [
            JobState::Queued,
            JobState::Preparing,
            JobState::Running,
            JobState::Cancelling,
            JobState::Completed,
            JobState::Failed,
            JobState::Cancelled,
        ] {
            assert!(!state.permits(target));
        }
    }
    assert!(!JobState::Queued.permits(JobState::Completed));
    assert!(!JobState::Cancelling.permits(JobState::Completed));
    assert!(JobState::Running.permits(JobState::Completed));
}
#[test]
fn fifo_one_worker_immutable_intent_and_unique_ids() {
    let (manager, gate) = gated();
    let first = submit(&manager, 1, intent("one"));
    assert_eq!(receive(&gate), intent("one"));
    let second = submit(&manager, 2, intent("two"));
    let third = submit(&manager, 3, intent("three"));
    assert_ne!(first.id, second.id);
    assert_ne!(second.id, third.id);
    assert_eq!(manager.get(&second.id).unwrap().state, JobState::Queued);
    assert!(gate.entered.try_recv().is_err());
    assert!(manager.dismiss(&first.id).is_err());
    assert!(
        manager.cancel(&first.id).is_err(),
        "atomic primitive is noninterruptible"
    );
    gate.release.send(()).unwrap();
    assert_eq!(receive(&gate), intent("two"));
    gate.release.send(()).unwrap();
    assert_eq!(receive(&gate), intent("three"));
    gate.release.send(()).unwrap();
    idle(&manager);
    assert!(
        manager
            .snapshot()
            .jobs
            .iter()
            .all(|job| job.state == JobState::Completed)
    );
    assert!(
        manager
            .snapshot()
            .jobs
            .iter()
            .all(|job| job.started_ms.is_some() && job.completed_ms.is_some())
    );
}
#[test]
fn queued_cancel_never_executes_and_invalid_cancel_is_structured() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("one"));
    receive(&gate);
    let queued = submit(&manager, 2, intent("cancel"));
    assert_eq!(
        manager.cancel(&queued.id).unwrap().state,
        JobState::Cancelled
    );
    assert_eq!(
        manager.cancel(&queued.id).unwrap_err().code,
        ErrorCode::InvalidOperation
    );
    assert_eq!(
        manager.cancel("missing").unwrap_err().code,
        ErrorCode::InvalidOperation
    );
    gate.release.send(()).unwrap();
    idle(&manager);
    assert!(gate.entered.try_recv().is_err());
}
#[test]
fn failure_and_panic_do_not_block_later_jobs_or_offer_unknown_retry() {
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(|intent, _| {
            if intent == self::intent("panic") {
                panic!("injected worker panic");
            }
            if intent == self::intent("fail") {
                return Err(error(
                    ErrorCode::PermissionDenied,
                    "injected permission failure",
                ));
            }
            ok()
        }),
    )
    .unwrap();
    let failed = submit(&manager, 1, intent("fail"));
    let panicked = submit(&manager, 2, intent("panic"));
    let passed = submit(&manager, 3, intent("pass"));
    idle(&manager);
    assert!(manager.get(&failed.id).unwrap().retryable);
    let job = manager.get(&panicked.id).unwrap();
    assert_eq!(job.state, JobState::Failed);
    assert!(!job.retryable);
    assert_eq!(job.error.unwrap().code, ErrorCode::Unavailable);
    assert_eq!(manager.get(&passed.id).unwrap().state, JobState::Completed);
}
#[test]
fn duplicate_submission_cannot_execute_again_even_after_dismissal() {
    let (manager, gate) = gated();
    let first = submit(&manager, 1, intent("once"));
    receive(&gate);
    assert_eq!(submit(&manager, 1, intent("once")).id, first.id);
    assert_eq!(
        manager
            .submit(SubmitRequest {
                client_id: "test".into(),
                sequence: 1,
                intent: intent("changed")
            })
            .unwrap_err()
            .code,
        ErrorCode::DuplicateSubmission
    );
    gate.release.send(()).unwrap();
    idle(&manager);
    manager.dismiss(&first.id).unwrap();
    assert_eq!(
        manager
            .submit(SubmitRequest {
                client_id: "test".into(),
                sequence: 1,
                intent: intent("once")
            })
            .unwrap_err()
            .code,
        ErrorCode::DuplicateSubmission
    );
    assert!(gate.entered.try_recv().is_err());
}
#[test]
fn queue_history_and_client_memory_are_bounded() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("one"));
    receive(&gate);
    for sequence in 2..=MAX_ACTIVE as u32 {
        submit(&manager, sequence, intent("queued"));
    }
    assert_eq!(
        manager
            .submit(SubmitRequest {
                client_id: "test".into(),
                sequence: 33,
                intent: intent("overflow")
            })
            .unwrap_err()
            .code,
        ErrorCode::QueueFull
    );
    start_shutdown(&manager, Duration::ZERO);
    gate.release.send(()).unwrap();
    idle(&manager);
    assert_eq!(
        manager
            .snapshot()
            .jobs
            .iter()
            .filter(|job| job.state == JobState::Cancelled)
            .count(),
        31
    );
    let manager = stub();
    for sequence in 1..=100 {
        submit(&manager, sequence, intent("done"));
        idle(&manager);
    }
    assert_eq!(manager.snapshot().jobs.len(), MAX_HISTORY);
    assert!(
        manager
            .submit(SubmitRequest {
                client_id: "test".into(),
                sequence: 1,
                intent: intent("done")
            })
            .is_err()
    );
    for index in 1..MAX_CLIENTS {
        manager
            .submit(SubmitRequest {
                client_id: format!("client-{index}"),
                sequence: 1,
                intent: intent("done"),
            })
            .unwrap();
        idle(&manager);
    }
    assert_eq!(
        manager
            .submit(SubmitRequest {
                client_id: "over-client-limit".into(),
                sequence: 1,
                intent: intent("done")
            })
            .unwrap_err()
            .code,
        ErrorCode::QueueFull
    );
}
#[test]
fn snapshot_revision_includes_dismissal_and_can_reattach_after_completion() {
    let manager = stub();
    let initial = manager.snapshot();
    let job = submit(&manager, 1, intent("done"));
    idle(&manager);
    let complete = manager.snapshot();
    assert!(complete.revision > initial.revision);
    assert_eq!(complete.jobs[0].state, JobState::Completed);
    manager.dismiss(&job.id).unwrap();
    let dismissed = manager.snapshot();
    assert!(dismissed.revision > complete.revision);
    assert!(dismissed.jobs.is_empty());
}
#[test]
fn shutdown_wait_is_bounded_force_is_explicit_and_keep_working_can_reopen() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("atomic"));
    receive(&gate);
    assert!(!manager.request_close());
    assert!(manager.snapshot().close_requested);
    let prompt = manager.snapshot().shutdown_attempt.unwrap();
    assert!(manager.authorize_force_exit(Some(&prompt)).is_err());
    let attempt = start_shutdown(&manager, Duration::ZERO);
    assert!(
        manager
            .begin_shutdown(Duration::ZERO, Some(&attempt))
            .unwrap()
            .is_none()
    );
    assert!(!manager.wait_idle(Duration::ZERO));
    assert!(!manager.finish_shutdown(&attempt));
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Blocked);
    assert!(
        manager
            .submit(SubmitRequest {
                client_id: "test".into(),
                sequence: 2,
                intent: intent("later")
            })
            .is_err()
    );
    keep_working(&manager);
    assert!(manager.snapshot().accepting);
    assert!(!manager.snapshot().close_requested);
    gate.release.send(()).unwrap();
    idle(&manager);
    let attempt = start_shutdown(&manager, Duration::ZERO);
    assert!(manager.finish_shutdown(&attempt));
    assert!(!manager.finish_shutdown(&attempt));
    assert!(manager.keep_working(Some(&attempt)).is_err());
}

#[test]
fn transport_panic_cannot_strand_a_job() {
    let manager =
        OperationManager::with_executor(Arc::new(|_| panic!("transport")), Arc::new(|_, _| ok()))
            .unwrap();
    let job = submit(&manager, 1, intent("done"));
    idle(&manager);
    assert_eq!(manager.get(&job.id).unwrap().state, JobState::Completed);
}
fn fixture_copy() -> (tempfile::TempDir, OperationIntent) {
    let fixture = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(fixture.path()).unwrap();
    fs::create_dir(root.join("left")).unwrap();
    fs::create_dir(root.join("right")).unwrap();
    fs::write(root.join("left/file"), vec![7; 4 * 65536]).unwrap();
    let source = crate::list_directory(ListRequest {
        target: DirectoryTarget::Path(NativePath::from_path(&root.join("left"))),
        sort: SortKey::Name,
        direction: SortDirection::Ascending,
    })
    .unwrap()
    .entries
    .remove(0);
    let intent = OperationIntent::Copy {
        source,
        destination: NativePath::from_path(&root.join("right")),
    };
    (fixture, intent)
}
#[test]
fn retry_uses_new_id_new_staging_and_revalidates_conflicts_and_stale_source() {
    let (fixture, intent) = fixture_copy();
    let root = fixture.path();
    fs::write(root.join("right/file"), b"untouched").unwrap();
    let manager = OperationManager::new(|_| {}).unwrap();
    let first = submit(&manager, 1, intent);
    idle(&manager);
    assert!(manager.get(&first.id).unwrap().retryable);
    let conflict = manager.retry(&first.id, "test".into(), 2).unwrap();
    idle(&manager);
    assert_ne!(first.id, conflict.id);
    assert_eq!(conflict.retry_of, Some(first.id.clone()));
    assert_eq!(
        manager.get(&conflict.id).unwrap().error.unwrap().code,
        ErrorCode::Conflict
    );
    assert_eq!(fs::read(root.join("right/file")).unwrap(), b"untouched");
    fs::remove_file(root.join("right/file")).unwrap();
    fs::rename(root.join("left/file"), root.join("left/original")).unwrap();
    fs::write(root.join("left/file"), b"replacement").unwrap();
    let changed = manager.retry(&first.id, "test".into(), 3).unwrap();
    idle(&manager);
    assert_eq!(
        manager.get(&changed.id).unwrap().error.unwrap().code,
        ErrorCode::SourceChanged
    );
    assert!(!root.join("right/file").exists());
}
struct BoundaryObserver<'a> {
    inner: &'a mut dyn CopyObserver,
    gate: &'a Mutex<mpsc::Receiver<()>>,
    entered: &'a mpsc::SyncSender<()>,
    at_publication: bool,
    after_gate: bool,
    stopped: bool,
}
impl CopyObserver for BoundaryObserver<'_> {
    fn checkpoint(&mut self, progress: &CopyProgress) -> Result<(), FsError> {
        self.inner.checkpoint(progress)?;
        if !self.at_publication && !self.stopped && progress.bytes_processed > 0 {
            self.stopped = true;
            self.entered.send(()).unwrap();
            self.gate
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        self.inner.checkpoint(progress)
    }
    fn begin_publication(&mut self, progress: &CopyProgress) -> Result<(), FsError> {
        if self.after_gate {
            self.inner.begin_publication(progress)?;
        }
        if self.at_publication {
            self.entered.send(()).unwrap();
            self.gate
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        if !self.after_gate {
            self.inner.begin_publication(progress)?;
        }
        Ok(())
    }
}
fn cancellation_boundary(at_publication: bool, after_gate: bool) {
    let (fixture, intent) = fixture_copy();
    let root = fixture.path();
    let (entered_tx, entered) = mpsc::sync_channel(1);
    let (release, receive) = mpsc::sync_channel(1);
    let gate = Mutex::new(receive);
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(move |intent, inner| {
            let mut observer = BoundaryObserver {
                inner,
                gate: &gate,
                entered: &entered_tx,
                at_publication,
                after_gate,
                stopped: false,
            };
            execute(intent, &mut observer)
        }),
    )
    .unwrap();
    let job = submit(&manager, 1, intent);
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    if after_gate {
        assert!(manager.cancel(&job.id).is_err());
    } else {
        assert_eq!(manager.cancel(&job.id).unwrap().state, JobState::Cancelling);
        assert_eq!(manager.cancel(&job.id).unwrap().state, JobState::Cancelling);
    }
    release.send(()).unwrap();
    idle(&manager);
    let job = manager.get(&job.id).unwrap();
    assert_eq!(
        fs::read(root.join("left/file")).unwrap(),
        vec![7; 4 * 65536]
    );
    assert_eq!(
        job.progress.bytes_processed,
        if at_publication { 4 * 65536 } else { 65536 }
    );
    if after_gate {
        assert_eq!(job.state, JobState::Completed);
        assert!(root.join("right/file").exists());
    } else {
        assert_eq!(job.state, JobState::Cancelled);
        assert!(!root.join("right/file").exists());
        let error = job.error.unwrap();
        assert_eq!(error.code, ErrorCode::CancellationCleanupFailed);
        assert!(
            error
                .recovery
                .unwrap()
                .to_path()
                .unwrap()
                .join("payload")
                .exists()
        );
    }
    assert!(job.progress.bytes_per_second.is_none());
    assert!(job.progress.remaining_ms.is_none());
}
#[test]
fn cancel_during_real_copy_preserves_source_and_reports_retained_staging() {
    cancellation_boundary(false, false);
}
#[test]
fn cancellation_before_publication_prevents_publishing() {
    cancellation_boundary(true, false);
}
#[test]
fn publication_gate_wins_over_late_cancellation_without_rollback() {
    cancellation_boundary(true, true);
}

#[test]
fn preparing_job_can_be_cancelled_before_native_execution() {
    let (entered_tx, entered) = mpsc::sync_channel(1);
    let (release, receive) = mpsc::sync_channel(1);
    let receive = Mutex::new(receive);
    let executions = Arc::new(AtomicU64::new(0));
    let count = executions.clone();
    let manager = OperationManager::with_executor(
        Arc::new(move |revision| {
            if revision == 2 {
                entered_tx.send(()).unwrap();
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        }),
        Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::Relaxed);
            ok()
        }),
    )
    .unwrap();
    let job = submit(&manager, 1, intent("preparing"));
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(manager.get(&job.id).unwrap().state, JobState::Preparing);
    assert_eq!(manager.cancel(&job.id).unwrap().state, JobState::Cancelled);
    release.send(()).unwrap();
    idle(&manager);
    assert_eq!(executions.load(Ordering::Relaxed), 0);
}
#[test]
fn progress_is_throttled_final_is_forced_and_warm_speed_and_eta_are_optional() {
    let manager = stub();
    let job = submit(&manager, 1, intent("one"));
    idle(&manager);
    // Use a separate manually queued record so snapshots can be inspected without
    // a second worker modifying it. Timing is injected through monotonic instants.
    let shared = manager.owner.shared.clone();
    {
        let mut registry = shared.lock();
        let record = registry.record(&job.id).unwrap();
        record.job.state = JobState::Running;
    }
    let mut observer = ManagedObserver::new(
        shared.clone(),
        job.id.clone(),
        Arc::new(AtomicBool::new(false)),
    );
    let mut progress = CopyProgress {
        total_bytes: Some(10000),
        ..CopyProgress::default()
    };
    let revision = manager.snapshot().revision;
    for bytes in 1..100 {
        progress.bytes_processed = bytes;
        observer.checkpoint(&progress).unwrap();
    }
    assert_eq!(
        manager.snapshot().revision,
        revision,
        "tiny chunks must not flood transport"
    );
    observer.started = Instant::now() - Duration::from_secs(1);
    for bytes in [1000, 2000, 3000] {
        observer.last_report = Instant::now() - PROGRESS_INTERVAL;
        progress.bytes_processed = bytes;
        observer.report(&progress, false);
    }
    let warm = manager.get(&job.id).unwrap().progress;
    assert!(warm.bytes_per_second.unwrap() > 0.0);
    assert!(warm.remaining_ms.unwrap() > 0);
    observer.last_report = Instant::now() - PROGRESS_INTERVAL;
    observer.report(&progress, false);
    assert!(
        manager
            .get(&job.id)
            .unwrap()
            .progress
            .bytes_per_second
            .is_none()
    );
    progress.total_bytes = None;
    observer.report(&progress, true);
    assert!(
        manager
            .get(&job.id)
            .unwrap()
            .progress
            .remaining_ms
            .is_none()
    );
    {
        let mut registry = shared.lock();
        registry.record(&job.id).unwrap().job.state = JobState::Completed;
    }
    let revision = manager.snapshot().revision;
    progress.bytes_processed = 9999;
    observer.report(&progress, true);
    assert_eq!(
        manager.snapshot().revision,
        revision,
        "terminal state rejects stale progress"
    );
}

#[test]
fn failure_after_partial_progress_is_final_and_preserves_last_actual_counters() {
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(|intent, observer| {
            if matches!(intent, OperationIntent::Copy { .. }) {
                observer.checkpoint(&CopyProgress {
                    bytes_processed: 7,
                    total_bytes: Some(100),
                    total_files: Some(1),
                    ..CopyProgress::default()
                })?;
                return Err(error(
                    ErrorCode::ReadFailed,
                    "injected read failure after seven written bytes",
                ));
            }
            ok()
        }),
    )
    .unwrap();
    let (_fixture, intent) = fixture_copy();
    let failed = submit(&manager, 1, intent);
    let next = submit(&manager, 2, self::intent("next"));
    idle(&manager);
    let failed = manager.get(&failed.id).unwrap();
    assert_eq!(failed.state, JobState::Failed);
    assert_eq!(failed.progress.bytes_processed, 7);
    assert_eq!(failed.progress.total_bytes, Some(100));
    assert_eq!(failed.progress.completed_files, 0);
    assert_eq!(failed.error.unwrap().code, ErrorCode::ReadFailed);
    assert!(failed.result.is_none());
    assert_eq!(manager.get(&next.id).unwrap().state, JobState::Completed);
}

#[test]
fn panic_after_actual_namespace_success_is_unknown_and_never_retryable() {
    let fixture = tempfile::tempdir().unwrap();
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(|intent, observer| {
            let result = execute(intent, observer)?;
            assert!(result.path.is_some());
            panic!("simulated loss of result after the filesystem commit");
        }),
    )
    .unwrap();
    let job = submit(
        &manager,
        1,
        OperationIntent::Create {
            parent: NativePath::from_path(fixture.path()),
            name: "actually-created".into(),
        },
    );
    idle(&manager);
    let unknown = manager.get(&job.id).unwrap();
    assert!(fixture.path().join("actually-created").is_dir());
    assert_eq!(unknown.state, JobState::Failed);
    assert!(!unknown.retryable);
    assert_eq!(unknown.error.unwrap().code, ErrorCode::Unavailable);
    assert!(manager.retry(&job.id, "test".into(), 2).is_err());
}

#[test]
fn hardening_obsolete_shutdown_finisher_cannot_block_a_new_attempt() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("blocked"));
    receive(&gate);
    let first = start_shutdown(&manager, Duration::ZERO);
    assert!(!manager.wait_idle(Duration::ZERO));
    // Deterministic preemption between the old adapter's timeout and finisher.
    keep_working(&manager);
    let second = start_shutdown(&manager, Duration::from_secs(3));
    assert_ne!(first, second);
    let old = manager.clone();
    let old_attempt = first.clone();
    let (release, delayed) = mpsc::sync_channel(1);
    let finisher = std::thread::spawn(move || {
        delayed.recv().unwrap();
        old.finish_shutdown(&old_attempt)
    });
    release.send(()).unwrap();
    assert!(!finisher.join().unwrap());
    let state = manager.snapshot().shutdown_state;
    assert!(manager.authorize_force_exit(Some(&first)).is_err());
    assert!(manager.keep_working(Some(&first)).is_err());
    gate.release.send(()).unwrap();
    idle(&manager);
    assert_eq!(
        state,
        ShutdownState::Draining,
        "an obsolete finisher changed a new attempt"
    );
    assert!(!manager.finish_shutdown(&first));
    assert!(manager.finish_shutdown(&second));
}

#[test]
fn hardening_blocked_shutdown_reconciles_when_the_last_job_finishes() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("blocked"));
    receive(&gate);
    let attempt = start_shutdown(&manager, Duration::ZERO);
    assert!(!manager.wait_idle(Duration::ZERO));
    assert!(!manager.finish_shutdown(&attempt));
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Blocked);
    let watching = manager.clone();
    let token = attempt.clone();
    let waiter = std::thread::spawn(move || {
        watching.wait_shutdown(&token) && watching.finish_shutdown(&token)
    });
    gate.release.send(()).unwrap();
    idle(&manager);
    assert_ne!(
        manager.snapshot().shutdown_state,
        ShutdownState::Blocked,
        "finished work must not remain blocked"
    );
    assert!(waiter.join().unwrap());
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Ready);
    assert!(!manager.finish_shutdown(&attempt));
    assert!(manager.authorize_force_exit(Some(&attempt)).is_err());
}

#[test]
fn shutdown_attempts_have_independent_grace_and_stale_actions_are_rejected() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("atomic"));
    receive(&gate);
    let mut retired = Vec::new();
    for _ in 0..50 {
        assert!(!manager.request_close());
        let prompt = manager.snapshot().shutdown_attempt.unwrap();
        assert!(!manager.request_close());
        assert_eq!(manager.snapshot().shutdown_attempt.as_ref(), Some(&prompt));
        let attempt = start_shutdown(&manager, Duration::from_secs(3));
        assert_eq!(prompt, attempt);
        assert!(
            !manager.finish_shutdown(&attempt),
            "the current attempt must receive its own grace"
        );
        assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Draining);
        for old in &retired {
            assert!(!manager.finish_shutdown(old));
            assert!(manager.authorize_force_exit(Some(old)).is_err());
            assert!(manager.keep_working(Some(old)).is_err());
        }
        let watcher = manager.clone();
        let token = attempt.clone();
        let (finished, ack) = mpsc::sync_channel(1);
        let thread =
            std::thread::spawn(move || finished.send(watcher.wait_shutdown(&token)).unwrap());
        keep_working(&manager);
        assert!(!ack.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
        retired.push(attempt);
    }
    gate.release.send(()).unwrap();
    idle(&manager);
    for old in retired {
        assert!(!manager.finish_shutdown(&old));
    }
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Idle);
    assert!(manager.snapshot().accepting);
}

#[test]
fn shutdown_ready_after_queued_cancellation_is_claimed_once_and_can_be_cancelled_before_claim() {
    let manager = stub();
    let first = start_shutdown(&manager, Duration::ZERO);
    assert!(manager.wait_shutdown(&first));
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Ready);
    keep_working(&manager);
    assert!(!manager.finish_shutdown(&first));
    let second = start_shutdown(&manager, Duration::ZERO);
    assert_ne!(first, second);
    assert!(manager.finish_shutdown(&second));
    assert!(!manager.finish_shutdown(&second));
    assert!(manager.authorize_force_exit(Some(&second)).is_err());
}

#[test]
fn shutdown_reconciles_a_cancelled_copy_with_retained_staging_without_claiming_clean_cleanup() {
    let (fixture, intent) = fixture_copy();
    let (entered_tx, entered) = mpsc::sync_channel(1);
    let (release, receive) = mpsc::sync_channel(1);
    let gate = Mutex::new(receive);
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(move |intent, inner| {
            let mut observer = BoundaryObserver {
                inner,
                gate: &gate,
                entered: &entered_tx,
                at_publication: false,
                after_gate: false,
                stopped: false,
            };
            execute(intent, &mut observer)
        }),
    )
    .unwrap();
    let job = submit(&manager, 1, intent);
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let queued = submit(&manager, 2, self::intent("never-run"));
    let attempt = start_shutdown(&manager, Duration::ZERO);
    assert!(!manager.finish_shutdown(&attempt));
    assert_eq!(manager.get(&queued.id).unwrap().state, JobState::Cancelled);
    release.send(()).unwrap();
    idle(&manager);
    let job = manager.get(&job.id).unwrap();
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(job.progress.bytes_processed, 65536);
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Ready);
    let error = job.error.unwrap();
    assert_eq!(error.code, ErrorCode::CancellationCleanupFailed);
    assert_eq!(
        fs::read(error.recovery.unwrap().to_path().unwrap().join("payload")).unwrap(),
        vec![7; 65536]
    );
    assert_eq!(
        fs::read(fixture.path().join("left/file")).unwrap(),
        vec![7; 4 * 65536]
    );
    assert!(!fixture.path().join("right/file").exists());
    assert!(manager.finish_shutdown(&attempt));
}

#[test]
fn shutdown_reconciles_unknown_worker_outcome_but_retains_the_error_and_disables_retry() {
    let (entered_tx, entered) = mpsc::sync_channel(1);
    let (release, receive) = mpsc::sync_channel(1);
    let receive = Mutex::new(receive);
    let manager = OperationManager::with_executor(
        Arc::new(|_| {}),
        Arc::new(move |_, _| {
            entered_tx.send(()).unwrap();
            receive
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            panic!("unknown worker outcome");
        }),
    )
    .unwrap();
    let job = submit(&manager, 1, intent("unknown"));
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let attempt = start_shutdown(&manager, Duration::ZERO);
    assert!(!manager.finish_shutdown(&attempt));
    release.send(()).unwrap();
    idle(&manager);
    let job = manager.get(&job.id).unwrap();
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.error.unwrap().code, ErrorCode::Unavailable);
    assert!(!job.retryable);
    assert!(job.result.is_none());
    assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Ready);
    assert!(manager.finish_shutdown(&attempt));
}

#[test]
fn invalid_shutdown_duration_does_not_poison_or_change_the_registry() {
    let manager = stub();
    let before = manager.snapshot();
    assert!(manager.begin_shutdown(Duration::MAX, None).is_err());
    assert_eq!(manager.snapshot().revision, before.revision);
    assert!(manager.snapshot().accepting);
}

#[test]
fn shutdown_after_publication_gate_completes_the_copy_and_reconciles_before_or_after_timeout() {
    for timeout_first in [false, true] {
        let (fixture, intent) = fixture_copy();
        let (entered_tx, entered) = mpsc::sync_channel(1);
        let (release, receive) = mpsc::sync_channel(1);
        let gate = Mutex::new(receive);
        let manager = OperationManager::with_executor(
            Arc::new(|_| {}),
            Arc::new(move |intent, inner| {
                execute(
                    intent,
                    &mut BoundaryObserver {
                        inner,
                        gate: &gate,
                        entered: &entered_tx,
                        at_publication: true,
                        after_gate: true,
                        stopped: false,
                    },
                )
            }),
        )
        .unwrap();
        let job = submit(&manager, 1, intent);
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!manager.get(&job.id).unwrap().cancellable);
        let attempt = start_shutdown(&manager, Duration::ZERO);
        if timeout_first {
            assert!(!manager.finish_shutdown(&attempt));
            assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Blocked);
        }
        release.send(()).unwrap();
        idle(&manager);
        let job = manager.get(&job.id).unwrap();
        assert_eq!(job.state, JobState::Completed);
        assert!(!job.cancellation_requested);
        assert_eq!(job.progress.bytes_processed, 4 * 65536);
        assert_eq!(
            fs::read(fixture.path().join("right/file")).unwrap(),
            fs::read(fixture.path().join("left/file")).unwrap()
        );
        assert_eq!(manager.snapshot().shutdown_state, ShutdownState::Ready);
        assert!(manager.wait_shutdown(&attempt));
        assert!(manager.finish_shutdown(&attempt));
        assert!(!manager.finish_shutdown(&attempt));
    }
}

#[test]
fn force_exit_can_only_be_claimed_once_for_the_current_blocked_attempt() {
    let (manager, gate) = gated();
    submit(&manager, 1, intent("atomic"));
    receive(&gate);
    let attempt = start_shutdown(&manager, Duration::ZERO);
    assert!(manager.authorize_force_exit(Some(&attempt)).is_err());
    assert!(!manager.finish_shutdown(&attempt));
    assert!(manager.authorize_force_exit(Some(&attempt)).is_ok());
    assert!(manager.authorize_force_exit(Some(&attempt)).is_err());
    assert!(manager.keep_working(Some(&attempt)).is_err());
    assert!(!manager.finish_shutdown(&attempt));
    gate.release.send(()).unwrap();
    idle(&manager);
}

#[test]
fn namespace_jobs_invalidate_only_directory_source_subtrees_and_match_descendants() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("selected");
    fs::create_dir(&source).unwrap();
    fs::create_dir(source.join("child")).unwrap();
    let mut entry = crate::list_directory(ListRequest {
        target: DirectoryTarget::Path(NativePath::from_path(temp.path())),
        sort: SortKey::Name,
        direction: SortDirection::Ascending,
    })
    .unwrap()
    .entries
    .remove(0);
    let directory = entry.clone();
    let source_id = directory.path.clone();
    let target = NativePath::from_path(temp.path());
    let intents = [
        OperationIntent::Rename {
            source: directory.clone(),
            name: "renamed".into(),
        },
        OperationIntent::Move {
            source: directory.clone(),
            destination: target.clone(),
        },
        OperationIntent::Trash {
            source: directory.clone(),
        },
    ];
    for intent in intents {
        assert_eq!(intent.invalidated_subtrees(), vec![source_id.clone()]);
        let paths = [
            source_id.clone(),
            NativePath::from_path(&source.join("child")),
            NativePath::from_path(&temp.path().join("selected-other")),
        ];
        assert_eq!(
            crate::classify_operation_invalidation(
                &paths,
                &intent.affected(),
                &intent.invalidated_subtrees()
            )
            .unwrap(),
            vec![true, true, false]
        );
    }
    assert!(
        OperationIntent::Copy {
            source: directory,
            destination: target.clone()
        }
        .invalidated_subtrees()
        .is_empty()
    );
    entry.kind = crate::EntryKind::File;
    assert!(
        OperationIntent::Rename {
            source: entry,
            name: "file-new".into()
        }
        .invalidated_subtrees()
        .is_empty()
    );
}

#[test]
fn completion_invalidation_epoch_survives_history_eviction_and_dismissal() {
    let fixture = tempfile::tempdir().unwrap();
    let parent = NativePath::from_path(&fs::canonicalize(fixture.path()).unwrap());
    let manager = OperationManager::new(|_| {}).unwrap();
    let mut first = None;
    for sequence in 1..=70 {
        let job = submit(
            &manager,
            sequence,
            OperationIntent::Create {
                parent: parent.clone(),
                name: format!("epoch-{sequence}"),
            },
        );
        idle(&manager);
        let finished = manager.get(&job.id).unwrap();
        assert_eq!(finished.state, JobState::Completed);
        assert_eq!(finished.invalidation_revision, Some(sequence as u64));
        assert!(fixture.path().join(format!("epoch-{sequence}")).is_dir());
        if sequence == 1 {
            first = Some(job.id);
        }
    }
    let snapshot = manager.snapshot();
    assert_eq!(snapshot.invalidation_revision, 70);
    assert_eq!(snapshot.jobs.len(), MAX_HISTORY);
    assert!(manager.get(&first.unwrap()).is_err());
    assert_eq!(
        snapshot.jobs.first().unwrap().invalidation_revision,
        Some(7)
    );
    for job in snapshot.jobs {
        manager.dismiss(&job.id).unwrap();
    }
    assert!(manager.snapshot().jobs.is_empty());
    assert_eq!(manager.snapshot().invalidation_revision, 70);
    let failed = submit(
        &manager,
        71,
        OperationIntent::Create {
            parent,
            name: "epoch-70".into(),
        },
    );
    idle(&manager);
    assert_eq!(manager.get(&failed.id).unwrap().state, JobState::Failed);
    assert_eq!(
        manager.get(&failed.id).unwrap().invalidation_revision,
        Some(71)
    );
    assert_eq!(manager.snapshot().invalidation_revision, 71);
}

#[test]
fn queued_cancellation_does_not_claim_filesystem_execution_or_advance_invalidation() {
    let (manager, gate) = gated();
    let active = submit(&manager, 1, intent("active"));
    receive(&gate);
    let queued = submit(&manager, 2, intent("not-executed"));
    manager.cancel(&queued.id).unwrap();
    assert_eq!(manager.snapshot().invalidation_revision, 0);
    assert!(
        manager
            .get(&queued.id)
            .unwrap()
            .invalidation_revision
            .is_none()
    );
    gate.release.send(()).unwrap();
    idle(&manager);
    assert_eq!(
        manager.get(&active.id).unwrap().invalidation_revision,
        Some(1)
    );
    assert_eq!(manager.snapshot().invalidation_revision, 1);
    assert!(
        manager
            .get(&queued.id)
            .unwrap()
            .invalidation_revision
            .is_none()
    );
}
