// T1.3 更新 manifest 的纯逻辑（无 IO），供 publish-update.mjs / update-server.mjs
// 与单测共用。
//
// 为什么单独成文件：manifest 有两处必须**完全一致**的理解——
//   - 发布端按 target 写 platforms 段；
//   - 静态服务器按 /updates/<target>/<arch>/<current_version> 定位
//     <root>/<target>/latest.json。
// 两边各写一遍正则的话，改一处忘另一处就会静默 404（客户端表现为「检查更新失败」），
// 所以把它们放在同一个模块里，并由 scripts/update-upstream.test.mjs 逐条对齐。

/**
 * Tauri updater endpoint 模板里的目标三元组（如 darwin-aarch64）。
 * 允许 aarch64 / x86_64 / universal-apple-darwin 等，只做「不含路径分隔符」的宽校验。
 */
export const TARGET_PATTERN = /^[A-Za-z0-9._-]+$/;

/** manifest 端点：/updates/<target>/<arch>/<current_version> */
const MANIFEST_ROUTE = /^\/updates\/([A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._+-]+$/;

/** 校验 target 是否是安全的目录名（防 ../ 越界）。 */
export function isValidTarget(target) {
  return typeof target === "string" && TARGET_PATTERN.test(target) && target !== "." && target !== "..";
}

/**
 * 把 manifest 端点路径解析成 { target }；不是 manifest 端点时返回 null。
 * {{arch}} / {{current_version}} 只用来让 URL 可区分（将来做灰度），本实现忽略，
 * 始终返回该 target 的 latest.json —— 版本大小比较交给客户端插件。
 */
export function parseManifestRoute(pathname) {
  const match = MANIFEST_ROUTE.exec(pathname);
  if (!match) return null;
  const target = match[1];
  // ".." 也满足字符集，单独拦掉：manifest 路径随后会拼进文件系统路径。
  if (!isValidTarget(target)) return null;
  return { target };
}

/** 构造 manifest 里 platforms[target] 的一条记录。 */
export function platformEntry({ signature, url }) {
  return { signature, url };
}

/**
 * 构造 Static 格式 manifest。
 *
 * @param {object} input
 * @param {string} input.version           新版本号（不带 v 前缀）
 * @param {string} input.notes             更新说明（可为空串）
 * @param {string} input.pubDate           ISO 时间
 * @param {string} input.target            目标三元组
 * @param {string} input.signature         更新包签名（minisign）
 * @param {string} input.baseUrl           更新服务器根地址（无尾斜杠）
 * @param {string} input.archiveName       更新包文件名（需 URL 编码）
 */
export function buildManifest({ version, notes, pubDate, target, signature, baseUrl, archiveName }) {
  if (!version) throw new Error("buildManifest 需要 version");
  if (!isValidTarget(target)) throw new Error("buildManifest: 非法的 target " + JSON.stringify(target));
  if (!signature) throw new Error("buildManifest 需要 signature");
  if (!archiveName) throw new Error("buildManifest 需要 archiveName");
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  return {
    version,
    notes: notes ?? "",
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      [target]: platformEntry({
        signature,
        url: base + "/updates/" + target + "/" + encodeURIComponent(archiveName)
      })
    }
  };
}

/**
 * 客户端视角：manifest 是否描述了「比 currentVersion 更新」的版本。
 * 与 tauri-plugin-updater 的判断保持一致（semver 严格比较，非 semver 直接视为无更新）。
 */
export function isNewerVersion(currentVersion, nextVersion) {
  const current = parseSemver(currentVersion);
  const next = parseSemver(nextVersion);
  if (!current || !next) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
}

/**
 * 客户端地址栏记下的版本（0.9.0）是否与当前二进制版本一致。
 * 更新后旧窗口可能还在展示旧页面，界面要据此提示「重启生效」而不是假装已生效。
 * 只做容错：拿不到（空串/null）时返回 false，不把缺失当一致。
 */
export function isSameVersion(observed, current) {
  const left = parseSemver(observed);
  const right = parseSemver(current);
  if (!left || !right) return false;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

/** 只接受 x.y.z（可带 -pre / +build），返回 [major, minor, patch]。 */
export function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
