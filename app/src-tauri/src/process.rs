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
                // Something else reaped the core, so its ids are no longer ours to signal.
                eprintln!("familiar: cannot wait for the core: {e}");
                *lock(&self.reaped) = true;
                return child.wait();
            }
            let mut reaped = lock(&self.reaped);
            kill_group(self.pid);
            // Does not block: the core is a zombie by now.
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

// The job object and the thread resume are adapted from tauri-plugin-shell's `job_object.rs`
// (Apache-2.0 OR MIT), see NOTICE.
#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::{mem, ptr};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
    };

    use super::*;

    pub struct Process {
        /// Holds the core and everything it starts. Open for as long as the generation lives,
        /// so a kill works at any time, also after the core itself exited.
        job: Job,
    }

    pub fn spawn(mut command: Command) -> io::Result<(Process, Child)> {
        let job = Job::new()?;
        // Suspended, so the core cannot start anything before it is in the job. This replaces
        // the flags set so far, hence `CREATE_NO_WINDOW` again.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        if let Err(e) = job.assign(&child).and_then(|()| resume_threads(child.id())) {
            // Do not leave a suspended core behind.
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

    /// An owned job object. Closing the handle kills every process in the job, so the core's
    /// tree also goes when Familiar dies without a chance to clean up.
    struct Job(HANDLE);

    // SAFETY: the handle is only ever passed to thread-safe Win32 calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        fn new() -> io::Result<Self> {
            // SAFETY: both arguments may be null: default security, no name.
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

    /// `std` closes the main thread's handle right after `CreateProcess`, so a suspended child
    /// can only be resumed by looking its threads up again.
    fn resume_threads(pid: u32) -> io::Result<()> {
        // SAFETY: plain call; the snapshot handle is closed below.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let result = resume_snapshot_threads(snapshot, pid);
        // SAFETY: the snapshot is open and not used after this.
        unsafe { CloseHandle(snapshot) };
        result
    }

    fn resume_snapshot_threads(snapshot: HANDLE, pid: u32) -> io::Result<()> {
        // SAFETY: the entry is plain data; `dwSize` is set as the API asks.
        let mut entry: THREADENTRY32 = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<THREADENTRY32>() as u32;
        // SAFETY: `snapshot` is open and `entry` is valid for the calls in this loop.
        let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == pid {
                // SAFETY: plain call; the thread handle is closed below.
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // SAFETY: `thread` is open with the right to resume it.
                let resumed = unsafe { ResumeThread(thread) };
                let error = io::Error::last_os_error();
                // SAFETY: `thread` is open and not used after this.
                unsafe { CloseHandle(thread) };
                if resumed == u32::MAX {
                    return Err(error);
                }
            }
            // SAFETY: as above.
            found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        Ok(())
    }
}
