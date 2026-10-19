// AI Meeting Workstation 桌面壳。
//
// 设计约束（来自 PoC 结论）：客户端 src/client/src/app/App.tsx:151 与 :772 用
// `window.location.host` 派生 WebSocket / fetch 地址，因此壳内 WebView 必须与
// Node sidecar（8787）同源。做法是把窗口直接 load http://127.0.0.1:<port>/，
// sidecar 就绪后才显示窗口，避免白屏。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WindowEvent};

struct Sidecar {
    child: Mutex<Option<Child>>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // tauri 2 的 setup 闭包要求返回 Result<(), Box<dyn Error>>；
            // 这里把 sidecar 启动与窗口加载都包进同一个错误链，失败时壳直接退出并打印原因。
            match bootstrap(app) {
                Ok(()) => Ok(()),
                Err(error) => {
                    eprintln!("[aimw] 启动失败：{error}");
                    Err(error)
                }
            }
        })
        .manage(Sidecar {
            child: Mutex::new(None),
        })
        .build(tauri::generate_context!())?
        .run(|app_handle, event| match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { .. },
                ..
            } if label == "main" => {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    stop_sidecar(&state);
                }
            }
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    stop_sidecar(&state);
                }
            }
            _ => {}
        });
    Ok(())
}

fn bootstrap(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    let port = start_sidecar(app)?;
    wait_for_server(port)?;
    let url = format!("http://127.0.0.1:{port}/");
    window.eval(&format!("window.location.replace('{url}')"))?;
    window.show()?;
    Ok(())
}

/// 启动内嵌的 Node sidecar（server bundle + 精简 prod node_modules）。
///
/// 端口由 sidecar 自己读 APP_PORT；这里通过 /api/health 反推实际端口，
/// 因此先起 server 再等待 health，避免端口写死两处。
fn start_sidecar(app: &tauri::App) -> Result<u16, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    // tauri.conf.json 的 bundle.resources 把 sidecar 的三个部分映射到 Resources 根下：
    // node_modules/（精简 prod 依赖）、server/（esbuild bundle）、node-bin（Node 运行时）。
    let node_bin = resource_dir.join("node-bin");
    let server_entry = resource_dir.join("server/server.mjs");
    if !node_bin.exists() || !server_entry.exists() {
        return Err(format!(
            "内嵌 Node sidecar 缺失：{} 或 {}",
            node_bin.display(),
            server_entry.display()
        )
        .into());
    }
    // cwd 必须是 resource_dir：server.mjs 用 import.meta.url 定位 node_modules，
    // 而 tauri 把依赖拍平在 Resources/node_modules 下。
    let child = Command::new(&node_bin)
        .arg(&server_entry)
        .current_dir(&resource_dir)
        .env("APP_PORT", default_port().to_string())
        .env("APP_HOST", "127.0.0.1")
        .env("APP_DATA_DIR", app_data_dir(app)?)
        .env("CLIENT_DIST_DIR", resource_dir.join("client"))
        .env("FUNASR_TRANSCRIBE_SCRIPT", resource_dir.join("server/scripts/transcribe_audio.py"))
        .env("FUNASR_HOTWORD_FILE", resource_dir.join("config/hotwords/active.txt"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(state) = app.try_state::<Sidecar>() {
        *state.child.lock().unwrap() = Some(child);
    }
    Ok(default_port())
}

fn default_port() -> u16 {
    std::env::var("AIMW_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787)
}

/// 与 serverConfig.ts 的 dataDir 语义一致：APP_DATA_DIR 优先，否则应用数据目录。
fn app_data_dir(app: &tauri::App) -> Result<String, Box<dyn std::error::Error>> {
    if let Some(value) = std::env::var("APP_DATA_DIR").ok().filter(|v| !v.trim().is_empty()) {
        return Ok(value);
    }
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

fn wait_for_server(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Ok(response) = reqwest_blocking_get(port) {
            if response {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Node sidecar 未在 60 秒内就绪".into())
}

/// 不引第三方 HTTP 客户端：直接对 127.0.0.1 做一次 TCP 连接 + 读 /api/health。
fn reqwest_blocking_get(port: u16) -> Result<bool, Box<dyn std::error::Error>> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(
        format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").as_bytes(),
    )?;
    let mut buffer = [0u8; 512];
    let read = stream.read(&mut buffer)?;
    let text = String::from_utf8_lossy(&buffer[..read]);
    Ok(text.contains("200") && text.contains("ai-meeting-workstation"))
}

fn stop_sidecar(state: &Sidecar) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        // 先 SIGTERM 让 node 有机会同步 SQLite，再兜底 kill。
        let _ = child.kill();
        let _ = child.wait();
    }
}
