// src-tauri/src/filejail.rs — jailed file read/write.
// All paths resolve under a configurable root (default ./files); absolute
// escapes and symlink traversal are rejected, mirroring backend rules.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::io;
#[cfg(any(unix, windows))]
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WRITE_INPUT_BYTES: usize = 24 * 1024 * 1024;

/// Resolve a user-supplied relative path inside the jail.
/// Rejects absolute paths, any ".." component, and symlinked components.
pub fn safe_resolve(root: &str, filename: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("an allowed root folder must be configured".to_string());
    }
    let p = Path::new(filename);
    if p.is_absolute() || filename.starts_with('/') || filename.starts_with('~') {
        return Err(format!("absolute paths not allowed: {}", filename));
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("\"..\" not allowed: {}", filename));
    }
    let root = PathBuf::from(root);
    if let Ok(metadata) = std::fs::symlink_metadata(&root) {
        if metadata.file_type().is_symlink() {
            return Err("symlinked root folders are not allowed".to_string());
        }
    }
    let resolved = root.join(p);

    // walk from root, rejecting symlinks on every component
    let mut cur = root.clone();
    for comp in p.components() {
        cur.push(comp);
        match std::fs::symlink_metadata(&cur) {
            Ok(md) => {
                if md.file_type().is_symlink() {
                    return Err(format!("symlink traversal disallowed: {}", filename));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => break, // will be created
            Err(e) => return Err(format!("io error: {}", e)),
        }
    }
    Ok(resolved)
}

#[tauri::command]
pub fn tool_file_read(
    root: String,
    filename: String,
    encoding: Option<String>,
) -> Result<String, String> {
    let path = safe_resolve(&root, &filename)?;
    if encoding.as_deref() == Some("base64") {
        let bytes = read_bounded(Path::new(&root), &path)?;
        Ok(BASE64.encode(bytes))
    } else {
        let bytes = read_bounded(Path::new(&root), &path)?;
        String::from_utf8(bytes).map_err(|e| format!("read failed: {}", e))
    }
}

#[tauri::command]
pub fn tool_file_write(
    root: String,
    filename: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let path = safe_resolve(&root, &filename)?;
    if content.len() > MAX_WRITE_INPUT_BYTES {
        return Err(format!(
            "write input exceeds {} bytes",
            MAX_WRITE_INPUT_BYTES
        ));
    }
    let bytes = if encoding.as_deref() == Some("base64") {
        BASE64
            .decode(content)
            .map_err(|e| format!("invalid base64: {}", e))?
    } else {
        content.into_bytes()
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {} bytes", MAX_FILE_BYTES));
    }
    atomic_write(Path::new(&root), &path, &bytes).map_err(|e| format!("write failed: {}", e))
}

fn read_bounded(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        read_bounded_nofollow(root, path)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path);
        Err("safe jailed reads are unsupported on this platform".to_string())
    }
}

#[cfg(unix)]
fn read_bounded_nofollow(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use std::os::unix::io::FromRawFd;
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "path escaped jail".to_string())?;
    let root_c =
        std::ffi::CString::new(root.as_os_str().as_encoded_bytes()).map_err(|_| "invalid root")?;
    let fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("read failed: unable to open jail root".to_string());
    }
    let mut dir = fd;
    let mut components = rel.components().peekable();
    while let Some(component) = components.next() {
        let name = match component {
            Component::Normal(n) => n,
            _ => {
                unsafe {
                    libc::close(dir);
                }
                return Err("invalid jailed path".into());
            }
        };
        let c = std::ffi::CString::new(name.as_encoded_bytes()).map_err(|_| "invalid path")?;
        let flags = if components.peek().is_some() {
            libc::O_RDONLY | libc::O_DIRECTORY
        } else {
            libc::O_RDONLY
        };
        let next =
            unsafe { libc::openat(dir, c.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        unsafe {
            libc::close(dir);
        }
        if next < 0 {
            return Err("read failed: file not found or symlink traversal disallowed".into());
        }
        dir = next;
    }
    let file = unsafe { std::fs::File::from_raw_fd(dir) };
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {} bytes", MAX_FILE_BYTES));
    }
    Ok(bytes)
}

/// Write through a sibling temporary file and rename it into place.
///
/// Keeping the temporary file in the destination directory makes the rename
/// atomic on the same filesystem. On Unix, rename also replaces a destination
/// symlink itself rather than following it, closing the validation/write
/// check-then-use window for the final path component.
fn atomic_write(root: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        atomic_write_nofollow(root, path, bytes)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, path, bytes);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "safe jailed writes are unsupported on this platform",
        ))
    }
}

/* Windows support intentionally remains fail-closed: CreateFileW with
OPEN_REPARSE_POINT does not protect intermediate components. */
/*
    use std::os::windows::ffi::OsStrExt;
    if path.as_os_str().to_string_lossy().contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    Ok(path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect())
}

#[cfg(windows)]
fn windows_open(
    path: &Path,
    access: u32,
    disposition: u32,
    directory: bool,
) -> io::Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let wide = windows_wide(path)?;
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            disposition,
            flags,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { std::fs::File::from_raw_handle(handle as _) })
    }
}

#[cfg(windows)]
fn read_bounded_windows(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_READ, FILE_OPEN};
    let _root_handle = windows_open(root, FILE_GENERIC_READ, FILE_OPEN, true)
        .map_err(|_| "read failed: unable to open jail root".to_string())?;
    let file = windows_open(path, FILE_GENERIC_READ, FILE_OPEN, false)
        .map_err(|_| "read failed: file not found or reparse traversal disallowed".to_string())?;
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {} bytes", MAX_FILE_BYTES));
    }
    Ok(bytes)
}

#[cfg(windows)]
fn atomic_write_windows(root: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, CREATE_NEW, FILE_GENERIC_WRITE, MOVEFILE_REPLACE_EXISTING,
    };
    std::fs::create_dir_all(root)?;
    let temp = path.with_file_name(format!(".iris-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = windows_open(&temp, FILE_GENERIC_WRITE, CREATE_NEW, false)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    let from = windows_wide(&temp)?;
    let to = windows_wide(path)?;
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
    if ok == 0 {
        let _ = std::fs::remove_file(&temp);
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
*/

#[cfg(unix)]
struct OwnedFd(libc::c_int);

#[cfg(unix)]
impl Drop for OwnedFd {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}

#[cfg(unix)]
fn cstring(value: &std::ffi::OsStr) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(value.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

#[cfg(unix)]
fn open_directory_at(parent: libc::c_int, name: &std::ffi::OsStr) -> io::Result<OwnedFd> {
    let name = cstring(name)?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(OwnedFd(fd))
    }
}

#[cfg(unix)]
fn atomic_write_nofollow(root: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::io::FromRawFd;

    std::fs::create_dir_all(root)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path escaped jail"))?;
    let components: Vec<_> = relative.components().collect();
    let (file_component, parents) = components
        .split_last()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "write path is empty"))?;
    let file_name = match file_component {
        Component::Normal(name) => *name,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid write path",
            ))
        }
    };

    let root_name = cstring(root.as_os_str())?;
    let root_fd = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut directory = OwnedFd(root_fd);
    for component in parents {
        let name = match component {
            Component::Normal(name) => *name,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid write path",
                ))
            }
        };
        match open_directory_at(directory.0, name) {
            Ok(next) => directory = next,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name_c = cstring(name)?;
                let created = unsafe { libc::mkdirat(directory.0, name_c.as_ptr(), 0o700) };
                if created < 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(io::Error::last_os_error());
                }
                directory = open_directory_at(directory.0, name)?;
            }
            Err(error) => return Err(error),
        }
    }

    let target = cstring(file_name)?;
    let temporary = std::ffi::CString::new(format!(".iris-{}.tmp", uuid::Uuid::new_v4()))
        .expect("UUID temporary name contains no NUL");
    let temporary_fd = unsafe {
        libc::openat(
            directory.0,
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if temporary_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(temporary_fd) };
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if unsafe {
            libc::renameat(
                directory.0,
                temporary.as_ptr(),
                directory.0,
                target.as_ptr(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fsync(directory.0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(directory.0, temporary.as_ptr(), 0);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "iris-filejail-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock before epoch")
                    .as_nanos()
            ));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn atomic_write_replaces_symlink_without_touching_outside_target() {
        let temp = TempDir::new();
        let outside = temp.0.join("outside.txt");
        let destination = temp.0.join("destination.txt");
        fs::write(&outside, b"outside-secret").expect("write outside target");

        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &destination).expect("create adversarial symlink");

        #[cfg(unix)]
        {
            atomic_write(&temp.0, &destination, b"jail-content").expect("atomic write");
            assert_eq!(
                fs::read(&outside).expect("read outside target"),
                b"outside-secret"
            );
            assert_eq!(
                fs::read(&destination).expect("read destination"),
                b"jail-content"
            );
            assert!(!fs::symlink_metadata(&destination)
                .expect("stat destination")
                .file_type()
                .is_symlink());
        }
    }

    #[test]
    fn failed_write_does_not_leave_a_partial_destination() {
        let temp = TempDir::new();
        let destination = temp.0.join("destination.txt");
        fs::write(&destination, b"original").expect("write original");

        let invalid_destination = temp.0.join("existing-directory");
        fs::create_dir(&invalid_destination).expect("create conflicting directory");
        atomic_write(&temp.0, &invalid_destination, b"new")
            .expect_err("renaming over a directory must fail");

        assert_eq!(fs::read(&destination).expect("read original"), b"original");
        assert!(fs::read_dir(&temp.0).expect("list root").all(|entry| !entry
            .expect("directory entry")
            .file_name()
            .to_string_lossy()
            .starts_with(".iris-")));
    }

    #[test]
    fn rejects_symlinked_root() {
        let temp = TempDir::new();
        let real = temp.0.join("real");
        let linked = temp.0.join("linked");
        fs::create_dir(&real).expect("create root");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &linked).expect("create root symlink");
        #[cfg(unix)]
        assert!(safe_resolve(linked.to_str().unwrap(), "file.txt").is_err());
    }

    #[test]
    fn bounded_read_rejects_oversized_file() {
        let temp = TempDir::new();
        let path = temp.0.join("large.bin");
        let file = std::fs::File::create(&path).expect("create file");
        file.set_len((MAX_FILE_BYTES + 1) as u64)
            .expect("grow file");
        assert!(read_bounded(&temp.0, &path).is_err());
    }

    #[test]
    fn write_input_is_bounded() {
        let temp = TempDir::new();
        let content = "x".repeat(MAX_WRITE_INPUT_BYTES + 1);
        let error = tool_file_write(
            temp.0.to_string_lossy().into_owned(),
            "x.txt".into(),
            content,
            None,
        )
        .expect_err("oversized input must fail");
        assert!(error.contains("write input exceeds"));
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_relative_io_rejects_intermediate_symlinks() {
        let temp = TempDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(&outside).expect("create outside");
        fs::write(outside.join("secret.txt"), b"outside-secret").expect("write outside secret");
        std::os::unix::fs::symlink(&outside, root.join("linked"))
            .expect("create intermediate symlink");

        assert!(tool_file_read(
            root.to_string_lossy().into_owned(),
            "linked/secret.txt".into(),
            None,
        )
        .is_err());
        assert!(tool_file_write(
            root.to_string_lossy().into_owned(),
            "linked/escaped.txt".into(),
            "jail-content".into(),
            None,
        )
        .is_err());
        assert!(!outside.join("escaped.txt").exists());
        assert_eq!(
            fs::read(outside.join("secret.txt")).expect("read outside"),
            b"outside-secret"
        );
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_relative_write_creates_safe_nested_directories() {
        let temp = TempDir::new();
        tool_file_write(
            temp.0.to_string_lossy().into_owned(),
            "one/two/value.txt".into(),
            "content".into(),
            None,
        )
        .expect("write nested file");
        assert_eq!(
            tool_file_read(
                temp.0.to_string_lossy().into_owned(),
                "one/two/value.txt".into(),
                None,
            )
            .expect("read nested file"),
            "content"
        );
    }
}
