//! The core runs as the sidecar `familiar-core`. Rust owns the process: the pages only see lines,
//! events and the sticky [`SidecarState`], so a page that loads late still knows where things are.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

use crate::process::{self, Process};

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
    /// The number of the last line in `stderr_tail`; 0 before the first line. Lines count from
    /// 1 per generation, so a page can tell a line it already has from a new one with the
    /// same text.
    stderr_seq: u64,
}

impl SidecarState {
    fn new(generation: u64, running: bool) -> Self {
        SidecarState {
            generation,
            running,
            exit_code: None,
            stderr_tail: VecDeque::new(),
            stderr_seq: 0,
        }
    }

    /// Appends a stderr line and returns its number.
    fn push_stderr(&mut self, line: String) -> u64 {
        if self.stderr_tail.len() == STDERR_TAIL {
            self.stderr_tail.pop_front();
        }
        self.stderr_tail.push_back(line);
        self.stderr_seq += 1;
        self.stderr_seq
    }
}

#[derive(Clone, Serialize)]
struct LinePayload<'a> {
    #[serde(rename = "gen")]
    generation: u64,
    line: &'a str,
}

#[derive(Clone, Serialize)]
struct StderrPayload<'a> {
    #[serde(rename = "gen")]
    generation: u64,
    seq: u64,
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
    /// Feeds the stdin thread. Dropped once the core ended, which ends that thread.
    writer: Option<Writer>,
    /// The running generation's process, for kills. They never wait behind a blocked write.
    process: Option<Arc<Process>>,
    done: Arc<Done>,
    /// Set by a quit, so a restart waiting behind it does not start a new core.
    quitting: bool,
}

pub struct Sidecar {
    inner: Mutex<Inner>,
    /// Serialises restart and quit. Never taken by a generation's threads, so waiting under it
    /// is safe.
    ops: Mutex<()>,
}

impl Sidecar {
    pub fn new() -> Self {
        Sidecar {
            inner: Mutex::new(Inner {
                state: SidecarState::new(0, false),
                writer: None,
                process: None,
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

    /// The running generation's stdin queue, process and termination signal.
    fn current(&self) -> Option<(Writer, Arc<Process>, Arc<Done>)> {
        let inner = lock(&self.inner);
        match (&inner.writer, &inner.process, inner.state.running) {
            (Some(writer), Some(process), true) => {
                Some((writer.clone(), process.clone(), inner.done.clone()))
            }
            _ => None,
        }
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

/// The command for the core. The shell plugin only resolves the bundled binary and sets up the
/// pipes (and no console window on Windows); spawning and supervising is ours, see `process`.
fn command(app: &AppHandle) -> Result<Command, String> {
    let command = app
        .shell()
        .sidecar("familiar-core")
        .map_err(|e| e.to_string())?
        .args(args());
    Ok(command.into())
}

/// Starts the first core. Called from `setup`.
pub fn start(app: &AppHandle) {
    spawn_next(app);
}

/// Starts generation `gen + 1` and publishes it. A failed start becomes an exited generation
/// with the reason as its only stderr line, so the page shows the error state instead of
/// waiting.
fn spawn_next(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    let generation = lock(&sidecar.inner).state.generation + 1;
    let done = Arc::new(Done::default());

    let spawned = command(app).and_then(|c| process::spawn(c).map_err(|e| e.to_string()));
    let (process, child) = match spawned {
        Ok(spawned) => spawned,
        Err(reason) => {
            let reason = format!("Could not start the core: {reason}");
            eprintln!("familiar: {reason}");
            let mut state = SidecarState::new(generation, false);
            state.exit_code = Some(None);
            let seq = state.push_stderr(reason.clone());
            {
                let mut inner = lock(&sidecar.inner);
                inner.state = state;
                inner.writer = None;
                inner.process = None;
                inner.done = done.clone();
            }
            emit(app, "sidecar-started", StartedPayload { generation });
            emit(
                app,
                "sidecar-stderr",
                StderrPayload {
                    generation,
                    seq,
                    line: &reason,
                },
            );
            emit(
                app,
                "sidecar-exit",
                ExitPayload {
                    generation,
                    code: None,
                },
            );
            done.set();
            return;
        }
    };

    let process = Arc::new(process);
    let (writer, queue) = mpsc::channel();
    {
        let mut inner = lock(&sidecar.inner);
        inner.state = SidecarState::new(generation, true);
        inner.writer = Some(writer);
        inner.process = Some(process.clone());
        inner.done = done.clone();
    }
    emit(app, "sidecar-started", StartedPayload { generation });
    // The generation's threads start after `sidecar-started`, so a core that dies at once
    // still reports its lines and its exit after its start.
    let supervisor = {
        let (app, process, done) = (app.clone(), process.clone(), done.clone());
        thread::Builder::new()
            .name(format!("core-{generation}"))
            .spawn(move || supervise(app, generation, &process, child, queue, &done))
    };
    if let Err(e) = supervisor {
        // Nobody waits for this core now. It is never reaped, so its ids stay its own and the
        // kill is safe.
        process.kill();
        let reason = format!("Could not start the core: {e}");
        eprintln!("familiar: {reason}");
        stderr_line(app, generation, &reason);
        finish(app, generation, None, &done);
    }
}

/// One generation from start to end, on its own thread.
fn supervise(
    app: AppHandle,
    generation: u64,
    process: &Process,
    child: Child,
    queue: mpsc::Receiver<Vec<u8>>,
    done: &Done,
) {
    let (out, err) = (app.clone(), app.clone());
    let code = run(
        generation,
        process,
        child,
        queue,
        move |line| {
            emit(
                &out,
                "sidecar-line",
                LinePayload {
                    generation,
                    line: &line,
                },
            );
        },
        move |line| {
            eprintln!("familiar-core: {line}");
            stderr_line(&err, generation, &line);
        },
    );
    finish(&app, generation, code, done);
}

/// Feeds the core's stdin from `queue`, hands its output on line by line, and returns its exit
/// code once all of this happened, in this order: the core exited, what it left running was
/// killed, it was reaped, and both readers reached the end of their pipe. The pipes close when
/// their last holder is dead, so no line can follow.
fn run(
    generation: u64,
    process: &Process,
    mut child: Child,
    queue: mpsc::Receiver<Vec<u8>>,
    on_stdout: impl FnMut(String) + Send + 'static,
    on_stderr: impl FnMut(String) + Send + 'static,
) -> Option<i32> {
    let mut readers = Vec::new();
    let served = serve(
        generation,
        &mut child,
        queue,
        on_stdout,
        on_stderr,
        &mut readers,
    );
    if let Err(e) = served {
        // A core that cannot be fed or heard is of no use.
        eprintln!("familiar: cannot talk to the core: {e}");
        process.kill();
    }
    let code = match process.wait(&mut child) {
        Ok(status) => status.code(),
        Err(e) => {
            eprintln!("familiar: cannot wait for the core: {e}");
            None
        }
    };
    for reader in readers {
        let _ = reader.join();
    }
    code
}

/// Starts the threads for the core's three pipes. The readers started so far are in `readers`
/// also when a later step fails.
fn serve(
    generation: u64,
    child: &mut Child,
    queue: mpsc::Receiver<Vec<u8>>,
    on_stdout: impl FnMut(String) + Send + 'static,
    on_stderr: impl FnMut(String) + Send + 'static,
    readers: &mut Vec<JoinHandle<()>>,
) -> io::Result<()> {
    let missing = || io::Error::other("a pipe is missing");
    let stdin = child.stdin.take().ok_or_else(missing)?;
    let stdout = child.stdout.take().ok_or_else(missing)?;
    let stderr = child.stderr.take().ok_or_else(missing)?;
    let named = |pipe: &str| thread::Builder::new().name(format!("core-{pipe}-{generation}"));
    // Writes block, so they get their own thread, which holds no lock. Nobody joins it: a write
    // stuck on a core that stopped reading comes free when the core is killed.
    named("stdin").spawn(move || stdin_loop(stdin, queue))?;
    readers.push(named("stdout").spawn(move || read_lines(BufReader::new(stdout), on_stdout))?);
    readers.push(named("stderr").spawn(move || read_lines(BufReader::new(stderr), on_stderr))?);
    Ok(())
}

/// Writes queued lines until the queue closes, which `finish` does once the core ended and a
/// quit does by dropping its sender. Returning drops `stdin`, and a core that still runs
/// leaves at that end of input.
fn stdin_loop(mut stdin: ChildStdin, queue: mpsc::Receiver<Vec<u8>>) {
    let mut broken = false;
    for bytes in queue {
        if broken {
            continue;
        }
        if let Err(e) = stdin.write_all(&bytes) {
            // The core is gone or going; its exit follows. Say it once.
            eprintln!("familiar: cannot write to the core: {e}");
            broken = true;
        }
    }
}

/// Calls `each` for every line until the pipe ends. Lines have no length limit: `logs.recent`
/// answers with hundreds of log lines as one.
fn read_lines(mut pipe: impl BufRead, mut each: impl FnMut(String)) {
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        match pipe.read_until(b'\n', &mut bytes) {
            Ok(0) => break,
            Ok(_) => {
                if let Some(line) = text(&bytes) {
                    each(line);
                }
            }
            Err(e) => {
                eprintln!("familiar: core output: {e}");
                break;
            }
        }
    }
}

/// One line as text, with only the trailing line break removed. Empty lines are dropped.
fn text(bytes: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim_end_matches(['\r', '\n']);
    (!line.is_empty()).then(|| line.to_string())
}

/// Records a stderr line of `generation` under its number and tells the pages.
fn stderr_line(app: &AppHandle, generation: u64, line: &str) {
    let seq = {
        let sidecar = app.state::<Sidecar>();
        let mut inner = lock(&sidecar.inner);
        // Cannot differ: the next generation only starts after this one's readers ended.
        if inner.state.generation != generation {
            return;
        }
        inner.state.push_stderr(line.to_string())
    };
    emit(
        app,
        "sidecar-stderr",
        StderrPayload {
            generation,
            seq,
            line,
        },
    );
}

fn finish(app: &AppHandle, generation: u64, code: Option<i32>, done: &Done) {
    let ended = {
        let sidecar = app.state::<Sidecar>();
        let mut inner = lock(&sidecar.inner);
        if inner.state.generation == generation {
            inner.state.running = false;
            inner.state.exit_code = Some(code);
            (inner.writer.take(), inner.process.take())
        } else {
            (None, None)
        }
    };
    // Dropped outside the lock: this ends the stdin thread, and on Windows closes the job.
    drop(ended);
    emit(app, "sidecar-exit", ExitPayload { generation, code });
    done.set();
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
        if let Some((writer, process, done)) = sidecar.current() {
            drop(writer);
            process.kill();
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
    let spawned = thread::Builder::new().name("quit".into()).spawn(move || {
        let sidecar = app.state::<Sidecar>();
        let _ops = lock(&sidecar.ops);
        lock(&sidecar.inner).quitting = true;
        if let Some((writer, process, done)) = sidecar.current() {
            let _ = writer.send(SHUTDOWN.to_vec());
            drop(writer);
            if !done.wait(QUIT_GRACE) {
                process.kill();
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

/// On any normal end of the app: kill a core that still runs, and everything it started, and
/// give its supervisor a moment to see it gone.
pub fn kill_on_exit(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    lock(&sidecar.inner).quitting = true;
    if let Some((writer, process, done)) = sidecar.current() {
        drop(writer);
        process.kill();
        if !done.wait(KILL_WAIT) {
            eprintln!("familiar: the core did not end; exiting anyway");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(pipe: impl BufRead) -> Vec<String> {
        let mut lines = Vec::new();
        read_lines(pipe, |line| lines.push(line));
        lines
    }

    #[test]
    fn lines_lose_only_their_line_break() {
        let input = &b"one\r\n\n\r\n  two \n\xff!\na\rb\nlast"[..];
        assert_eq!(lines(input), ["one", "  two ", "\u{fffd}!", "a\rb", "last"]);
    }

    #[test]
    fn a_long_line_stays_one_line() {
        let input = format!("{}\nend\n", "x".repeat(300_000));
        // A small buffer, so the line spans many reads.
        let lines = lines(BufReader::with_capacity(64, input.as_bytes()));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 300_000);
        assert_eq!(lines[1], "end");
    }

    #[test]
    fn stderr_lines_are_numbered_and_the_tail_keeps_the_last() {
        let mut state = SidecarState::new(1, true);
        assert_eq!(state.stderr_seq, 0);
        for n in 1..=25 {
            assert_eq!(state.push_stderr(format!("line {n}")), n);
        }
        assert_eq!(state.stderr_seq, 25);
        assert_eq!(state.stderr_tail.len(), STDERR_TAIL);
        // What the pages rely on: the tail's numbers end at `stderr_seq` without a gap.
        let first = state.stderr_seq - state.stderr_tail.len() as u64 + 1;
        for (line, n) in state.stderr_tail.iter().zip(first..) {
            assert_eq!(line, &format!("line {n}"));
        }
    }

    #[test]
    fn the_pages_get_the_agreed_json() {
        let mut state = SidecarState::new(3, true);
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            serde_json::json!({"gen": 3, "running": true, "stderrTail": [], "stderrSeq": 0})
        );
        let seq = state.push_stderr("oops".into());
        state.running = false;
        state.exit_code = Some(None);
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            serde_json::json!({
                "gen": 3, "running": false, "exitCode": null, "stderrTail": ["oops"], "stderrSeq": 1
            })
        );
        let payload = StderrPayload {
            generation: 3,
            seq,
            line: "oops",
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({"gen": 3, "seq": 1, "line": "oops"})
        );
    }
}

/// Fake cores (shell scripts) run through `run`, the whole of a generation but its events.
/// Linux only: the tests read `/proc` to see what is left of a process group.
#[cfg(all(test, target_os = "linux"))]
mod process_tests {
    use std::process::Stdio;
    use std::time::Instant;

    use super::*;

    fn fake_core(script: &str) -> (Arc<Process>, Child) {
        let mut command = Command::new("sh");
        command
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (process, child) = process::spawn(command).unwrap();
        (Arc::new(process), child)
    }

    fn collect() -> (Arc<Mutex<Vec<String>>>, impl FnMut(String) + Send + 'static) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        (lines, move |line| lock(&sink).push(line))
    }

    /// The living processes of a group. A zombie that waits for init to reap it is not one.
    fn group(pgid: u32) -> Vec<u32> {
        let mut members = Vec::new();
        for entry in std::fs::read_dir("/proc").unwrap().flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse().ok()) else {
                continue;
            };
            // "pid (name) state ppid pgrp …"; the name may hold spaces and brackets.
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let Some((_, rest)) = stat.rsplit_once(')') else {
                continue;
            };
            let mut fields = rest.split_whitespace();
            let state = fields.next();
            let pgrp = fields.nth(1).and_then(|f| f.parse::<u32>().ok());
            if pgrp == Some(pgid) && !matches!(state, Some("Z" | "X")) {
                members.push(pid);
            }
        }
        members
    }

    /// A kill takes a moment to arrive, so look for a while before calling it a survivor.
    fn group_is_gone(pgid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let members = group(pgid);
            if members.is_empty() {
                return true;
            }
            if Instant::now() > deadline {
                eprintln!("left of group {pgid}: {members:?}");
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn nothing_stays_of_a_core_that_left_by_itself() {
        // The child and the grandchildren hold the core's pipes, as an agent would: the
        // readers only reach the end when they are dead.
        let (process, child) = fake_core(
            "sh -c 'sleep 30 & sleep 31' & sleep 0.3; echo started; echo oops >&2; exit 3",
        );
        let pgid = child.id();
        assert_eq!(group(pgid).len(), 1);
        let (_writer, queue) = mpsc::channel();
        let (out, on_stdout) = collect();
        let (err, on_stderr) = collect();
        let started = Instant::now();

        let code = run(1, &process, child, queue, on_stdout, on_stderr);

        assert_eq!(code, Some(3));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(*lock(&out), ["started"]);
        assert_eq!(*lock(&err), ["oops"]);
        assert!(group_is_gone(pgid));
        // After the reap this must be a no-op: the ids may be someone else's by now.
        process.kill();
    }

    #[test]
    fn a_core_that_hangs_is_killed_with_its_children() {
        let (process, child) = fake_core("trap '' TERM HUP; sleep 30 & echo ready; exec sleep 31");
        let pgid = child.id();
        let (writer, queue) = mpsc::channel();
        // More than a pipe holds, so the stdin thread hangs in a write when the kill comes.
        for _ in 0..64 {
            writer.send(vec![b'x'; 8192]).unwrap();
        }
        let (ready, is_ready) = mpsc::channel();
        let runner = {
            let process = process.clone();
            let on_stdout = move |line| {
                let _ = ready.send(line);
            };
            thread::spawn(move || run(1, &process, child, queue, on_stdout, |_| {}))
        };
        assert_eq!(
            is_ready.recv_timeout(Duration::from_secs(10)).unwrap(),
            "ready"
        );
        assert_eq!(group(pgid).len(), 2);
        let killed = Instant::now();

        process.kill();

        assert_eq!(runner.join().unwrap(), None);
        assert!(killed.elapsed() < Duration::from_secs(5));
        assert!(group_is_gone(pgid));
    }

    #[test]
    fn the_core_gets_its_lines_and_leaves_when_stdin_closes() {
        let (process, child) = fake_core("while read -r l; do echo \"got $l\"; done; echo bye");
        let pgid = child.id();
        let (writer, queue) = mpsc::channel();
        writer.send(b"hello\n".to_vec()).unwrap();
        drop(writer);
        let (out, on_stdout) = collect();

        let code = run(1, &process, child, queue, on_stdout, |_| {});

        assert_eq!(code, Some(0));
        assert_eq!(*lock(&out), ["got hello", "bye"]);
        assert!(group_is_gone(pgid));
    }
}
