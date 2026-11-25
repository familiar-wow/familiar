//! The core's process, owned by Familiar itself, so a kill always reaches the whole tree and
//! never a stranger: on Unix the core leads a process group that is only signalled while the
//! core is not reaped, on Windows it lives in a job object that Familiar holds the handle of.

use std::io;
use std::process::{Child, Command, ExitStatus};

pub use imp::Process;

/// Starts `command` as the leader of its own tree. The `Child` goes to the one thread that
/// waits for it; kills go through the `Process`.
pub fn spawn(command: Command) -> io::Result<(Process, Child)> {
    imp::spawn(command)
}

#[cfg(unix)]
mod imp {
    use std::os::unix::process::CommandExt;
    use std::sync::Mutex;

    use super::*;
    use crate::sidecar::lock;

    pub struct Process {
        /// The core's process id, which is also its process group id.
        pid: libc::pid_t,
        /// True once the core was reaped. Until then its zombie keeps both ids reserved; after
        /// that they may belong to another program. So every signal and the reap itself happen
        /// under this lock, and nothing is signalled once it is true.
        reaped: Mutex<bool>,
    }

    pub fn spawn(mut command: Command) -> io::Result<(Process, Child)> {
        // Its own group, so one signal also takes what the core started (an agent such as
        // `hermes acp`).
        command.process_group(0);
        let child = command.spawn()?;
        let process = Process {
            pid: child.id() as libc::pid_t,
            reaped: Mutex::new(false),
        };
        Ok((process, child))
    }

    impl Process {
        /// Kills the core and everything in its group. Does nothing once the core was reaped.
        pub fn kill(&self) {
            let reaped = lock(&self.reaped);
            if !*reaped {
                kill_group(self.pid);
            }
        }

        /// Blocks until the core exited, kills what is left of its group, then reaps it.
        /// Called once, by the thread that owns `child`.
        pub fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
            if let Err(e) = wait_unreaped(self.pid) {
                eprintln!("familiar: cannot wait for the core: {e}");
                if e.raw_os_error() == Some(libc::ECHILD) {
                    // Something else reaped the core, so its ids are no longer ours to signal.
                    *lock(&self.reaped) = true;
                    return child.wait();
                }
                // Any other failure says nothing about the core, which may still run: it is
                // still ours and unreaped, so kill it and its group before the reap below.
            }
            let mut reaped = lock(&self.reaped);
            kill_group(self.pid);
            // Does not block for long: the core is a zombie by now, or was just killed.
            let status = child.wait();
            *reaped = true;
            status
        }
    }

    /// Waits until the process exited and leaves it as a zombie (`WNOWAIT`).
    fn wait_unreaped(pid: libc::pid_t) -> io::Result<()> {
        loop {
            // SAFETY: `siginfo_t` is plain data that `waitid` fills in; all zero is valid.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: `info` is a valid pointer for the call; `pid` is our own child.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn kill_group(pgid: libc::pid_t) {
        // SAFETY: only sends a signal. The caller holds the lock and the leader is not reaped,
        // so the group id is still the core's.
        if unsafe { libc::killpg(pgid, libc::SIGKILL) } == 0 {
            return;
        }
        let error = io::Error::last_os_error();
        // ESRCH: nobody left. EPERM: macOS says so for a group of zombies; elsewhere a member
        // that changed its user, which is not ours to kill.
        if !matches!(error.raw_os_error(), Some(libc::ESRCH | libc::EPERM)) {
            eprintln!("familiar: cannot kill the core: {error}");
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::{mem, ptr};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };

    use super::*;

    pub struct Process {
        /// Holds the core and everything it starts. Open for as long as the generation lives,
        /// so a kill works at any time, also after the core itself exited.
        job: Job,
    }

    pub fn spawn(mut command: Command) -> io::Result<(Process, Child)> {
        let job = Job::new()?;
        // The core goes into the job right after it started. It starts programs of its own
        // only when the app asks it over stdin, which cannot happen before this returns, and
        // processes started after the assignment are in the job too.
        let mut child = command.spawn()?;
        if let Err(e) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        Ok((Process { job }, child))
    }

    impl Process {
        /// Kills the core and everything it started.
        pub fn kill(&self) {
            if let Err(e) = self.job.terminate() {
                eprintln!("familiar: cannot kill the core: {e}");
            }
        }

        /// Blocks until the core exited, then kills what it left behind.
        /// Called once, by the thread that owns `child`.
        pub fn wait(&self, child: &mut Child) -> io::Result<ExitStatus> {
            let status = child.wait();
            self.kill();
            status
        }
    }

    /// A job object that kills every process in it when its last handle closes, so the core's
    /// tree also goes when Familiar dies without a chance to clean up.
    struct Job(HANDLE);

    // SAFETY: the handle is only passed to Win32 calls that may come from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        fn new() -> io::Result<Self> {
            // SAFETY: both arguments may be null: default security, no name. The handle is not
            // inheritable, so no child keeps the job alive.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(handle);
            // SAFETY: the struct is plain data; all zero means "no limits".
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: the pointer and the size describe `limits`, which outlives the call.
            let set = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast::<c_void>(),
                    mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if set == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: both handles are open: the job is ours, the child was just spawned.
            if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        fn terminate(&self) -> io::Result<()> {
            // SAFETY: the handle stays open until `drop`.
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is open and not used after this.
            unsafe { CloseHandle(self.0) };
        }
    }
}
