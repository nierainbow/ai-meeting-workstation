// T1.3 自动更新通道的端到端验收探针（不是产品入口，随 cargo build 一起编译验证）。
//
// 用法（对真实运行中的 App 执行，走的是与产品完全相同的 tauri-plugin-updater）：
//   updater_probe check
//   updater_probe install
//
// 它必须和主程序用同一份 tauri.conf 构建：Tauri 把 endpoints / pubkey / 当前版本
// 编进二进制，探针因此能证明「0.9.0 的客户端确实能看到并装上 0.9.1」。
// 输出一行 JSON，验收脚本 scripts/verify-update-upgrade.mjs 直接解析。
use serde_json::json;
use tauri::Runtime;
use tauri_plugin_updater::{Update, UpdaterExt};

fn manifest_diagnosis<R: Runtime>(app: &tauri::AppHandle<R>) -> String {
    let current = app.package_info().version.to_string();
    let Some(template) = request_endpoints(app).into_iter().next() else {
        return "tauri.conf.json 里没有配置 updater.endpoints".to_string();
    };
    let url = template
        .replace("{{current_version}}", &current)
        .replace("{{target}}", "darwin-aarch64")
        .replace("{{arch}}", "aarch64")
        .replace("{{bundle_type}}", "app");
    let (status, body) = http_get(&url);
    if std::env::var("AIMW_PROBE_DEBUG").is_ok() {
        eprintln!("[probe] {url}\n{body}");
    }
    if !status.contains(" 200") {
        return format!("GET {url} → {status}");
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else {
        return format!("GET {url} → 200，但不是合法 JSON：{}", head(&body));
    };
    let mut missing: Vec<String> = ["version", "notes", "pub_date", "platforms"]
        .into_iter()
        .filter(|key| json.get(*key).is_none())
        .map(str::to_string)
        .collect();
    match json.get("platforms").and_then(|value| value.get("darwin-aarch64")) {
        None => missing.push("platforms.darwin-aarch64".to_string()),
        Some(entry) => {
            for key in ["signature", "url"] {
                if entry.get(key).and_then(|value| value.as_str()).unwrap_or("").is_empty() {
                    missing.push(format!("platforms.darwin-aarch64.{key}"));
                }
            }
        }
    }
    let version = json.get("version").map(|value| value.to_string()).unwrap_or_default();
    if missing.is_empty() {
        format!("GET {url} → 200，manifest 字段完整（版本文本 {version}）")
    } else {
        format!("GET {url} → 200，但缺少字段：{}", missing.join(", "))
    }
}

fn head(text: &str) -> String {
    text.chars().take(200).collect()
}

/// 最小 HTTP/1.1 GET（同机明文 http，够用且不额外引依赖）。
fn http_get(url: &str) -> (String, String) {
    use std::io::{Read, Write};
    let without_scheme = url.strip_prefix("http://").unwrap_or(url);
    let (authority, path) = match without_scheme.split_once('/') {
        Some((authority, rest)) => (authority.to_string(), format!("/{rest}")),
        None => (without_scheme.to_string(), "/".to_string()),
    };
    let addr = if authority.contains(':') { authority.clone() } else { format!("{authority}:80") };
    let Ok(mut stream) = std::net::TcpStream::connect(&addr) else {
        return (format!("无法连接 {addr}"), String::new());
    };
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).ok();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nAccept: application/json\r\nUser-Agent: tauri-updater\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return ("写入请求失败".to_string(), String::new());
    }
    let mut buffer = Vec::new();
    let _ = stream.read_to_end(&mut buffer);
    let text = String::from_utf8_lossy(&buffer).to_string();
    let status = text.lines().next().unwrap_or("无响应").to_string();
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

fn main() {
    let action = std::env::args().nth(1).unwrap_or_else(|| "check".to_string());
    if action != "check" && action != "install" {
        eprintln!("用法：updater_probe [check|install]");
        std::process::exit(2);
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let handle = app.handle().clone();
            let action = action.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("无法创建 tokio runtime");
                let result = runtime.block_on(run(&handle, &action));
                match result {
                    Ok(report) => println!("{}", report),
                    Err(error) => {
                        println!("{}", json!({ "ok": false, "error": error }));
                        let _ = handle.exit(1);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("updater_probe 启动失败");

    let exit_code = app.run_return(|_handle, _event| {});
    std::process::exit(exit_code);
}

async fn run<R: Runtime>(app: &tauri::AppHandle<R>, action: &str) -> Result<String, String> {
    let current_version = app.package_info().version.to_string();
    // 用与插件相同的 reqwest 栈复现请求：若这里也失败，问题就在 HTTP 层
    // （代理 / UA / TLS），而不是 manifest 内容。
    let probe_url = request_endpoints(app)
        .into_iter()
        .next()
        .map(|template| {
            template
                .replace("{{current_version}}", &current_version)
                .replace("{{target}}", "darwin-aarch64")
                .replace("{{arch}}", "aarch64")
                .replace("{{bundle_type}}", "app")
        })
        .ok_or("no endpoint")?;
    {
        let client = reqwest::Client::builder().user_agent("aimw-probe").build();
        match client.map(|client| client.get(&probe_url).header("Accept", "application/json")) {
            Ok(request) => match request.send().await {
                Ok(response) => eprintln!(
                    "[probe] reqwest 直连 {probe_url} → {} content-type={:?}",
                    response.status(),
                    response.headers().get("content-type")
                ),
                Err(error) => eprintln!("[probe] reqwest 直连失败：{error}"),
            },
            Err(error) => eprintln!("[probe] 构造请求失败：{error}"),
        }
    }
    let updater = app.updater().map_err(|error| error.to_string())?;
    // 失败时把请求过的 endpoint 一并带出来：Accept 不匹配、TLS、404 都会归成同一句
    // "Could not fetch a valid release JSON from the remote"，没有 URL 就只能靠猜。
    let update: Option<Update> = updater.check().await.map_err(|error| {
        let endpoints = request_endpoints(&app);
        let detail = manifest_diagnosis(&app);
        format!(
            "{error}（请求端点：{}；{detail}）",
            if endpoints.is_empty() { "无".to_string() } else { endpoints.join(", ") }
        )
    })?;

    match action {
        "check" => Ok(json!({
            "ok": true,
            "action": "check",
            "currentVersion": current_version,
            "available": update.is_some(),
            "version": update.as_ref().map(|item| item.version.clone()),
            "notes": update.as_ref().and_then(|item| item.body.clone()),
            "downloadUrl": update.as_ref().map(|item| item.download_url.to_string()),
        })
        .to_string()),
        _ => {
            let update = update.ok_or_else(|| "当前已是最新版本，没有可安装的更新。".to_string())?;
            let version = update.version.clone();
            let download_url = update.download_url.to_string();
            let bytes = update
                .download(|_chunk, _total| {}, || {})
                .await
                .map_err(|error| format!("下载更新包失败：{error}"))?;
            let downloaded = bytes.len();
            // 先报告下载结果：签名校验失败时也能看出是「取到了包但校验不过」。
            println!(
                "{}",
                json!({ "stage": "downloaded", "version": version, "bytes": downloaded })
            );
            let installed = std::thread::spawn({
                let update = update;
                let bytes = bytes.clone();
                move || update.install(bytes)
            });
            let handle = installed.join().map_err(|_| "安装线程崩溃".to_string())?;
            handle.map_err(|error| format!("安装更新失败：{error}"))?;
            Ok(json!({
                "ok": true,
                "action": "install",
                "currentVersion": current_version,
                "version": version,
                "downloadUrl": download_url,
                "bytes": downloaded,
                "extractPath": update_extract_path(),
            })
            .to_string())
        }
    }
}

/// 从 tauri.conf.json 里读出 updater.endpoints（已编进二进制）。
fn request_endpoints<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("endpoints"))
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn update_extract_path() -> Option<String> {
    let path = std::env::current_exe().ok()?;
    // 探针可能直接跑在 .app/Contents/MacOS/ 里，也可能被拷到别处：
    // 取包含 Contents/Info.plist 的最近祖先作为「被更新的 App」。
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        if dir.join("Contents/Info.plist").exists() {
            return dir.parent().map(|value| value.to_string_lossy().to_string());
        }
        cursor = dir.parent();
    }
    Some(path.to_string_lossy().to_string())
}