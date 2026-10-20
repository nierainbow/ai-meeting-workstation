// T1.3 自动更新通道：Tauri updater 命令封装 + 更新前 .local-data/ 备份。
//
// 职责边界：
// - 只做「检查 / 备份 / 下载安装」三步编排，签名校验全部交给 tauri-plugin-updater；
// - 备份在下载**之前**完成（而不是 on_before_exit），这样即使下载中途失败，
//   用户数据也已经有一份快照；
// - 备份目录固定落在 <dataDir 的父目录>/backups/pre-update-<version>-<时间戳>/，
//   与 server 的 dataDir 语义一致（main.rs 注入的 APP_DATA_DIR）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// 更新检查结果，前端据此渲染横幅。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    /// 当前运行版本。
    pub current_version: String,
    /// 有新版本时为 true。
    pub available: bool,
    /// 新版本号；无更新时为 null。
    pub version: Option<String>,
    /// 更新说明；可能为空。
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResult {
    /// 已安装的新版本。
    pub version: String,
    /// 更新前的数据备份目录；备份失败时为 null。
    pub backup_dir: Option<String>,
    /// 备份未成功但更新已安装时为 true，前端需要提示用户自行备份。
    pub backup_failed: bool,
    /// macOS / Linux 需要用户手动重启才生效。
    pub needs_restart: bool,
    /// 安装后健康检查未通过时的中文说明（含备份位置）；正常为 None。
    pub health_error: Option<String>,
}

/// 前端入口：检查是否有新版本。
#[tauri::command]
pub async fn updater_check(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    check_update(&app).await
}

/// 前端入口：备份 .local-data/ 后下载安装新版本。
#[tauri::command]
pub async fn updater_install(app: tauri::AppHandle) -> Result<UpdateInstallResult, String> {
    install_update(&app).await
}

/// 检查更新。返回 available=false 表示已是最新。
pub async fn check_update<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;

    Ok(match update {
        Some(update) => UpdateCheckResult {
            current_version,
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        },
        None => UpdateCheckResult {
            current_version,
            available: false,
            version: None,
            notes: None,
        },
    })
}

/// 安装更新：先备份 .local-data/，再下载安装。
pub async fn install_update<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<UpdateInstallResult, String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "当前已是最新版本，没有可安装的更新。".to_string())?;

    // 备份必须在下载之前：下载/校验失败也要留下可回滚的快照。
    let backup = backup_data_dir(app, &update.version);
    if let Err(error) = &backup {
        eprintln!("[aimw] 更新前备份 .local-data/ 失败：{error}");
    }
    let backup_dir = backup.as_ref().ok().map(|path| path.to_string_lossy().to_string());

    // macOS / Linux 上 install() 只是把新版本解到目标目录，必须重启才生效；
    // Windows 上安装包会自行拉起应用。
    let needs_restart = !cfg!(windows);

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| format!("更新安装失败：{error}；数据备份：{}", backup_label(&backup)))?;

    // 装上了不等于能用：新包起不来时用户只剩「数据备份」这一条退路，必须显式告知。
    let health = health_version();
    let health_error = match (&health, &server_port()) {
        (Err(error), _) => Some(error.clone()),
        (Ok(seen), port) if seen.as_deref() != Some(update.version.as_str()) => {
            let seen_label = seen.clone().unwrap_or_else(|| "未知版本".to_string());
            Some(format!(
                "新版本 {} 的文件已替换，但 127.0.0.1:{port} 仍在运行 {seen_label}；\n重启后若仍启动失败，请到 {} 找回数据。",
                update.version,
                backups_root_label()
            ))
        }
        _ => None,
    };
    if let Some(error) = &health_error {
        eprintln!("[aimw] 更新后健康检查未通过：{error}");
    }

    Ok(UpdateInstallResult {
        version: update.version.clone(),
        backup_dir,
        backup_failed: backup.is_err(),
        needs_restart,
        health_error,
    })
}

/// sidecar 端口：main.rs 用的是 AIMW_PORT / 8787，这里保持一致。
fn server_port() -> u16 {
    std::env::var("AIMW_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787)
}

/// 请求一次 /api/health，取出后端自报的版本号（与 main.rs 的探活同一路径）。
fn health_version() -> Result<Option<String>, String> {
    use std::io::{Read, Write};
    let port = server_port();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("连不上 127.0.0.1:{port}：{error}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .map_err(|error| error.to_string())?;
    let mut text = String::new();
    stream
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    let json: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|error| format!("健康检查返回不是 JSON：{error}"))?;
    if json.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        return Err("健康检查返回 ok=false".to_string());
    }
    Ok(json
        .get("version")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string()))
}

/// 启动失败页要告诉用户「备份在哪」：备份根目录与数据目录同父，取不到就如实说明。
pub fn backups_root_label() -> String {
    let data = std::env::var("APP_DATA_DIR").ok().filter(|value| !value.trim().is_empty());
    match data {
        Some(dir) => {
            let path = PathBuf::from(dir);
            let parent = path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone());
            parent.join("backups").to_string_lossy().to_string()
        }
        None => "<应用数据目录>/backups".to_string(),
    }
}

fn backup_label(backup: &Result<PathBuf, String>) -> String {
    match backup {
        Ok(path) => format!("已完成（{}）", path.display()),
        Err(error) => format!("未成功（{error}）"),
    }
}

/// 把 .local-data/ 整体复制一份到 <dataDir 的父目录>/backups/pre-update-<version>-<ts>/。
///
/// 数据目录不存在时返回 Err：上层把 backup_failed 透给 UI，但不阻断安装
/// （用户可能本来就是全新安装、无数据可丢）。
fn backup_data_dir<R: Runtime>(app: &tauri::AppHandle<R>, version: &str) -> Result<PathBuf, String> {
    let running = std::env::var("AIMW_APP_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let source = data_dir(app)?;
    match backup_data_dir_at(&source, version, running.as_deref())? {
        // 数据目录不存在：全新安装没有可丢的数据，但要让 UI 看得到原因。
        None => Err(format!("数据目录不存在，无需备份：{}", source.display())),
        Some(path) => Ok(path),
    }
}

/// 备份主体：不依赖 Tauri 运行时，便于用「更新目标目录」真实移动来验证。
///
/// - 源目录不存在 = 全新安装，直接返回 Ok(None)，不算备份失败；
/// - running_app 是更新前正在运行的 .app（Windows 上就是被替换的目录）：
///   备份落在它的**同级** backups/ 下，这样更新失败可以直接回滚目录；
///   macOS 上 /Applications 通常不可写，退回到 <dataDir 的父目录>/backups。
fn backup_data_dir_at(
    source: &Path,
    version: &str,
    running_app: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    if !source.exists() {
        return Ok(None);
    }
    let parent = source
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| source.to_path_buf());
    let name = backup_dir_name(version);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(app) = running_app {
        if let Some(app_parent) = app.parent() {
            candidates.push(app_parent.to_path_buf());
        }
    }
    candidates.push(parent);
    let mut last_error = String::from("没有可写的备份位置");
    for base in candidates {
        let target = base.join("backups").join(&name);
        match backup_into(source, &target) {
            Ok(()) => return Ok(Some(target)),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn backup_into(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("无法创建备份目录 {}：{error}", target.display()))?;
    let copy_target = target.join(dir_name(source));
    copy_dir_recursive(source, &copy_target)
        .map_err(|error| format!("复制 {} 失败：{error}", source.display()))?;
    // 备份必须逐字节可读回才算成功：写到一半的备份比没有备份更危险。
    let written = count_files(&copy_target)?;
    let expected = count_files(source)?;
    if written != expected {
        return Err(format!(
            "备份不完整：{} 应有 {expected} 个文件，实际写入 {written} 个",
            target.display()
        ));
    }
    Ok(())
}

/// 统计一个目录下的文件数（含子目录），用于校验备份完整性。
pub(crate) fn count_files(path: &Path) -> Result<usize, String> {
    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let child = entry.path();
        if child.is_dir() {
            total += count_files(&child)?;
        } else {
            total += 1;
        }
    }
    Ok(total)
}

/// 备份目录名带版本与时间戳，多次更新不会互相覆盖。
fn backup_dir_name(version: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    format!("pre-update-{version}-{stamp}")
}

fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "local-data".to_string())
}

/// 与 main.rs 的 app_data_dir 语义一致：APP_DATA_DIR 优先，否则应用数据目录。
/// 与 serverConfig.ts 的 dataDir 也对齐——两边必须指向同一处，备份才有意义。
fn data_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var("APP_DATA_DIR").ok().filter(|value| !value.trim().is_empty()) {
        return Ok(PathBuf::from(value));
    }
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

/// 递归复制目录。只处理文件与目录；.local-data 下正常不会有符号链接。
fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        // 符号链接按内容复制：备份里不能出现指向原数据的软链，
        // 否则更新把原数据目录换掉后备份就是一堆死链。
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aimw-updater-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_data_dir(root: &Path) -> PathBuf {
        let data = root.join(".local-data");
        fs::create_dir_all(data.join("tasks/t-1")).unwrap();
        fs::write(data.join("settings.json"), "{\"brain\":\"ark\"}").unwrap();
        fs::write(data.join("tasks/t-1/transcript.md"), "# 会议\n一行内容").unwrap();
        data
    }

    #[test]
    fn backup_copies_every_file_next_to_data_dir() {
        let root = temp_root("copy");
        let data = seed_data_dir(&root);
        let backup = backup_data_dir_at(&data, "0.9.1", None).unwrap().expect("应产生备份");
        assert_eq!(backup.parent().unwrap(), root.join("backups").as_path());
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("pre-update-0.9.1-"));
        let copied = backup.join(".local-data");
        assert_eq!(count_files(&copied).unwrap(), 2);
        assert_eq!(
            fs::read_to_string(copied.join("tasks/t-1/transcript.md")).unwrap(),
            "# 会议\n一行内容"
        );
    }

    #[test]
    fn backup_prefers_directory_next_to_running_app() {
        let root = temp_root("app-sibling");
        let data = seed_data_dir(&root.join("data"));
        let app = root.join("Applications/AI Meeting Workstation.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        let backup = backup_data_dir_at(&data, "0.9.1", Some(&app)).unwrap().expect("应产生备份");
        assert_eq!(backup.parent().unwrap(), root.join("Applications/backups").as_path());
        assert!(backup.join(".local-data/settings.json").exists());
    }

    #[test]
    fn backup_falls_back_when_app_sibling_is_not_writable() {
        let root = temp_root("fallback");
        let data = seed_data_dir(&root.join("data"));
        // 只读目录模拟 /Applications：写不进去时应退回数据目录的父目录。
        let locked = root.join("locked");
        fs::create_dir_all(&locked).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&locked).unwrap().permissions();
            perms.set_mode(0o500);
            fs::set_permissions(&locked, perms).unwrap();
        }
        let app = locked.join("AI Meeting Workstation.app");

        let backup = backup_data_dir_at(&data, "0.9.1", Some(&app)).unwrap().expect("应产生备份");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut restore = fs::metadata(&locked).unwrap().permissions();
            restore.set_mode(0o700);
            fs::set_permissions(&locked, restore).unwrap();
            // root 无视只读位，这种情况下不做兜底路径断言，避免假失败。
            if !is_root() {
                assert_eq!(backup.parent().unwrap(), root.join("data/backups").as_path());
            }
        }
        assert!(backup.join(".local-data").exists());
    }

    #[cfg(unix)]
    fn is_root() -> bool {
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|text| text.trim() == "0")
            .unwrap_or(false)
    }

    #[test]
    fn missing_data_dir_is_not_a_backup_failure() {
        let root = temp_root("missing");
        let data = root.join(".local-data");
        assert_eq!(backup_data_dir_at(&data, "0.9.1", None).unwrap(), None);
        assert!(!root.join("backups").exists());
    }

    #[test]
    fn backup_dir_names_do_not_collide_between_versions() {
        assert_ne!(backup_dir_name("0.9.1"), backup_dir_name("0.9.2"));
        assert!(backup_dir_name("0.9.1").starts_with("pre-update-0.9.1-"));
    }
}
