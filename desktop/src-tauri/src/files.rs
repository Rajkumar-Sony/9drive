use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;

const MAX_FOLDER_DEPTH: usize = 31;
const MAX_SELECTED_FILES: usize = 10_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub relative_path: Option<String>,
}

/// Inspect selected files and recursively enumerate selected folders without following symlinks.
#[tauri::command]
pub fn inspect_paths(paths: Vec<String>, root: Option<String>) -> Result<Vec<LocalFile>, String> {
    let mut files = Vec::new();
    for path in paths {
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| "A selected file could not be read.".to_string())?;
        if meta.file_type().is_symlink() {
            return Err("Selected symbolic links are not supported.".to_string());
        }
        if meta.is_dir() {
            let root = Path::new(&path);
            collect_files(root, root, 0, &mut files)?;
            continue;
        }
        if !meta.is_file() {
            return Err("Selected path is not a regular file or folder.".to_string());
        }
        let name = Path::new(&path)
            .file_name()
            .ok_or("Selected file has no name.")?
            .to_string_lossy()
            .into_owned();
        let relative_path = root
            .as_deref()
            .and_then(|base| Path::new(&path).strip_prefix(base).ok())
            .map(|rel| rel.to_string_lossy().replace('\\', "/"));
        files.push(LocalFile {
            path,
            name,
            size: meta.len(),
            relative_path,
        });
        if files.len() > MAX_SELECTED_FILES {
            return Err("The selection contains too many files.".to_string());
        }
    }
    Ok(files)
}

fn collect_files(
    root: &Path,
    current: &Path,
    depth: usize,
    output: &mut Vec<LocalFile>,
) -> Result<(), String> {
    if depth > MAX_FOLDER_DEPTH {
        return Err("The selected folder is too deep.".to_string());
    }
    let entries = std::fs::read_dir(current)
        .map_err(|_| "A selected folder could not be read.".to_string())?;
    let mut entries: Vec<_> = entries
        .collect::<Result<_, _>>()
        .map_err(|_| "A selected folder entry could not be read.".to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if output.len() >= MAX_SELECTED_FILES {
            return Err("The selection contains too many files.".to_string());
        }
        let path = entry.path();
        if entry
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(true)
        {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, depth + 1, output)?;
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative_path = format!(
            "{}/{}",
            root.file_name().unwrap_or_default().to_string_lossy(),
            relative.to_string_lossy().replace('\\', "/")
        );
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        output.push(LocalFile {
            path: path.to_string_lossy().into_owned(),
            name,
            size: meta.len(),
            relative_path: Some(relative_path),
        });
    }
    Ok(())
}

/// Modification time in milliseconds, used to notice a file that changed under a paused upload.
pub fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub status: Option<String>,
    pub version: Option<String>,
}

/// Asks a oneconnect server for /api/health from the native side, where CORS doesn't apply. The window
/// can then tell "not a oneconnect server / unreachable" apart from "server too old for the desktop app"
/// (reachable here, but its CORS refuses the app's window).
#[tauri::command]
pub async fn server_info(url: String) -> Result<ServerInfo, String> {
    #[derive(serde::Deserialize)]
    struct Health {
        status: Option<String>,
        version: Option<String>,
    }
    let response = reqwest::Client::new()
        .get(format!("{}/api/health", url.trim_end_matches('/')))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let health: Health = response.json().await.map_err(|e| e.to_string())?;
    Ok(ServerInfo {
        status: health.status,
        version: health.version,
    })
}

#[cfg(test)]
mod tests {
    use super::inspect_paths;

    #[test]
    fn selected_folder_keeps_relative_file_paths() {
        let parent =
            std::env::temp_dir().join(format!("oneconnect-folder-test-{}", uuid::Uuid::new_v4()));
        let root = parent.join("album");
        let nested = root.join("photos");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("photo.jpg"), b"photo").unwrap();

        let files = inspect_paths(vec![root.to_string_lossy().into_owned()], None).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].relative_path.as_deref(),
            Some("album/photos/photo.jpg")
        );
        assert_eq!(files[0].size, 5);

        std::fs::remove_dir_all(parent).unwrap();
    }
}
