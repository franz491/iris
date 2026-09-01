// src-tauri/src/docs.rs — read-only access to a jailed docs/ root on this
// machine, mirroring the backend docs provider spec (topics = folders under
// the docs root). Absolute paths, "..", and symlinked components are rejected
// on every path component.
use std::fs::{self, DirEntry};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

const MAX_TRAVERSAL_DEPTH: usize = 32;
const MAX_TRAVERSAL_ENTRIES: usize = 5_000;
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
/// Keep a single documentation read from exhausting the native command
/// process. Search has a smaller per-file limit; direct reads need their own
/// explicit bound because they are exposed as a separate command.
const MAX_READ_FILE_BYTES: u64 = 8 * 1024 * 1024;

fn is_symlink(entry: &DirEntry) -> io::Result<bool> {
    Ok(entry.file_type()?.is_symlink())
}

/// Resolve (topic, relative path) inside the jail; rejects traversal.
fn safe_resolve(root: &str, topic: &str, rel: Option<&str>) -> Result<PathBuf, String> {
    let reject = |s: &str| {
        s.is_empty()
            || s.starts_with('/')
            || s.starts_with('~')
            || Path::new(s).is_absolute()
            || Path::new(s)
                .components()
                .any(|c| matches!(c, Component::ParentDir))
    };
    if reject(topic) {
        return Err(format!("invalid topic: {}", topic));
    }
    if let Some(r) = rel {
        if reject(r) {
            return Err(format!("invalid path: {}", r));
        }
    }
    if root.trim().is_empty() {
        return Err("a documentation folder must be configured".to_string());
    }
    let docs_root = PathBuf::from(root);
    if fs::symlink_metadata(&docs_root)
        .map_err(|e| format!("invalid documentation root: {}", e))?
        .file_type()
        .is_symlink()
    {
        return Err("symlinked documentation root disallowed".to_string());
    }
    let mut p = docs_root.clone();
    p.push(topic);
    if let Some(r) = rel {
        p.push(r);
    }
    // reject symlinked components between root and target
    let mut cur = docs_root.clone();
    for comp in p.components().skip(docs_root.components().count()) {
        cur.push(comp);
        if let Ok(md) = fs::symlink_metadata(&cur) {
            if md.file_type().is_symlink() {
                return Err("symlink traversal disallowed".to_string());
            }
        }
    }
    Ok(p)
}

#[tauri::command]
pub fn tool_docs_list(root: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root);
    let root_type = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata.file_type(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.to_string()),
    };
    if root_type.is_symlink() {
        return Err("symlinked documentation root disallowed".to_string());
    }
    let mut out: Vec<String> = fs::read_dir(&root)
        .map_err(|e: io::Error| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    out.sort();
    Ok(out)
}

/// Recursive tree listing; files only when `files_too`.
#[tauri::command]
pub fn tool_docs_structure(
    root: String,
    topic: String,
    files_too: bool,
) -> Result<Vec<String>, String> {
    fn walk(
        dir: &Path,
        base: &Path,
        files_too: bool,
        depth: usize,
        out: &mut Vec<String>,
    ) -> io::Result<()> {
        if depth > MAX_TRAVERSAL_DEPTH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "documentation traversal depth exceeded",
            ));
        }
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if is_symlink(&e)? {
                continue;
            }
            let is_dir = e.file_type()?.is_dir();
            if !is_dir && !files_too {
                continue;
            }
            if let Ok(rel) = e.path().strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if out.len() > MAX_TRAVERSAL_ENTRIES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "documentation entry limit exceeded",
                ));
            }
            if is_dir {
                walk(&e.path(), base, files_too, depth + 1, out)?;
            }
        }
        Ok(())
    }
    let p = safe_resolve(&root, &topic, None)?;
    if !p.is_dir() {
        return Err(format!("unknown topic: {}", topic));
    }
    let mut out = vec![];
    walk(&p, &p, files_too, 0, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub fn tool_docs_read(root: String, topic: String, file_path: String) -> Result<String, String> {
    let p = safe_resolve(&root, &topic, Some(&file_path))?;
    let file = std::fs::File::open(p).map_err(|e| format!("read failed: {}", e))?;
    let mut bytes = Vec::new();
    file.take(MAX_READ_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read failed: {}", e))?;
    if bytes.len() > MAX_READ_FILE_BYTES as usize {
        return Err(format!("file exceeds {} bytes", MAX_READ_FILE_BYTES));
    }
    String::from_utf8(bytes).map_err(|e| format!("read failed: {}", e))
}

const MAX_OUTPUT: usize = 10_000;

/// Case-insensitive text search when `regex` is None, regex search otherwise.
/// `subpath` optionally restricts to a folder inside the topic. Output lines
/// are "path:line: excerpt"; oversized output errors unless allow_large_output
/// ("head" | "tail" | "all") permits it.
#[tauri::command]
pub fn tool_docs_search(
    root_folder: String,
    query: Option<String>,
    topic: String,
    subpath: Option<String>,
    allow_large_output: Option<String>,
    regex: Option<String>,
) -> Result<Vec<String>, String> {
    let re = match &regex {
        Some(r) => Some(
            regex::RegexBuilder::new(r)
                .case_insensitive(false)
                .build()
                .map_err(|e| format!("invalid regex: {}", e))?,
        ),
        None => None,
    };
    let q = query.clone().unwrap_or_default().to_lowercase();

    fn walk_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) -> io::Result<()> {
        if depth > MAX_TRAVERSAL_DEPTH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "documentation traversal depth exceeded",
            ));
        }
        for e in std::fs::read_dir(dir)?.filter_map(|e| e.ok()) {
            if is_symlink(&e)? {
                continue;
            }
            let p = e.path();
            if e.file_type()?.is_dir() {
                walk_files(&p, depth + 1, out)?;
            } else {
                out.push(p);
                if out.len() > MAX_TRAVERSAL_ENTRIES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "documentation file limit exceeded",
                    ));
                }
            }
        }
        Ok(())
    }

    let root = safe_resolve(&root_folder, &topic, subpath.as_deref())?;
    if !root.is_dir() {
        return Err(format!(
            "unknown topic/subpath: {}/{}",
            topic,
            subpath.unwrap_or_default()
        ));
    }
    let mut files = vec![];
    walk_files(&root, 0, &mut files).map_err(|e| e.to_string())?;

    let mut hits: Vec<String> = vec![];
    let mut total_bytes = 0u64;
    'files: for f in files {
        let size = match std::fs::metadata(&f) {
            Ok(metadata) if metadata.len() <= MAX_SEARCH_FILE_BYTES => metadata.len(),
            Ok(_) | Err(_) => continue,
        };
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_SEARCH_TOTAL_BYTES {
            break 'files;
        }
        let content = match std::fs::read_to_string(&f) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let rel_base = safe_resolve(&root_folder, &topic, None)?;
        let rel = f
            .strip_prefix(&rel_base)
            .unwrap_or(&f)
            .to_string_lossy()
            .replace('\\', "/");
        for (i, line) in content.lines().enumerate() {
            let matched = match (&re, !q.is_empty()) {
                (Some(re), _) => re.is_match(line),
                (None, true) => line.to_lowercase().contains(&q),
                _ => false,
            };
            if matched {
                let excerpt: String = line.chars().take(500).collect();
                hits.push(format!("{}:{}: {}", rel, i + 1, excerpt));
                if hits.len() >= 500 {
                    break 'files;
                }
            }
        }
    }

    if hits.len() * 60 > MAX_OUTPUT && allow_large_output.is_none() {
        return Err(
            "output too large; pass allow_large_output ('head' | 'tail' | 'all') if you are sure"
                .to_string(),
        );
    }
    match allow_large_output.as_deref() {
        Some("head") => hits.truncate(MAX_OUTPUT / 60),
        Some("tail") if hits.len() > MAX_OUTPUT / 60 => {
            hits = hits.split_off(hits.len() - MAX_OUTPUT / 60)
        }
        _ => {}
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::{
        tool_docs_list, tool_docs_read, tool_docs_search, tool_docs_structure, MAX_READ_FILE_BYTES,
    };
    use std::fs::{create_dir_all, remove_dir_all, symlink_metadata, write};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "iris-docs-test-{}-{}",
                std::process::id(),
                nonce
            ));
            create_dir_all(&path).expect("create temporary docs directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            if symlink_metadata(&self.0).is_ok() {
                remove_dir_all(&self.0).expect("remove temporary docs directory");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn recursive_operations_skip_symlinked_directories_and_files() {
        use std::os::unix::fs::symlink;

        let test_dir = TestDirectory::create();
        let docs_root = test_dir.0.join("docs");
        let topic = docs_root.join("guides");
        let outside = test_dir.0.join("outside");
        create_dir_all(&topic).expect("create topic");
        create_dir_all(&outside).expect("create outside directory");
        write(topic.join("inside.md"), "visible documentation").expect("write inside document");
        write(outside.join("secret.md"), "outside-secret").expect("write secret document");
        symlink(&outside, topic.join("outside-link")).expect("create directory symlink");
        symlink(outside.join("secret.md"), topic.join("secret-link.md"))
            .expect("create file symlink");

        let root = docs_root.to_string_lossy().into_owned();
        assert_eq!(
            tool_docs_list(root.clone()).expect("list topics"),
            ["guides"]
        );
        assert_eq!(
            tool_docs_structure(root.clone(), "guides".to_string(), true).expect("list structure"),
            ["inside.md"]
        );
        assert!(tool_docs_search(
            root,
            Some("outside-secret".to_string()),
            "guides".to_string(),
            None,
            None,
            None,
        )
        .expect("search documentation")
        .is_empty());
    }

    #[test]
    fn direct_read_rejects_oversized_document() {
        let test_dir = TestDirectory::create();
        let docs_root = test_dir.0.join("docs");
        let topic = docs_root.join("guides");
        create_dir_all(&topic).expect("create topic");
        let document = topic.join("large.md");
        let file = std::fs::File::create(&document).expect("create document");
        file.set_len(MAX_READ_FILE_BYTES + 1)
            .expect("grow document");

        let error = tool_docs_read(
            docs_root.to_string_lossy().into_owned(),
            "guides".to_string(),
            "large.md".to_string(),
        )
        .expect_err("oversized direct read must fail");
        assert!(error.contains("file exceeds"));
    }
}
