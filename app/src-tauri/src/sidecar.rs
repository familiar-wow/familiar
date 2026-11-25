//! The core runs as the sidecar `familiar-core`. Rust owns the child: the pages only see lines,
//! events and the sticky [`SidecarState`], so a page that loads late still knows where things are.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

pub const NOT_RUNNING: &str = "The core is not running.";
pub const DID_NOT_STOP: &str = "The old core did not stop. Quit Familiar and start it again.";
const SHUTDOWN: &[u8] = b"{\"id\":\"quit\",\"method\":\"shutdown\"}\n";
const STDERR_TAIL: usize = 20;
const QUIT_GRACE: Duration = Duration::from_secs(3);
const KILL_WAIT: Duration = Duration::from_secs(2);
const RESTART_WAIT: Duration = Duration::from_secs(10);

/// Lines for the core's stdin thread.
type Writer = mpsc::Sender<Vec<u8>>;

/// A poisoned lock only means another thread panicked while holding it; the data is still usable,
/// and these paths must not panic in turn.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarState {
    // `gen` is a reserved word in Rust 2024.
    #[serde(rename = "gen")]
    generation: u64,
    running: bool,
    /// `None` until this generation exited; then its code, `null` when a signal ended it.
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<Option<i32>>,
    stderr_tail: VecDeque<String>,
}

#[derive(Clone, Serialize)]
struct LinePayload<'a> {
    #[serde(rename = "gen")]
    generation: u64,
    line: &'a str,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    #[serde(rename = "gen")]
    generation: u64,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct StartedPayload {
    #[serde(rename = "gen")]
    generation: u64,
}

/// Set once a generation's termination was handled, after its `sidecar-exit` went out.
#[derive(Default)]
struct Done {
    ended: Mutex<bool>,
    cv: Condvar,
}

impl Done {
    fn set(&self) {
        *lock(&self.ended) = true;
        self.cv.notify_all();
    }

    fn wait(&self, timeout: Duration) -> bool {
        let ended = lock(&self.ended);
        match self.cv.wait_timeout_while(ended, timeout, |ended| !*ended) {
            Ok((ended, _)) => *ended,
            Err(e) => *e.into_inner().0,
        }
    }
}

struct Inner {
    state: SidecarState,
    /// Feeds the stdin thread, which owns the `CommandChild`. Dropped once the core ended, which
    /// ends that thread.
    writer: Option<Writer>,
    /// The running core's process id, for kills that must not wait behind a blocked write.
    pid: Option<u32>,
    done: Arc<Done>,
    /// Set by a quit, so a restart waiting behind it does not start a new core.
    quitting: bool,
}

pub struct Sidecar {
    inner: Mutex<Inner>,
    /// Serialises restart and quit. Never taken by the output pump, so waiting under it is safe.
    ops: Mutex<()>,
}

impl Sidecar {
    pub fn new() -> Self {
        Sidecar {
            inner: Mutex::new(Inner {
                state: SidecarState {
                    generation: 0,
                    running: false,
                    exit_code: None,
                    stderr_tail: VecDeque::new(),
                },
                writer: None,
                pid: None,
                done: Arc::new(Done::default()),
                quitting: false,
            }),
            ops: Mutex::new(()),
        }
    }

    pub fn state(&self) -> SidecarState {
        lock(&self.inner).state.clone()
    }

    /// Queues `line` for the core's stdin. The queue keeps the callers' order and never blocks.
    pub fn send(&self, line: &str) -> Result<(), String> {
        let inner = lock(&self.inner);
        let writer = match (&inner.writer, inner.state.running) {
            (Some(writer), true) => writer,
            _ => return Err(NOT_RUNNING.into()),
        };
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        writer.send(bytes).map_err(|_| NOT_RUNNING.to_string())
    }

    /// The running generation's stdin queue, process id and termination signal.
    fn current(&self) -> Option<(Writer, u32, Arc<Done>)> {
        let inner = lock(&self.inner);
        match (&inner.writer, inner.pid, inner.state.running) {
            (Some(writer), Some(pid), true) => Some((writer.clone(), pid, inner.done.clone())),
            _ => None,
        }
    }
}

/// Kills the core and everything it started, without going through its stdin thread: that
/// thread may hang in a write to a core that stopped reading, and the kill has to get through.
/// Called only while the generation still runs (its `finish` has not happened), and the core
/// leads its own process group, so the id cannot belong to another program yet.
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    let mut command = {
        let mut c = std::process::Command::new("kill");
        c.args(["-KILL", "--", &format!("-{pid}")]);
        c
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("taskkill");
        c.args(["/F", "/T", "/PID", &pid.to_string()]);
        // No console window flashing up for the kill.
        c.creation_flags(0x0800_0000);
        c
    };
    match command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("familiar: killing the core exited with {status}"),
        Err(e) => eprintln!("familiar: cannot kill the core: {e}"),
    }
}

fn args() -> Vec<OsString> {
    let mut args = vec![OsString::from("sidecar")];
    if let Some(settings) = std::env::var_os("FAMILIAR_SETTINGS").filter(|s| !s.is_empty()) {
        args.push("--settings".into());
        args.push(settings);
    }
    args
}

/// Starts the first core. Called from `setup`.
pub fn start(app: &AppHandle) {
    spawn_next(app);
}

/// Starts generation `gen + 1` and publishes it. A failed start becomes an exited generation
/// with the reason in `stderrTail`, so the page shows the error state instead of waiting.
fn spawn_next(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    let generation = lock(&sidecar.inner).state.generation + 1;
    let done = Arc::new(Done::default());

    match spawn_child(app, generation) {
        Ok((events, writer, pid)) => {
            {
                let mut inner = lock(&sidecar.inner);
                inner.state = SidecarState {
                    generation,
                    running: true,
                    exit_code: None,
                    stderr_tail: VecDeque::new(),
                };
                inner.writer = Some(writer);
                inner.pid = Some(pid);
                inner.done = done.clone();
            }
            emit(app, "sidecar-started", StartedPayload { generation });
            // The pump starts after `sidecar-started`, so a core that dies at once still
            // reports its exit after its start.
            tauri::async_runtime::spawn(pump(app.clone(), generation, events, done));
        }
        Err(reason) => {
            let reason = format!("Could not start the core: {reason}");
            eprintln!("familiar: {reason}");
            {
                let mut inner = lock(&sidecar.inner);
                inner.state = SidecarState {
                    generation,
                    running: false,
                    exit_code: Some(None),
                    stderr_tail: VecDeque::from([reason]),
                };
                inner.writer = None;
                inner.pid = None;
                inner.done = done.clone();
            }
            emit(app, "sidecar-started", StartedPayload { generation });
            emit(
                app,
                "sidecar-exit",
                ExitPayload {
                    generation,
                    code: None,
                },
            );
            done.set();
        }
    }
}

fn spawn_child(
    app: &AppHandle,
    generation: u64,
) -> Result<(Receiver<CommandEvent>, Writer, u32), String> {
    let (events, child) = app
        .shell()
        .sidecar("familiar-core")
        .map_err(|e| e.to_string())?
        .args(args())
        // The core leads its own process group on Unix, so `kill_tree` also takes what it
        // started (an agent such as `hermes acp`); on Windows `taskkill /T` follows the tree.
        .set_process_group(true)
        // No kill on drop: the child is dropped after it ended, and a group kill then could hit
        // a reused process id. Dropping it closes its stdin, which ends a core that still runs.
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.pid();
    let (writer, queue) = mpsc::channel();
    // Writes block, so they get their own thread, off the main thread and the runtime. If the
    // thread cannot start, the child is dropped, its stdin closes and the core leaves.
    std::thread::Builder::new()
        .name(format!("core-stdin-{generation}"))
        .spawn(move || stdin_loop(child, queue))
        .map_err(|e| e.to_string())?;
    Ok((events, writer, pid))
}

/// Writes queued lines until the queue closes, which `finish` does once the core ended; then the
/// child is dropped. A write stuck on a core that stopped reading comes free when it is killed.
fn stdin_loop(mut child: CommandChild, queue: mpsc::Receiver<Vec<u8>>) {
    let mut broken = false;
    for bytes in queue {
        if broken {
            continue;
        }
        if let Err(e) = child.write(&bytes) {
            // The core is gone or going; its `Terminated` follows. Say it once.
            eprintln!("familiar: cannot write to the core: {e}");
            broken = true;
        }
    }
}

/// Forwards one generation's output until it ends, then records the end.
async fn pump(
    app: AppHandle,
    generation: u64,
    mut events: Receiver<CommandEvent>,
    done: Arc<Done>,
) {
    let mut code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                if let Some(line) = text(&bytes) {
                    emit(
                        &app,
                        "sidecar-line",
                        LinePayload {
                            generation,
                            line: &line,
                        },
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                if let Some(line) = text(&bytes) {
                    eprintln!("familiar-core: {line}");
                    {
                        let sidecar = app.state::<Sidecar>();
                        let mut inner = lock(&sidecar.inner);
                        if inner.state.generation == generation {
                            let tail = &mut inner.state.stderr_tail;
                            if tail.len() == STDERR_TAIL {
                                tail.pop_front();
                            }
                            tail.push_back(line.clone());
                        }
                    }
                    emit(
                        &app,
                        "sidecar-stderr",
                        LinePayload {
                            generation,
                            line: &line,
                        },
                    );
                }
            }
            CommandEvent::Error(e) => eprintln!("familiar: core output: {e}"),
            CommandEvent::Terminated(payload) => {
                // `Terminated` is the last event; the readers have drained by now.
                code = payload.code;
                break;
            }
            _ => {}
        }
    }
    // The channel also closes without `Terminated` when waiting for the child failed.
    finish(&app, generation, code, &done);
}

fn finish(app: &AppHandle, generation: u64, code: Option<i32>, done: &Done) {
    let writer = {
        let sidecar = app.state::<Sidecar>();
        let mut inner = lock(&sidecar.inner);
        if inner.state.generation == generation {
            inner.state.running = false;
            inner.state.exit_code = Some(code);
            inner.pid = None;
            inner.writer.take()
        } else {
            None
        }
    };
    // Dropped outside the lock: this ends the stdin thread.
    drop(writer);
    emit(app, "sidecar-exit", ExitPayload { generation, code });
    done.set();
}

/// One line as text, with only the trailing line break removed. The shell plugin also splits at
/// a lone `\r`, so a `\r\n` cut between two reads leaves an empty line, which is dropped.
fn text(bytes: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim_end_matches(['\r', '\n']);
    (!line.is_empty()).then(|| line.to_string())
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        eprintln!("familiar: cannot emit {event}: {e}");
    }
}

/// Kills the current core (if any), waits until its exit was handled, then starts the next one.
/// A core that does not end is not left behind for a second one: the restart fails instead.
pub async fn restart(app: AppHandle) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let sidecar = app.state::<Sidecar>();
        let _ops = lock(&sidecar.ops);
        if lock(&sidecar.inner).quitting {
            return Ok(());
        }
        if let Some((_, pid, done)) = sidecar.current() {
            kill_tree(pid);
            if !done.wait(RESTART_WAIT) {
                eprintln!("familiar: the old core did not end in time; no new one started");
                return Err(DID_NOT_STOP.to_string());
            }
        }
        // The app may have begun to exit while this waited.
        if !lock(&sidecar.inner).quitting {
            spawn_next(&app);
        }
        Ok(())
    })
    .await;
    result.unwrap_or_else(|e| {
        eprintln!("familiar: restart failed: {e}");
        Err(DID_NOT_STOP.to_string())
    })
}

/// Graceful quit: ask the core to shut down, give it 3 s, kill it if needed, then exit.
pub fn quit(app: AppHandle) {
    let fallback = app.clone();
    let spawned = std::thread::Builder::new()
        .name("quit".into())
        .spawn(move || {
            let sidecar = app.state::<Sidecar>();
            let _ops = lock(&sidecar.ops);
            lock(&sidecar.inner).quitting = true;
            if let Some((writer, pid, done)) = sidecar.current() {
                let _ = writer.send(SHUTDOWN.to_vec());
                drop(writer);
                if !done.wait(QUIT_GRACE) {
                    kill_tree(pid);
                    if !done.wait(KILL_WAIT) {
                        eprintln!("familiar: the core did not end; exiting anyway");
                    }
                }
            }
            app.exit(0);
        });
    if let Err(e) = spawned {
        // `RunEvent::Exit` still kills the core.
        eprintln!("familiar: cannot quit gracefully: {e}");
        fallback.exit(0);
    }
}

/// On any normal end of the app: kill a core that still runs, and everything it started.
pub fn kill_on_exit(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    lock(&sidecar.inner).quitting = true;
    if let Some((_, pid, _)) = sidecar.current() {
        kill_tree(pid);
    }
}
