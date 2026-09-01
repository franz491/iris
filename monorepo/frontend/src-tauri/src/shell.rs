// src-tauri/src/shell.rs — shell execution with safety modes + interactive PTY.
//
// Modes (per the safety ladder):
//   free          -> direct spawn on the host
//   approval      -> identical to free here; FE gates the call before invoke
//   docker_rw     -> docker run, default container user, writable mount
//   docker_readonly -> docker run, default container user, read-only mount
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[cfg(unix)]
mod unix_process {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
        fn setpgid(pid: i32, process_group: i32) -> i32;
    }

    pub unsafe fn start_process_group() -> std::io::Result<()> {
        if unsafe { setpgid(0, 0) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    pub unsafe fn kill_process_group(pid: u32) {
        // Negative pid targets the process group on POSIX systems.
        let _ = unsafe { kill(-(pid as i32), 9) };
    }
}

#[derive(Clone, Serialize)]
pub struct ShellResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub cwd: String,
}

fn docker_exe() -> String {
    std::env::var("IRIS_DOCKER_EXE").unwrap_or_else(|_| "docker".to_string())
}

fn docker_image() -> String {
    std::env::var("IRIS_DOCKER_IMAGE").unwrap_or_else(|_| "alpine:latest".to_string())
}

fn timeout_ms() -> u64 {
    std::env::var("IRIS_SHELL_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60_000)
}

fn terminate_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        unix_process::kill_process_group(child.id());
    }
    let _ = child.kill();
}

/// Spawn a process capturing output, with a hard timeout.
fn spawn_captured(
    program: &str,
    args: &[&str],
    working_folder: &str,
) -> Result<ShellResult, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    if working_folder.trim().is_empty() {
        return Err("a working folder must be configured".to_string());
    }
    const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
    let mut child = Command::new(program);
    child.args(args).current_dir(working_folder);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        child.pre_exec(|| unix_process::start_process_group());
    }
    let mut child = child
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed: {}", e))?;

    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    // Keep producer memory bounded. A bounded channel also applies backpressure
    // to pipe readers, preventing a noisy child from filling an unbounded queue.
    const CAPTURE_QUEUE_CHUNKS: usize = 64;
    let (sender, receiver) = mpsc::sync_channel::<(bool, Vec<u8>)>(CAPTURE_QUEUE_CHUNKS);
    let pipes: [(bool, Box<dyn Read + Send>); 2] =
        [(true, Box::new(stdout)), (false, Box::new(stderr))];
    for (is_stdout, mut pipe) in pipes {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if sender.send((is_stdout, buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(sender);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms());

    let mut out_buf = Vec::new();
    let mut err_buf = Vec::new();
    let mut closed_pipes = 0;
    loop {
        if Instant::now() > deadline {
            terminate_child(&mut child);
            return Err(format!("command timed out after {}ms", timeout_ms()));
        }
        while let Ok((is_stdout, bytes)) = receiver.try_recv() {
            let target = if is_stdout {
                &mut out_buf
            } else {
                &mut err_buf
            };
            let remaining = MAX_CAPTURE_BYTES.saturating_sub(target.len());
            target.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        }
        if closed_pipes == 2 {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("wait failed: {}", e))?
            {
                return Ok(ShellResult {
                    code: status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&out_buf).to_string(),
                    stderr: String::from_utf8_lossy(&err_buf).to_string(),
                    cwd: working_folder.to_string(),
                });
            }
        }
        if receiver.try_recv().is_err() {
            if let Ok((is_stdout, bytes)) = receiver.recv_timeout(Duration::from_millis(10)) {
                let target = if is_stdout {
                    &mut out_buf
                } else {
                    &mut err_buf
                };
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(target.len());
                target.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
            } else {
                closed_pipes += 1;
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                while let Ok((is_stdout, bytes)) = receiver.try_recv() {
                    let target = if is_stdout {
                        &mut out_buf
                    } else {
                        &mut err_buf
                    };
                    let remaining = MAX_CAPTURE_BYTES.saturating_sub(target.len());
                    target.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                }
                return Ok(ShellResult {
                    code: status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&out_buf).to_string(),
                    stderr: String::from_utf8_lossy(&err_buf).to_string(),
                    cwd: working_folder.to_string(),
                });
            }
            Ok(None) => {}
            Err(e) => return Err(format!("wait failed: {}", e)),
        }
    }
}

#[tauri::command]
pub fn tool_shell_oneshot(
    command: String,
    mode: String,
    working_folder: String,
) -> Result<ShellResult, String> {
    match mode.as_str() {
        "free" | "approval" | "host" => spawn_captured("sh", &["-c", &command], &working_folder),
        "docker_rw" | "docker_readonly" => {
            let exe = docker_exe();
            let image = docker_image();
            let mount = if mode == "docker_readonly" {
                format!("{}:/sandbox:ro", working_folder)
            } else {
                format!("{}:/sandbox", working_folder)
            };
            let mut args: Vec<String> = vec![
                "run".into(),
                "--rm".into(),
                "--network=none".into(),
                "--cpus=2".into(),
                "--memory=512m".into(),
                "--pids-limit=128".into(),
                "--cap-drop=ALL".into(),
                "--security-opt=no-new-privileges".into(),
                "--read-only".into(),
                "--tmpfs".into(),
                "/tmp:rw,noexec,nosuid,size=64m".into(),
                "--user".into(),
                "65532:65532".into(),
                "-v".into(),
                mount,
                "-w".into(),
                "/sandbox".into(),
            ];
            args.push(image);
            args.push("sh".into());
            args.push("-c".into());
            args.push(command);
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let mut result = spawn_captured(&exe, &arg_refs, &working_folder)?;
            result.cwd = "/sandbox".to_string();
            Ok(result)
        }
        other => Err(format!("unknown shell mode: {}", other)),
    }
}

// ---------- interactive sessions (PTY) ----------

type WriterBox = Mutex<Box<dyn std::io::Write + Send>>;
type ChildBox = Box<dyn portable_pty::Child + Send + Sync>;

type MasterBox = Mutex<Box<dyn portable_pty::MasterPty + Send>>;

const MAX_INTERACTIVE_SESSIONS: usize = 32;
const MAX_INTERACTIVE_COMMAND_BYTES: usize = 64 * 1024;
const MAX_INTERACTIVE_WRITE_BYTES: usize = 64 * 1024;
const MAX_INTERACTIVE_OUTPUT_BYTES: usize = 1024 * 1024;
const PTY_EVENT_QUEUE_CHUNKS: usize = 64;
const PTY_EVENT_CHUNK_BYTES: usize = 16 * 1024;

fn output_budget_allows(emitted: usize, next_chunk: usize) -> bool {
    emitted.saturating_add(next_chunk) <= MAX_INTERACTIVE_OUTPUT_BYTES
}

fn validate_interactive_request(command: &str, active_sessions: usize) -> Result<(), String> {
    if active_sessions >= MAX_INTERACTIVE_SESSIONS {
        return Err(format!(
            "too many active shell sessions (limit {})",
            MAX_INTERACTIVE_SESSIONS
        ));
    }
    if command.len() > MAX_INTERACTIVE_COMMAND_BYTES {
        return Err(format!(
            "interactive shell command exceeds {} bytes",
            MAX_INTERACTIVE_COMMAND_BYTES
        ));
    }
    Ok(())
}

pub struct SessionStore {
    pub writers: Arc<Mutex<HashMap<String, WriterBox>>>,
    pub children: Arc<Mutex<HashMap<String, ChildBox>>>,
    pub masters: Arc<Mutex<HashMap<String, MasterBox>>>,
}

pub fn init_session_store() -> SessionStore {
    SessionStore {
        writers: Arc::new(Mutex::new(HashMap::new())),
        children: Arc::new(Mutex::new(HashMap::new())),
        masters: Arc::new(Mutex::new(HashMap::new())),
    }
}

fn cleanup_session(
    session_id: &str,
    writers: &Arc<Mutex<HashMap<String, WriterBox>>>,
    children: &Arc<Mutex<HashMap<String, ChildBox>>>,
    masters: &Arc<Mutex<HashMap<String, MasterBox>>>,
) {
    writers.lock().unwrap().remove(session_id);
    masters.lock().unwrap().remove(session_id);
    if let Some(mut child) = children.lock().unwrap().remove(session_id) {
        #[cfg(unix)]
        unsafe {
            if let Some(pid) = child.process_id() {
                unix_process::kill_process_group(pid);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Clone, Serialize)]
pub struct SessionInfo {
    pub session_id: String,
}

#[tauri::command]
pub fn tool_shell_interactive(
    app: AppHandle,
    command: String,
    sessions: State<'_, SessionStore>,
) -> Result<SessionInfo, String> {
    use std::io::Write;

    let active_sessions = sessions.children.lock().unwrap().len();
    validate_interactive_request(&command, active_sessions)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {}", e))?;

    let cmd = CommandBuilder::new("sh");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {}", e))?;

    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = uuid::Uuid::new_v4().to_string();

    if !command.trim().is_empty() {
        let _ = writeln!(writer, "{}", command);
    }

    let session_id = session_id.clone();
    // Register all owned resources before starting reader/event threads. A
    // shell can exit immediately; registration after spawning would let its
    // cleanup race insert stale entries into the store.
    sessions
        .writers
        .lock()
        .unwrap()
        .insert(session_id.clone(), Mutex::new(writer));
    sessions
        .masters
        .lock()
        .unwrap()
        .insert(session_id.clone(), Mutex::new(pair.master));
    sessions
        .children
        .lock()
        .unwrap()
        .insert(session_id.clone(), child);

    // Keep the reader and event delivery separately bounded. A synchronous
    // channel applies backpressure to a noisy PTY. The event consumer also
    // enforces a hard per-session budget because emit may return before the
    // webview has drained its own downstream queue.
    let (event_tx, event_rx) = std::sync::mpsc::sync_channel::<String>(PTY_EVENT_QUEUE_CHUNKS);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut pending = Vec::with_capacity(PTY_EVENT_CHUNK_BYTES);
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    while pending.len() >= PTY_EVENT_CHUNK_BYTES {
                        let chunk: Vec<u8> = pending.drain(..PTY_EVENT_CHUNK_BYTES).collect();
                        if event_tx
                            .send(String::from_utf8_lossy(&chunk).to_string())
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
        }
        if !pending.is_empty() {
            let _ = event_tx.send(String::from_utf8_lossy(&pending).to_string());
        }
    });
    let event_sid = session_id.clone();
    let event_app = app.clone();
    let event_writers = Arc::clone(&sessions.writers);
    let event_children = Arc::clone(&sessions.children);
    let event_masters = Arc::clone(&sessions.masters);
    std::thread::spawn(move || {
        let mut emitted = 0;
        for text in event_rx {
            if !output_budget_allows(emitted, text.len()) {
                let _ = event_app.emit(
                    &format!("shell-truncated-{}", event_sid),
                    "interactive shell output limit reached",
                );
                let _ = event_app.emit(
                    &format!("shell-closed-{}", event_sid),
                    "interactive shell output truncated",
                );
                cleanup_session(&event_sid, &event_writers, &event_children, &event_masters);
                return;
            }
            emitted += text.len();
            if event_app
                .emit(&format!("shell-output-{}", event_sid), text)
                .is_err()
            {
                break;
            }
        }
        let _ = event_app.emit(&format!("shell-closed-{}", event_sid), "");
        cleanup_session(&event_sid, &event_writers, &event_children, &event_masters);
    });

    Ok(SessionInfo { session_id })
}

#[tauri::command]
pub fn tool_shell_write(
    session_id: String,
    data: String,
    sessions: State<'_, SessionStore>,
) -> Result<(), String> {
    use std::io::Write;
    if data.len() > MAX_INTERACTIVE_WRITE_BYTES {
        return Err(format!(
            "interactive shell write exceeds {} bytes",
            MAX_INTERACTIVE_WRITE_BYTES
        ));
    }
    let map = sessions.writers.lock().unwrap();
    if let Some(writer) = map.get(&session_id) {
        let mut guard = writer.lock().unwrap();
        guard
            .write_all(data.as_bytes())
            .map_err(|e| format!("write failed: {}", e))
    } else {
        Err(format!("no such session: {}", session_id))
    }
}

#[tauri::command]
pub fn tool_shell_close(
    session_id: String,
    sessions: State<'_, SessionStore>,
) -> Result<(), String> {
    cleanup_session(
        &session_id,
        &sessions.writers,
        &sessions.children,
        &sessions.masters,
    );
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::{
        output_budget_allows, spawn_captured, validate_interactive_request,
        MAX_INTERACTIVE_COMMAND_BYTES, MAX_INTERACTIVE_OUTPUT_BYTES, MAX_INTERACTIVE_SESSIONS,
        MAX_INTERACTIVE_WRITE_BYTES, PTY_EVENT_CHUNK_BYTES, PTY_EVENT_QUEUE_CHUNKS,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn captured_output_is_bounded() {
        let result = spawn_captured("sh", &["-c", "head -c 2000000 /dev/zero"], ".")
            .expect("command should finish");
        assert!(result.stdout.len() <= 1024 * 1024);
    }

    #[test]
    fn silent_commands_respect_the_deadline() {
        std::env::set_var("IRIS_SHELL_TIMEOUT_MS", "50");
        let started = Instant::now();
        let result = spawn_captured("sh", &["-c", "sleep 1"], ".");
        std::env::remove_var("IRIS_SHELL_TIMEOUT_MS");
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn interactive_sessions_are_bounded_before_spawning() {
        assert!(validate_interactive_request("echo ok", MAX_INTERACTIVE_SESSIONS).is_err());
        assert!(validate_interactive_request("echo ok", MAX_INTERACTIVE_SESSIONS - 1).is_ok());
    }

    #[test]
    fn interactive_command_size_is_bounded_before_spawning() {
        let command = "x".repeat(MAX_INTERACTIVE_COMMAND_BYTES + 1);
        assert!(validate_interactive_request(&command, 0).is_err());
        let command = "x".repeat(MAX_INTERACTIVE_COMMAND_BYTES);
        assert!(validate_interactive_request(&command, 0).is_ok());
    }

    #[test]
    fn interactive_write_and_event_limits_are_bounded() {
        assert_eq!(MAX_INTERACTIVE_WRITE_BYTES, 64 * 1024);
        assert_eq!(PTY_EVENT_CHUNK_BYTES, 16 * 1024);
        assert_eq!(PTY_EVENT_QUEUE_CHUNKS, 64);
    }

    #[test]
    fn interactive_output_budget_rejects_downstream_overflow() {
        assert!(output_budget_allows(0, MAX_INTERACTIVE_OUTPUT_BYTES));
        assert!(!output_budget_allows(1, MAX_INTERACTIVE_OUTPUT_BYTES));
        assert!(!output_budget_allows(usize::MAX, 1));
    }
}
