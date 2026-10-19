# 发布流程与检查清单（RELEASE）

> 适用范围：ai-meeting-workstation 桌面 App（Tauri 壳 + Node sidecar + Python 声纹侧车）
> 版本起点：**0.9.0**（首个可分发桌面版）；**1.0.0** 为 GA 正式版
> 关联文档：[CHANGELOG.md](CHANGELOG.md)（自动生成，勿手改）、[CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[README.md](README.md)

---

## 1. 版本号规范（语义化版本）

- 三段式 `MAJOR.MINOR.PATCH`，严格遵循 [semver 2.0.0](https://semver.org/lang/zh-CN/)。
- **当前阶段（< 1.0.0）**：`MINOR` = 新增能力/新档位/新链路；`PATCH` = 缺陷修复与内部调整；破坏性变更**不抬 MAJOR**，只写进 CHANGELOG 的 Breaking Changes 并在群里通告。
- **1.0.0 = GA 正式版**：需 Tauri 自动更新通道（T1.3）+ Windows 真机验收（T0.4）通过后由负责人拍板，不从 0.9.x 自动升。
- 预发布用后缀：`0.9.1-rc.1`、`0.9.1-beta.1`（内测包；自动更新通道默认不指向预发布版）。
- 版本号必须**四处同步**（漏一处会导致 Tauri 打包版本 / 更新校验 / 安装包名不一致）：

  | 文件 | 字段 | 说明 |
  |---|---|---|
  | `package.json` | `version` | Node 侧与 npm 脚本的唯一真相源，CHANGELOG 生成器默认取它 |
  | `src-tauri/tauri.conf.json` | `version` | Tauri 壳版本，进 .app/.dmg 包信息与 updater 校验 |
  | `src-tauri/Cargo.toml` | `[package] version` | Rust crate 版本 |
  | `src-tauri/Cargo.lock` | `[[package]] name = "ai-meeting-workstation"` 的 `version` | Cargo 自动生成，改 Cargo.toml 后由 `cargo check` 同步 |

- 校验命令（发布前与打 tag 后各跑一次）：

  ```bash
  node scripts/check-version.mjs              # 四处是否一致
  node scripts/check-version.mjs --tag v0.9.0 # 顺带校验 git tag
  ```

## 2. 版本变更与 CHANGELOG

- `CHANGELOG.md` 由 `scripts/generate-changelog.mjs` 从 git log 的 conventional commit 生成，**不要手改**（手改会在下次生成时被替换掉）。
- 生成命令：

  ```bash
  npm run changelog                                        # 默认范围：上个 tag..HEAD（无 tag 时全量历史）
  node scripts/generate-changelog.mjs --version 0.9.1 --date 2026-10-26
  node scripts/generate-changelog.mjs --from v0.9.0 --to HEAD --version 0.9.1   # 指定范围
  ```

- 规则：
  - 同版本重复生成**幂等**（同名小节整体替换，日期沿用首次生成值）；不同版本的小节按时间置顶保留。
  - `chore(release)` 等发布元提交自动排除，不进入用户可见条目。
  - 非 conventional 提交进「📌 其他变更」，历史不丢； commits 带作者与短哈希链接（链接指向 fork remote，push 后才可点）。
  - 分类顺序：Breaking → 新功能 → 安全 → 修复 → 性能 → 重构 → 文档 → 测试 → 构建 → CI → 维护 → 其他。
- commit 规范（沿用现有习惯，见 [CONTRIBUTING.md](CONTRIBUTING.md)）：`feat(asr): ...`、`fix(desktop): ...`、`refactor(client): ...`；破坏性变更加 `!`（`feat(server)!: ...`）并在正文写 `BREAKING CHANGE: ...`。

## 3. 发布流程（按序执行）

### 步骤 0 · 前置确认

- 在 `main` 上，且工作树中**只含本次发布范围的文件**（`git status --short` 核对）；他人/其他任务的在途改动不得混进发布提交。
- 远端就绪：日常开发远端是 `fork`（nierainbow/ai-meeting-workstation）；`origin`（renjieAI123）是上游快照、**不要推送**。push 动作属 T0.3 范围，origin 失效问题待人工决策。

### 步骤 1 · 预检（任一失败即中止，不得带病发布）

```bash
npm run typecheck                # tsc --noEmit
npm run lint                     # eslint .
npm test                         # vitest run；基线 27 文件 115 例，只增不减
npm run build                    # CI 同款：vite client + tsc server
node scripts/check-version.mjs   # 四处版本一致
```

### 步骤 2 · 版本号变更

- 按 §1 表格把四处改成目标版本；如已有 tag，先 `git fetch --tags` 对齐最新版本号。

### 步骤 3 · 生成 CHANGELOG

```bash
npm run changelog -- --version <x.y.z> --date <YYYY-MM-DD>
```

- 人工复核：条目是否覆盖本次范围、是否有应进 Breaking 的变更、**是否夹带敏感信息**（Key、转写全文、真实人名/客户名）。

### 步骤 4 · 发布提交

```bash
git add package.json CHANGELOG.md src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
# 如本次还改了发布相关文档/脚本，一并显式列出，不要用 git add -A
git commit -m "chore(release): <x.y.z>"
```

- 红线：不裹挟他人未提交改动；不包含 `.env`、`.local-data/`、`*.pkl`（声纹主库）、`*.wav`/`*.m4a` 等媒体、`*.sqlite`/`*.db`（见 §4 红线项）。
- `chore(release)` 这种元提交会被 CHANGELOG 生成器自动排除，不污染下个版本的条目。

### 步骤 5 · 打 tag

```bash
git tag -a v<x.y.z> -m "release: <x.y.z>"
node scripts/check-version.mjs --tag v<x.y.z>
```

- annotated tag，指向发布提交；tag 名与四处版本号严格对应（`v` 前缀仅存在于 tag）。

### 步骤 6 · 推送与 CI

```bash
git push fork main && git push fork v<x.y.z>
```

- 等 `.github/workflows/ci.yml` 全绿：ubuntu + windows 两个 matrix 的 typecheck / lint / test / build，外加 Windows 云端档安装器与启动器冒烟。**红钩必须修完再继续**。

### 步骤 7 · 桌面打包

```bash
npm run build:desktop      # = build:sidecar(含 --with-node) → vite build → tauri build
```

- 产物在 `src-tauri/target/release/bundle/`；体积预算 **< 300MB**（T1.1 实测 .app 156.93 MiB）。
- 冒烟：双击启动 → sidecar 起 server(8787) → WebView 与 8787 同源打开 → `/api/health` 返回 ok → 完成一次云端文件转写；无 Key 时应给出明确中文提示。
- 环境前提：需网络（从 nodejs.org 下载约 108MB 官方 Node 22 运行时、crates.io 拉 Rust 依赖）+ Rust 工具链。
  本机 rustup 工具链不在默认 PATH 时先 `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`。

### 步骤 8 · 分发

- 内部静态更新服务器 / GitHub Releases 私有仓（T1.3 自动更新通道）；更新前备份 `.local-data/`。
- 把 CHANGELOG 对应小节贴进发布说明；模型权重分发仍走 ModelScope，不随安装包分发数 GB 模型。

### 步骤 9 · 发布后

- 在 T1.3 更新通道登记新版本，验证旧版能检测并平滑升级、`.local-data/` 无损。
- 在 §6 演练记录表登记：日期 / 版本 / 执行人 / 结果 / 备注。
- 声纹链路如有改动，确认 UI 自动识别一律为「疑似」样式（诚实口径，禁止自动定名当事实展示）。

---

## 4. 发布前检查清单（逐项打勾，任意一项不过即中止）

### 🚨 红线（安全合规）

- [ ] `git status --short` 与 `git diff --cached --name-only` 核对：无 `.env`、`.local-data/`、`*.pkl`（声纹主库）、`*.wav`/`*.m4a`/`*.mp4` 等媒体、`*.sqlite`/`*.db`/`*.log`
- [ ] 仓库内无明文 Key：`git grep -nE "ark-[A-Za-z0-9]{8}|AKLT[A-Za-z0-9]"` 无命中（Key 走系统钥匙串，见 `feat(settings)` 提交）
- [ ] 声纹自动识别展示为「疑似」样式（改了识别链路时必查）
- [ ] 模型权重来源为 ModelScope（改了下载链路时必查）

### 🔧 工程

- [ ] `node scripts/check-version.mjs` 四处版本一致
- [ ] `npm run typecheck && npm run lint && npm test` 全绿，用例数不低于基线（27 文件 115 例）
- [ ] `npm run build` 通过
- [ ] Rust 壳可编译：`cd src-tauri && cargo check`
- [ ] `npm run changelog` 已重生成本次版本，且再次生成 diff 为空（幂等）
- [ ] 发布提交只含版本与文档文件，无夹带（`git show --stat HEAD` 核对）
- [ ] annotated tag `v<x.y.z>` 指向发布提交：`git rev-parse v<x.y.z>` == `git rev-parse HEAD`
- [ ] CI 全绿后才进入分发
- [ ] README / SECURITY 与本次形态一致（新档位、新依赖、新权限、安装方式变化要写）

### ✍️ 签发

- [ ] §6 记录表已登记（日期 / 版本 / 执行人 / 结果）
- [ ] 桌面产物实测可启动并完成一次云端文件转写
- [ ] T1.3 更新通道已登记，旧版升级冒烟通过

---

## 5. 回滚与热修

- **热修**：从出问题的发布 tag 拉 `hotfix/<x.y.z>` 分支 → 只带修复 → `PATCH + 1` → 走 §3 全流程。
- **分发侧回滚**：把更新通道 `latest.json` 指回上一个版本（旧安装包必须保留）。
- **数据安全第一**：升级/回滚都不动 `.local-data/`（客户档案、声纹库、设置、日志）。
- ** tag 不删不改**：发错的版本用新 PATCH 纠正，不移动已推送的 tag。

---

## 6. 发布演练记录

| 日期 | 版本 | 执行人 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-10-19 | v0.9.0（本地演练） | ts-engineer-2 | 见下方明细 | 未 push；桌面全量打包未重跑（见已知限制） |

### 2026-10-19 · v0.9.0 演练明细（真实执行记录）

#### 环境

- macOS（Apple Silicon）；Node v22.22.3；cargo 1.98.0（rustup 工具链，不在默认 PATH，演练时用 `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`）
- 发布候选提交：`0b28363`（`chore(release): 0.9.0`）
- 主工作树当时同时含 T1.2 在途改动（见下方问题 1），为隔离影响，预检在 `git worktree`（detached @ `0b28363`、node_modules 软链复用）的干净树上执行

#### 执行记录（全部真实执行）

| # | 步骤 | 命令 | 结果 |
|---|---|---|---|
| 1 | 红线：敏感文件 | `git check-ignore -v .env .local-data` | 两条均被 .gitignore 命中 |
| 2 | 红线：明文 Key | `git grep -nE "ark-[A-Za-z0-9]{8}\|AKLT[A-Za-z0-9]"` | tracked 0 命中 |
| 3 | 红线：敏感二进制 | `git ls-files \| grep -E '\.(pkl\|wav\|m4a\|sqlite\|db)$'` | 仅白名单开源 demo wav |
| 4 | 预检 typecheck | `npm run typecheck` | exit 0 |
| 5 | 预检 lint | `npm run lint` | exit 0 |
| 6 | 预检 test | `npm test` | exit 0，**27 文件 115 例 = 基线**，0 退化 |
| 7 | 预检 build | `npm run build` | exit 0（client 264.07 kB + server tsc） |
| 8 | 版本一致性 | `node scripts/check-version.mjs` | 四处 0.9.0，exit 0 |
| 9 | 门禁负测（版本漂移） | 临时把 tauri.conf 改 0.9.1 再跑 | exit 1 并列出差异，已还原复绿 |
| 10 | 门禁负测（tag 缺失） | `--tag v0.9.0`（打 tag 前） | exit 1 提示不存在 |
| 11 | CHANGELOG 生成 | `npm run changelog`（0.9.0 / 2026-10-19） | 9 commits：feat=5 ci=1 refactor=1 chore=1 other=1 |
| 12 | CHANGELOG 幂等 | 连跑 3 次 + 干净树重生 | SHA-256 均为 `f255009e…`，`git diff` 为空 |
| 13 | Rust 壳编译 | `cd src-tauri && cargo check` | exit 0，`Compiling ai-meeting-workstation v0.9.0`，27.92s |
| 14 | 发布提交 | `git commit`（chore(release): 0.9.0） | 8 files，+529/-4，只含版本与文档/脚本 |
| 15 | 打 tag | `git tag -a v0.9.0 -m "release: 0.9.0"` | annotated，指向发布提交 |
| 16 | tag 校验 | `node scripts/check-version.mjs --tag v0.9.0` | tag 与四处版本一致 |

**结论**：版本 / CHANGELOG / 发布流程三件套与流程门禁全部跑通；发布候选提交在干净树上三项检查与基线一致。

### 已知限制（本次演练未覆盖，需人工/后续任务补齐）

1. **push 未执行**：`origin` 远端失效问题待人工决策，push 属 T0.3 范围；演练只做到本地 tag。
2. **桌面全量打包未重跑**：`npm run build:desktop` 会从 nodejs.org 重下约 108MB Node 运行时，演练改用 `cargo check`（Rust 壳 + 版本号变更可编译）+ T1.1 已实测的打包链路证据；正式发布必须跑全量打包并做 §3 步骤 7 冒烟。
3. **CI 未观测**：push 后才会有绿钩记录。

### 暴露的问题（已上报 captain）

1. **T1.2 在途改动导致 typecheck 红**：`src/server/models/modelDownloader.test.ts` 报 `TS2459: HttpResponse / RequestOptions 未导出`。发布以「发布候选提交」为准验收（干净树上三项全绿），但在途合入前不得打正式 tag。
2. **`.gitignore` 忽略 `docs/` 与 T2.7 计划冲突**：任务计划 T2.7 要求「回归报告落 `docs/`」，但 `docs/` 自开源化起被忽略（内部设计文档不入库），报告入库需另行决策目录或改忽略规则。本次发布文档按仓库惯例放根目录（CHANGELOG.md / RELEASE.md）不受影响。
