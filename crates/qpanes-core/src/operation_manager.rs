//! Process-owned, bounded, single-worker mutation queue. No desktop dependencies.
use crate::{
    CopyObserver, CopyProgress, CreateDirectoryRequest, Entry, ErrorCode, FsError, NativePath,
    OperationResult, RenameRequest, TransferRequest, TrashRequest,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MAX_ACTIVE: usize = 32;
pub const MAX_HISTORY: usize = 64;
const MAX_CLIENTS: usize = 64;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum OperationIntent {
    Copy {
        source: Entry,
        destination: NativePath,
    },
    Move {
        source: Entry,
        destination: NativePath,
    },
    Create {
        parent: NativePath,
        name: String,
    },
    Rename {
        source: Entry,
        name: String,
    },
    Trash {
        source: Entry,
    },
}
impl OperationIntent {
    fn source(&self) -> Option<&Entry> {
        match self {
            Self::Create { .. } => None,
            Self::Copy { source, .. }
            | Self::Move { source, .. }
            | Self::Rename { source, .. }
            | Self::Trash { source } => Some(source),
        }
    }
    fn destination(&self) -> Option<&NativePath> {
        match self {
            Self::Copy { destination, .. } | Self::Move { destination, .. } => Some(destination),
            Self::Create { parent, .. } => Some(parent),
            _ => None,
        }
    }
    fn affected(&self) -> Vec<NativePath> {
        let mut dirs = Vec::new();
        if !matches!(self, Self::Copy { .. })
            && let Some(path) = self.source().and_then(|entry| entry.path.to_path().ok())
            && let Some(parent) = path.parent()
        {
            dirs.push(NativePath::from_path(parent));
        }
        if let Some(path) = self.destination()
            && !dirs.contains(path)
        {
            dirs.push(path.clone());
        }
        dirs
    }
    fn invalidated_subtrees(&self) -> Vec<NativePath> {
        match self {
            Self::Rename { source, .. } | Self::Move { source, .. } | Self::Trash { source }
                if source.kind == crate::EntryKind::Directory =>
            {
                vec![source.path.clone()]
            }
            _ => Vec::new(),
        }
    }
    fn bounded(&self) -> bool {
        let source_ok = self.source().is_none_or(|entry| {
            entry.path.0.len() <= 131072
                && entry.name.len() <= 16384
                && entry.identity.as_ref().is_none_or(|id| id.len() <= 256)
                && entry
                    .metadata_error
                    .as_ref()
                    .is_none_or(|message| message.len() <= 16384)
        });
        let destination_ok = self.destination().is_none_or(|path| path.0.len() <= 131072);
        let name_ok = match self {
            Self::Create { name, .. } | Self::Rename { name, .. } => name.len() <= 16384,
            _ => true,
        };
        source_ok && destination_ok && name_ok
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitRequest {
    pub client_id: String,
    pub sequence: u32,
    pub intent: OperationIntent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Preparing,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}
impl JobState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
    fn permits(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Queued, Self::Preparing | Self::Cancelled)
                | (
                    Self::Preparing,
                    Self::Running | Self::Cancelled | Self::Failed
                )
                | (
                    Self::Running,
                    Self::Cancelling | Self::Completed | Self::Failed
                )
                | (Self::Cancelling, Self::Cancelled | Self::Failed)
        )
    }
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub current_item: Option<NativePath>,
    pub current_label: Option<String>,
    pub bytes_processed: u64,
    pub total_bytes: Option<u64>,
    pub completed_files: u64,
    pub total_files: Option<u64>,
    pub elapsed_ms: u64,
    pub bytes_per_second: Option<f64>,
    pub remaining_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJob {
    pub id: String,
    pub intent: OperationIntent,
    pub source_label: Option<String>,
    pub destination_label: Option<String>,
    pub affected_directories: Vec<NativePath>,
    pub invalidated_subtrees: Vec<NativePath>,
    /// Completed worker-attempt sequence, independent of retained history.
    pub invalidation_revision: Option<u64>,
    pub submitted_ms: u64,
    pub started_ms: Option<u64>,
    pub completed_ms: Option<u64>,
    pub state: JobState,
    pub progress: Progress,
    pub cancellation_requested: bool,
    pub cancellable: bool,
    pub result: Option<OperationResult>,
    pub error: Option<FsError>,
    pub retryable: bool,
    pub retry_of: Option<String>,
}
impl OperationJob {
    fn transition(&mut self, state: JobState) -> bool {
        if !self.state.permits(state) {
            return false;
        }
        self.state = state;
        if state.terminal() {
            self.completed_ms = Some(now_ms());
            self.cancellable = false;
        }
        true
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShutdownState {
    Idle,
    Draining,
    Blocked,
    Ready,
}
/// Opaque identity for one close prompt and its confirmed shutdown attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ShutdownAttempt(String);
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSnapshot {
    pub revision: u64,
    pub invalidation_revision: u64,
    pub jobs: Vec<OperationJob>,
    pub accepting: bool,
    pub close_requested: bool,
    pub shutdown_state: ShutdownState,
    pub shutdown_attempt: Option<ShutdownAttempt>,
}
struct Record {
    job: OperationJob,
    client: String,
    sequence: u32,
    cancellation: Arc<AtomicBool>,
}
struct Registry {
    revision: u64,
    invalidation_revision: u64,
    jobs: VecDeque<Record>,
    pending: VecDeque<String>,
    clients: HashMap<String, u32>,
    accepting: bool,
    close_requested: bool,
    shutdown_state: ShutdownState,
    shutdown_attempt: Option<ShutdownAttempt>,
    next_shutdown: u64,
    shutdown_deadline: Option<Instant>,
    stopping: bool,
    exiting: bool,
}
impl Registry {
    fn record(&mut self, id: &str) -> Result<&mut Record, FsError> {
        self.jobs
            .iter_mut()
            .find(|entry| entry.job.id == id)
            .ok_or_else(|| {
                error(
                    ErrorCode::InvalidOperation,
                    "This operation is no longer retained.",
                )
            })
    }
    fn active(&self) -> bool {
        self.jobs.iter().any(|record| !record.job.state.terminal())
    }
    fn prune(&mut self) {
        while self
            .jobs
            .iter()
            .filter(|record| record.job.state.terminal())
            .count()
            > MAX_HISTORY
        {
            if let Some(index) = self
                .jobs
                .iter()
                .position(|record| record.job.state.terminal())
            {
                self.jobs.remove(index);
            }
        }
    }
    fn ensure_shutdown_attempt(&mut self) -> ShutdownAttempt {
        if let Some(attempt) = &self.shutdown_attempt {
            return attempt.clone();
        }
        self.next_shutdown = self
            .next_shutdown
            .checked_add(1)
            .expect("shutdown attempt IDs exhausted");
        let attempt = ShutdownAttempt(self.next_shutdown.to_string());
        self.shutdown_attempt = Some(attempt.clone());
        attempt
    }
    fn reconcile_shutdown(&mut self) {
        // A terminal copy has returned from publication/cleanup; an atomic
        // primitive has returned. Unknown outcomes stay visible as job errors.
        if matches!(
            self.shutdown_state,
            ShutdownState::Draining | ShutdownState::Blocked
        ) && !self.active()
        {
            self.shutdown_state = ShutdownState::Ready;
        }
    }
    fn current_attempt(&self, attempt: &ShutdownAttempt) -> bool {
        self.shutdown_attempt.as_ref() == Some(attempt) && !self.exiting && !self.stopping
    }
    fn changed(&mut self) -> u64 {
        self.revision = self
            .revision
            .checked_add(1)
            .expect("operation revision exhausted");
        self.revision
    }
}
type Notifier = Arc<dyn Fn(u64) + Send + Sync>;
type Executor = Arc<
    dyn Fn(OperationIntent, &mut dyn CopyObserver) -> Result<OperationResult, FsError>
        + Send
        + Sync,
>;
struct Shared {
    registry: Mutex<Registry>,
    wake: Condvar,
    notify: Notifier,
}
impl Shared {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
    fn notify(&self, revision: u64) {
        self.wake.notify_all();
        // Transport failures/panics cannot stop the worker. Snapshots remain authoritative.
        let _ = catch_unwind(AssertUnwindSafe(|| (self.notify)(revision)));
    }
}
struct Owner {
    shared: Arc<Shared>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let mut registry = self.shared.lock();
        registry.stopping = true;
        cancel_all(&mut registry);
        drop(registry);
        self.shared.wake.notify_all();
    }
}
#[derive(Clone)]
pub struct OperationManager {
    owner: Arc<Owner>,
}
fn error(code: ErrorCode, message: impl Into<String>) -> FsError {
    FsError {
        code,
        message: message.into(),
        recovery: None,
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn label(path: &NativePath) -> Option<String> {
    path.to_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}
fn execute(
    intent: OperationIntent,
    observer: &mut dyn CopyObserver,
) -> Result<OperationResult, FsError> {
    match intent {
        OperationIntent::Copy {
            source,
            destination,
        } => crate::copy_entry_observed(
            TransferRequest {
                source,
                destination,
            },
            observer,
        ),
        OperationIntent::Move {
            source,
            destination,
        } => crate::move_entry(TransferRequest {
            source,
            destination,
        }),
        OperationIntent::Create { parent, name } => {
            crate::create_directory(CreateDirectoryRequest { parent, name })
        }
        OperationIntent::Rename { source, name } => {
            crate::rename_entry(RenameRequest { source, name })
        }
        OperationIntent::Trash { source } => crate::trash_entry(TrashRequest { source }),
    }
}
impl OperationManager {
    pub fn new(notify: impl Fn(u64) + Send + Sync + 'static) -> std::io::Result<Self> {
        Self::with_executor(Arc::new(notify), Arc::new(execute))
    }
    fn with_executor(notify: Notifier, executor: Executor) -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            registry: Mutex::new(Registry {
                revision: 0,
                invalidation_revision: 0,
                jobs: VecDeque::new(),
                pending: VecDeque::new(),
                clients: HashMap::new(),
                accepting: true,
                close_requested: false,
                shutdown_state: ShutdownState::Idle,
                shutdown_attempt: None,
                next_shutdown: 0,
                shutdown_deadline: None,
                stopping: false,
                exiting: false,
            }),
            wake: Condvar::new(),
            notify,
        });
        let worker = shared.clone();
        thread::Builder::new()
            .name("qpanes-operations".into())
            .spawn(move || worker_loop(worker, executor))?;
        Ok(Self {
            owner: Arc::new(Owner { shared }),
        })
    }
    fn shared(&self) -> &Shared {
        &self.owner.shared
    }
    pub fn snapshot(&self) -> OperationSnapshot {
        let registry = self.shared().lock();
        OperationSnapshot {
            revision: registry.revision,
            invalidation_revision: registry.invalidation_revision,
            jobs: registry
                .jobs
                .iter()
                .map(|record| record.job.clone())
                .collect(),
            accepting: registry.accepting,
            close_requested: registry.close_requested,
            shutdown_state: registry.shutdown_state,
            shutdown_attempt: registry.shutdown_attempt.clone(),
        }
    }
    pub fn get(&self, id: &str) -> Result<OperationJob, FsError> {
        Ok(self.shared().lock().record(id)?.job.clone())
    }
    pub fn submit(&self, request: SubmitRequest) -> Result<OperationJob, FsError> {
        self.admit(request, None)
    }
    fn admit(
        &self,
        request: SubmitRequest,
        retry_of: Option<String>,
    ) -> Result<OperationJob, FsError> {
        if request.client_id.is_empty()
            || request.client_id.len() > 64
            || request.sequence == 0
            || !request.intent.bounded()
        {
            return Err(error(
                ErrorCode::InvalidOperation,
                "Invalid or oversized operation submission.",
            ));
        }
        let shared = self.shared();
        let mut registry = shared.lock();
        if let Some(sequence) = registry.clients.get(&request.client_id)
            && request.sequence <= *sequence
        {
            return match registry.jobs.iter().find(|record| {
                record.client == request.client_id && record.sequence == request.sequence
            }) {
                Some(record)
                    if record.job.intent == request.intent && record.job.retry_of == retry_of =>
                {
                    Ok(record.job.clone())
                }
                _ => Err(error(
                    ErrorCode::DuplicateSubmission,
                    "This submission token was already consumed or expired. It will not execute again.",
                )),
            };
        }
        if !registry.accepting {
            return Err(error(
                ErrorCode::ShuttingDown,
                "QPanes is shutting down. Keep working to submit more operations.",
            ));
        }
        if registry
            .jobs
            .iter()
            .filter(|record| !record.job.state.terminal())
            .count()
            >= MAX_ACTIVE
        {
            return Err(error(
                ErrorCode::QueueFull,
                "The operation queue is full (32 active or queued jobs).",
            ));
        }
        if !registry.clients.contains_key(&request.client_id)
            && registry.clients.len() >= MAX_CLIENTS
        {
            return Err(error(
                ErrorCode::QueueFull,
                "The process submission-client limit was reached. Finish jobs and restart QPanes.",
            ));
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| error(ErrorCode::Unavailable, "Operation IDs exhausted."))?
            .to_string();
        let job = OperationJob {
            id: id.clone(),
            source_label: request.intent.source().and_then(|entry| label(&entry.path)),
            destination_label: request.intent.destination().and_then(label),
            affected_directories: request.intent.affected(),
            invalidated_subtrees: request.intent.invalidated_subtrees(),
            invalidation_revision: None,
            intent: request.intent,
            submitted_ms: now_ms(),
            started_ms: None,
            completed_ms: None,
            state: JobState::Queued,
            progress: Progress::default(),
            cancellation_requested: false,
            cancellable: true,
            result: None,
            error: None,
            retryable: false,
            retry_of,
        };
        registry
            .clients
            .insert(request.client_id.clone(), request.sequence);
        registry.pending.push_back(id);
        registry.jobs.push_back(Record {
            job: job.clone(),
            client: request.client_id,
            sequence: request.sequence,
            cancellation: Arc::new(AtomicBool::new(false)),
        });
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        Ok(job)
    }
    pub fn cancel(&self, id: &str) -> Result<OperationJob, FsError> {
        let shared = self.shared();
        let mut registry = shared.lock();
        let record = registry.record(id)?;
        if record.job.state == JobState::Cancelling {
            return Ok(record.job.clone());
        }
        if !record.job.cancellable || record.job.state.terminal() {
            return Err(error(
                ErrorCode::InvalidOperation,
                "This operation has finished or passed its safe cancellation boundary.",
            ));
        }
        request_cancel(record);
        let job = record.job.clone();
        registry.pending.retain(|pending| pending != id);
        registry.reconcile_shutdown();
        registry.prune();
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        Ok(job)
    }
    pub fn retry(
        &self,
        id: &str,
        client_id: String,
        sequence: u32,
    ) -> Result<OperationJob, FsError> {
        let original = self.get(id)?;
        if !original.retryable {
            return Err(error(
                ErrorCode::InvalidOperation,
                "This operation cannot be safely retried. Inspect the outcome and make a new selection.",
            ));
        }
        self.admit(
            SubmitRequest {
                client_id,
                sequence,
                intent: original.intent,
            },
            Some(id.into()),
        )
    }
    pub fn dismiss(&self, id: &str) -> Result<(), FsError> {
        let shared = self.shared();
        let mut registry = shared.lock();
        if !registry.record(id)?.job.state.terminal() {
            return Err(error(
                ErrorCode::InvalidOperation,
                "Active operations cannot be dismissed.",
            ));
        }
        registry.jobs.retain(|record| record.job.id != id);
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        Ok(())
    }
    /// Called by the desktop close/exit adapter. False means confirmation is needed.
    pub fn request_close(&self) -> bool {
        let shared = self.shared();
        let mut registry = shared.lock();
        if registry.exiting || !registry.active() {
            registry.accepting = false;
            registry.exiting = true;
            return true;
        }
        registry.ensure_shutdown_attempt();
        registry.close_requested = true;
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        false
    }
    pub fn keep_working(&self, attempt: Option<&ShutdownAttempt>) -> Result<(), FsError> {
        let shared = self.shared();
        let mut registry = shared.lock();
        if registry.exiting {
            return Err(error(ErrorCode::ShuttingDown, "QPanes is already exiting."));
        }
        if registry.shutdown_attempt.as_ref() != attempt {
            return Err(stale_shutdown());
        }
        registry.accepting = true;
        registry.close_requested = false;
        registry.shutdown_state = ShutdownState::Idle;
        registry.shutdown_attempt = None;
        registry.shutdown_deadline = None;
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        Ok(())
    }
    /// Start once per prompt; every timer and completion claimant carries its token.
    pub fn begin_shutdown(
        &self,
        grace: Duration,
        expected: Option<&ShutdownAttempt>,
    ) -> Result<Option<ShutdownAttempt>, FsError> {
        let deadline = Instant::now().checked_add(grace).ok_or_else(|| {
            error(
                ErrorCode::InvalidOperation,
                "Invalid shutdown grace period.",
            )
        })?;
        let shared = self.shared();
        let mut registry = shared.lock();
        if registry.shutdown_attempt.as_ref() != expected || registry.exiting {
            return Err(stale_shutdown());
        }
        if registry.shutdown_state != ShutdownState::Idle {
            return Ok(None);
        }
        let attempt = registry.ensure_shutdown_attempt();
        registry.accepting = false;
        registry.close_requested = true;
        registry.shutdown_state = ShutdownState::Draining;
        registry.shutdown_deadline = Some(deadline);
        cancel_all(&mut registry);
        registry.reconcile_shutdown();
        registry.prune();
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        Ok(Some(attempt))
    }
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let shared = self.shared();
        let registry = shared.lock();
        let (registry, _) = shared
            .wake
            .wait_timeout_while(registry, timeout, |registry| registry.active())
            .unwrap_or_else(|poison| poison.into_inner());
        !registry.active()
    }
    /// One off-UI-thread waiter per attempt. It stays cancellation-aware after
    /// the grace timeout so late completion can close normally. Keep working
    /// invalidates the token and wakes it immediately; no timer polling.
    pub fn wait_shutdown(&self, attempt: &ShutdownAttempt) -> bool {
        let shared = self.shared();
        let mut registry = shared.lock();
        loop {
            if !registry.current_attempt(attempt) {
                return false;
            }
            if registry.shutdown_state == ShutdownState::Ready {
                return true;
            }
            if registry.shutdown_state == ShutdownState::Draining {
                let remaining = registry
                    .shutdown_deadline
                    .unwrap_or_else(Instant::now)
                    .saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    registry.shutdown_state = ShutdownState::Blocked;
                    let revision = registry.changed();
                    drop(registry);
                    shared.notify(revision);
                    registry = shared.lock();
                } else {
                    (registry, _) = shared
                        .wake
                        .wait_timeout(registry, remaining)
                        .unwrap_or_else(|poison| poison.into_inner());
                }
            } else {
                registry = shared
                    .wake
                    .wait(registry)
                    .unwrap_or_else(|poison| poison.into_inner());
            }
        }
    }
    /// Claim normal exit exactly once; an obsolete callback cannot time out,
    /// close, or authorize force exit for a different attempt.
    pub fn finish_shutdown(&self, attempt: &ShutdownAttempt) -> bool {
        let shared = self.shared();
        let mut registry = shared.lock();
        if !registry.current_attempt(attempt) {
            return false;
        }
        registry.reconcile_shutdown();
        if registry.shutdown_state == ShutdownState::Ready {
            registry.exiting = true;
            return true;
        }
        if registry.shutdown_state == ShutdownState::Draining
            && registry
                .shutdown_deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
        {
            registry.shutdown_state = ShutdownState::Blocked;
            let revision = registry.changed();
            drop(registry);
            shared.notify(revision);
        }
        false
    }
    pub fn authorize_force_exit(&self, attempt: Option<&ShutdownAttempt>) -> Result<(), FsError> {
        let attempt = attempt.ok_or_else(stale_shutdown)?;
        let mut registry = self.shared().lock();
        if !registry.current_attempt(attempt) || registry.shutdown_state != ShutdownState::Blocked {
            return Err(stale_shutdown());
        }
        registry.exiting = true;
        Ok(())
    }
}
fn stale_shutdown() -> FsError {
    error(
        ErrorCode::InvalidOperation,
        "This close request is no longer current. Review the current shutdown state.",
    )
}

fn request_cancel(record: &mut Record) {
    record.cancellation.store(true, Ordering::Release);
    record.job.cancellation_requested = true;
    if matches!(record.job.state, JobState::Queued | JobState::Preparing) {
        record.job.transition(JobState::Cancelled);
    } else {
        record.job.transition(JobState::Cancelling);
    }
}
fn cancel_all(registry: &mut Registry) {
    for record in &mut registry.jobs {
        if record.job.cancellable && !record.job.state.terminal() {
            request_cancel(record);
        }
    }
    registry.pending.clear();
}
fn worker_loop(shared: Arc<Shared>, executor: Executor) {
    loop {
        let mut registry = shared.lock();
        while registry.pending.is_empty() && !registry.stopping {
            registry = shared
                .wake
                .wait(registry)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        if registry.stopping {
            return;
        }
        let Some(id) = registry.pending.pop_front() else {
            continue;
        };
        let Ok(record) = registry.record(&id) else {
            continue;
        };
        if !record.job.transition(JobState::Preparing) {
            continue;
        }
        record.job.started_ms = Some(now_ms());
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        let mut registry = shared.lock();
        let Ok(record) = registry.record(&id) else {
            continue;
        };
        if !record.job.transition(JobState::Running) {
            continue;
        }
        record.job.cancellable = matches!(record.job.intent, OperationIntent::Copy { .. });
        let intent = record.job.intent.clone();
        let cancellation = record.cancellation.clone();
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
        let mut observer = ManagedObserver::new(shared.clone(), id.clone(), cancellation);
        let outcome = catch_unwind(AssertUnwindSafe(|| executor(intent, &mut observer)));
        observer.report(&observer.latest.clone(), true);
        let mut registry = shared.lock();
        let Ok(record) = registry.record(&id) else {
            continue;
        };
        record.job.progress.elapsed_ms = millis(observer.started.elapsed());
        record.job.progress.bytes_per_second = None;
        record.job.progress.remaining_ms = None;
        match outcome {
            Ok(Ok(result)) => {
                // Copy's gate closes cancellation before publication. Non-copy primitives
                // also close it before execution. Success must never be rewritten Cancelled.
                if record.job.transition(JobState::Completed) {
                    record.job.result = Some(result);
                } else {
                    record.job.transition(JobState::Failed);
                    record.job.error = Some(FsError::operation_unavailable());
                }
            }
            Ok(Err(error)) => {
                let cancelled = matches!(
                    error.code,
                    ErrorCode::Cancelled | ErrorCode::CancellationCleanupFailed
                );
                if cancelled && record.job.state == JobState::Running {
                    record.job.transition(JobState::Cancelling);
                }
                record.job.transition(if cancelled {
                    JobState::Cancelled
                } else {
                    JobState::Failed
                });
                record.job.retryable = !cancelled
                    && !matches!(record.job.intent, OperationIntent::Trash { .. })
                    && !matches!(
                        error.code,
                        ErrorCode::Unavailable
                            | ErrorCode::SourceChanged
                            | ErrorCode::UnsupportedEntry
                            | ErrorCode::UnsupportedPlatform
                            | ErrorCode::InvalidPath
                            | ErrorCode::CounterOverflow
                    );
                record.job.error = Some(error);
            }
            Err(_) => {
                record.job.transition(JobState::Failed);
                record.job.error = Some(FsError::operation_unavailable());
            }
        }
        // Even a failed attempt can leave staging or an unknown namespace
        // outcome. Stamp its terminal result atomically with a process counter
        // that survives dismissal/eviction, so readers can detect missed work.
        let invalidation_revision = registry
            .invalidation_revision
            .checked_add(1)
            .expect("filesystem invalidation revision exhausted");
        registry
            .record(&id)
            .expect("executing job retained")
            .job
            .invalidation_revision = Some(invalidation_revision);
        registry.invalidation_revision = invalidation_revision;
        registry.reconcile_shutdown();
        registry.prune();
        let revision = registry.changed();
        drop(registry);
        shared.notify(revision);
    }
}
fn millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}
struct ManagedObserver {
    latest: CopyProgress,
    shared: Arc<Shared>,
    id: String,
    cancellation: Arc<AtomicBool>,
    started: Instant,
    last_report: Instant,
    last_bytes: u64,
    samples: u32,
    speed: Option<f64>,
}
impl ManagedObserver {
    fn new(shared: Arc<Shared>, id: String, cancellation: Arc<AtomicBool>) -> Self {
        let started = Instant::now();
        Self {
            latest: CopyProgress::default(),
            shared,
            id,
            cancellation,
            started,
            last_report: started,
            last_bytes: 0,
            samples: 0,
            speed: None,
        }
    }
    fn report(&mut self, progress: &CopyProgress, force: bool) {
        let now = Instant::now();
        let delta = now.duration_since(self.last_report);
        if !force && delta < PROGRESS_INTERVAL {
            return;
        }
        let bytes = progress.bytes_processed.saturating_sub(self.last_bytes);
        if delta >= PROGRESS_INTERVAL {
            self.samples = self.samples.saturating_add(1);
            let measured = bytes as f64 / delta.as_secs_f64();
            self.speed = if bytes == 0 {
                None
            } else {
                Some(
                    self.speed
                        .map_or(measured, |old| old * 0.7 + measured * 0.3),
                )
            };
            self.last_report = now;
            self.last_bytes = progress.bytes_processed;
        }
        let speed = (self.samples >= 3 && self.started.elapsed() >= Duration::from_millis(500))
            .then_some(self.speed)
            .flatten();
        let remaining_ms = speed.and_then(|speed| {
            progress
                .total_bytes
                .and_then(|total| total.checked_sub(progress.bytes_processed))
                .filter(|remaining| *remaining > 0)
                .map(|remaining| (remaining as f64 / speed * 1000.0).min(u64::MAX as f64) as u64)
        });
        let mut registry = self.shared.lock();
        let Ok(record) = registry.record(&self.id) else {
            return;
        };
        if record.job.state.terminal() {
            return;
        }
        record.job.progress = Progress {
            current_item: progress.current_item.clone(),
            current_label: progress.current_label.clone(),
            bytes_processed: progress.bytes_processed,
            total_bytes: progress.total_bytes,
            completed_files: progress.completed_files,
            total_files: progress.total_files,
            elapsed_ms: millis(now.duration_since(self.started)),
            bytes_per_second: speed,
            remaining_ms,
        };
        let revision = registry.changed();
        drop(registry);
        self.shared.notify(revision);
    }
}
impl CopyObserver for ManagedObserver {
    fn checkpoint(&mut self, progress: &CopyProgress) -> Result<(), FsError> {
        self.latest = progress.clone();
        if self.cancellation.load(Ordering::Acquire) {
            self.report(progress, true);
            return Err(error(
                ErrorCode::Cancelled,
                "Copy cancelled before publication. The source was left intact.",
            ));
        }
        self.report(progress, false);
        Ok(())
    }
    fn begin_publication(&mut self, progress: &CopyProgress) -> Result<(), FsError> {
        self.latest = progress.clone();
        self.report(progress, true);
        let mut registry = self.shared.lock();
        let record = registry.record(&self.id)?;
        if record.job.cancellation_requested {
            return Err(error(
                ErrorCode::Cancelled,
                "Copy cancelled before publication. The source was left intact.",
            ));
        }
        record.job.cancellable = false;
        let revision = registry.changed();
        drop(registry);
        self.shared.notify(revision);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
