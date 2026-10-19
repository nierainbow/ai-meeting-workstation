#!/usr/bin/env node
// 从 git log 的 conventional commits 生成/更新 CHANGELOG.md（Keep a Changelog 格式）。
//
// 用法：
//   node scripts/generate-changelog.mjs                     # 无 tag 时取全量历史；有 tag 时自上个 tag 起
//   node scripts/generate-changelog.mjs --from <ref> --to <ref>
//   node scripts/generate-changelog.mjs --from root  # 强制全量历史（首版打 tag 后重生成用）
//   node scripts/generate-changelog.mjs --version 0.9.1 --date 2026-10-26
//   node scripts/generate-changelog.mjs --dry-run           # 只打印，不写文件
//   也可用 npm run changelog
//
// 约定：
//   - 只认 conventional commits：type(scope)!: subject；不认前缀的进「其他变更」，历史不丢。
//   - chore(release) 等发布元提交不进用户可见条目。
//   - 同一版本重复生成会替换同名小节，输出幂等（日期沿用首次生成值，除非显式 --date）。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECTIONS = [
  { key: "breaking", label: "⚠️ Breaking Changes" },
  { key: "feat", label: "✨ 新功能" },
  { key: "security", label: "🔒 安全修复" },
  { key: "fix", label: "🐛 Bug 修复" },
  { key: "perf", label: "⚡ 性能优化" },
  { key: "refactor", label: "♻️ 重构" },
  { key: "docs", label: "📝 文档" },
  { key: "test", label: "🧪 测试" },
  { key: "build", label: "📦 构建" },
  { key: "ci", label: "👷 CI" },
  { key: "chore", label: "🔧 其他维护" },
  { key: "other", label: "📌 其他变更（非 conventional commit）" }
];

const RELEASE_META = /^(chore\(release\)|release)[:!]/;
const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s?(.*)$/;

const HEADER = [
  "# Changelog",
  "",
  "本文件由 `scripts/generate-changelog.mjs` 从 git 历史自动生成，请勿手改；发布时重跑 `npm run changelog` 即可。",
  "格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。",
  "发布流程见 [RELEASE.md](RELEASE.md)。"
].join("\n");

const USAGE = [
  "用法：node scripts/generate-changelog.mjs [--from <ref|root>] [--to <ref>] [--version <x.y.z>]",
  "                                  [--date <YYYY-MM-DD>] [--out <path>] [--dry-run]",
  "  --from root   强制全量历史（忽略默认的“上个 tag 起点”）"
].join("\n");

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--from") args.from = argv[++i];
    else if (arg === "--to") args.to = argv[++i];
    else if (arg === "--version") args.version = argv[++i];
    else if (arg === "--date") args.date = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`未知参数：${arg}（--help 看用法）`);
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

/** 提交链接指向 fork remote（本仓库的日常开发远端）；取不到就退化成纯短哈希。 */
function repoUrl() {
  for (const remote of ["fork", "origin"]) {
    try {
      const raw = git(["remote", "get-url", remote]).trim();
      if (!raw) continue;
      const normalized = raw
        .replace(/^git@github\.com:/, "https://github.com/")
        .replace(/^git:\/\//, "https://")
        .replace(/\.git$/, "");
      if (normalized.startsWith("http")) return normalized;
    } catch {
      // remote 不存在或失效：忽略
    }
  }
  return null;
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readCommits(from, to) {
  const start = from === "root" ? null : from; // "root" 哨兵 = 全量历史
  const range = start ? (to ? `${start}..${to}` : start) : to ? to : "HEAD";
  const SEP = "\x1f";
  const REC = "\x1e";
  const out = git([
    "log",
    "--no-merges",
    `--pretty=format:%H${SEP}%h${SEP}%ad${SEP}%an${SEP}%s${SEP}%b${REC}`,
    "--date=short",
    range
  ]);
  return out
    .split(REC)
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.includes(SEP))
    .map((chunk) => {
      const [hash, short, date, author, subject, ...rest] = chunk.split(SEP);
      return { hash, short, date, author, subject: (subject ?? "").trim(), body: rest.join(SEP) };
    })
    .filter((c) => c.subject && !RELEASE_META.test(c.subject));
}

function classify(commit, url) {
  const match = CONVENTIONAL.exec(commit.subject);
  const hash = commit.short;
  const ref = url ? `[\`${hash}\`](${url}/commit/${hash})` : `\`${hash}\``;
  const by = commit.author ? `@${commit.author}，` : "";
  if (!match) {
    return { key: "other", line: `- ${commit.subject}（${by}${ref}）` };
  }
  const [, type, scope, bang, description] = match;
  const breaking = Boolean(bang) || /BREAKING[ -]CHANGE:/.test(commit.body);
  const security = type === "security" || scope === "security";
  const scopeLabel = scope ? `**${scope}：** ` : "";
  const line = `- ${scopeLabel}${description}（${by}${ref}）`;
  if (breaking) return { key: "breaking", line };
  if (security) return { key: "security", line };
  const known = SECTIONS.some((s) => s.key === type);
  return { key: known ? type : "chore", line };
}

function renderSection(version, date, commits, url) {
  const buckets = new Map(SECTIONS.map((s) => [s.key, []]));
  for (const commit of commits) {
    const { key, line } = classify(commit, url);
    buckets.get(key).push(line);
  }
  const parts = [`## [${version}] - ${date}`];
  for (const section of SECTIONS) {
    const lines = buckets.get(section.key);
    if (lines.length > 0) parts.push(`### ${section.label}\n${lines.join("\n")}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** 幂等合并：同名版本小节整体替换，其余小节原样保留，新小节置顶。 */
function mergeChangelog(existing, version, sectionBody) {
  if (!existing) return `${HEADER}\n\n${sectionBody}`;
  const at = existing.indexOf("\n## [");
  if (at === -1) return `${existing.trimEnd()}\n\n${sectionBody}`;
  const header = existing.slice(0, at).trimEnd();
  const rest = existing.slice(at + 1);
  const kept = rest
    .split(/\n(?=## \[)/)
    .map((block) => block.trimEnd())
    .filter((block) => block && !block.startsWith(`## [${version}]`));
  return kept.length > 0
    ? `${header}\n\n${sectionBody}\n${kept.join("\n\n")}\n`
    : `${header}\n\n${sectionBody}`;
}

/** 已存在同版本小节时沿用当时的日期，保证重复生成幂等。 */
function existingSectionDate(existing, version) {
  if (!existing) return null;
  const marker = `## [${version}] - `;
  const idx = existing.indexOf(marker);
  if (idx === -1) return null;
  const tail = existing.slice(idx + marker.length);
  const matched = /^(\d{4}-\d{2}-\d{2})/.exec(tail);
  return matched ? matched[1] : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const outPath = resolve(root, args.out ?? "CHANGELOG.md");
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const version = args.version ?? pkg.version;

  // from = "root" 是哨兵：显式要求全量历史，并跳过下面「上个 tag 起点」的默认解析。
  let from = args.from ?? null;
  const fromRef = from === "root" ? null : from; // 传给 git 的真实起点
  if (!from && !args.to) {
    try {
      from = git(["describe", "--tags", "--abbrev=0"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      from = null; // 还没有任何 tag：从仓库起点算全量历史
    }
  }

  const commits = readCommits(fromRef, args.to ?? "HEAD");
  if (commits.length === 0) {
    // 典型误用：刚给当前版本打完 tag 就再跑裸命令，范围变成 <tag>..HEAD（空）。
    // 此时若直接生成，会用空小节覆盖该版本既有内容，必须拦住。
    const alreadyGenerated = existingSectionDate(existing, version) !== null;
    console.error(
      `✗ 范围 ${from ? `${from}..` : ""}HEAD 内没有提交，拒绝生成${alreadyGenerated ? "（会覆盖 " + version + " 既有小节的）" : ""}空小节。`
    );
    console.error("  刚打完 tag 时请显式指定范围/版本，例如：");
    console.error(`  node scripts/generate-changelog.mjs --from ${from ?? "<上个tag>"}~1 --to HEAD --version <新版本>`);
    process.exit(1);
  }
  const date = args.date ?? existingSectionDate(existing, version) ?? today();
  const url = repoUrl();
  const body = renderSection(version, date, commits, url);
  const next = mergeChangelog(existing, version, body);

  if (args.dryRun) {
    process.stdout.write(next);
    return;
  }
  writeFileSync(outPath, `${next.trimEnd()}\n`, "utf8");
  const counts = new Map();
  for (const commit of commits) {
    const { key } = classify(commit, null);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const scope = from ? `${from}..HEAD` : "全量历史";
  console.log(`已写入 ${args.out ?? "CHANGELOG.md"}：${version}（${date}），${commits.length} 个提交，范围 ${scope}`);
  console.log(`分类：${[...counts.entries()].map(([k, n]) => `${k}=${n}`).join(" ") || "无"}`);
}

main();
