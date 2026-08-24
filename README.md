# dsh-superpowers-plugin

[![Release](https://img.shields.io/github/v/release/PeiJingbobo/dsh-superpowers-plugin?sort=semver)](https://github.com/PeiJingbobo/dsh-superpowers-plugin/releases)
[![Sync upstream & release](https://github.com/PeiJingbobo/dsh-superpowers-plugin/actions/workflows/sync-and-release.yml/badge.svg)](https://github.com/PeiJingbobo/dsh-superpowers-plugin/actions/workflows/sync-and-release.yml)
[![Upstream](https://img.shields.io/badge/upstream-obra%2Fsuperpowers-8b5cf6)](https://github.com/obra/superpowers)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)

把 [obra/superpowers](https://github.com/obra/superpowers)(AI Agent 编码范式技能库:TDD、系统化调试、头脑风暴、计划执行等)制作成 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的插件(dsh bundle)。启用后,AI 在编码对话中会**自动识别这些技能并通过原生 `skill` 工具应用**,无需手动搬运文件。

- **上游跟踪**:仓库内置 GitHub Actions,推送代码时自动同步上游快照;每 6 小时定时轮询上游,**上游发布新版后自动构建并发版**,始终保持最新(见[自动化](#自动化))。
- **版本对齐**:插件版本号 = 上游 superpowers 版本号,一个上游 release 对应一个插件 release。
- **零依赖**:纯 ESM JavaScript,无构建步骤、无运行时依赖。

## 工作原理

插件向 DSH 技能注册表(`ctx.skills`)注册一个 skill provider,其余能力全部复用 harness 内建机制:

| 环节 | 由谁完成 | 效果 |
|---|---|---|
| 技能发现 | 本插件 provider | 扫描内置 `skills/` 目录,解析 `SKILL.md` frontmatter |
| 会话技能目录 | `dsh-tool-skill`(内建) | 自动注入 `<available_skills>` 持久提醒,列出全部技能摘要 |
| 技能加载 | `dsh-tool-skill`(内建) | 模型按需调用 `skill({ name })` 获取完整指令 |
| `/技能名` 直呼 | `dsh-tool-skill`(内建) | 用户消息里的 `/brainstorming` 直接注入技能全文 |
| 主动应用强化 | 本插件 bootstrap | 会话开始注入一次 `using-superpowers` 定向说明 + DSH 工具映射 |

也就是说:**启用插件 = superpowers 全部技能进入每个会话的技能目录,模型被明确要求在任务前检查并加载匹配技能** —— 与 Claude Code 中安装 superpowers 插件的体验对齐。

优先级:项目 `.dsh/skills`、`.agents/skills` 与用户级技能目录中的同名技能**优先于**本插件的内置副本(rank 600),方便你局部覆盖某条技能而不影响整体更新。

## 安装

前置:已安装 DeepSeek Harness CLI(源码运行则用 `pnpm dsh ...`)。

```sh
# 方式一:直接从 git 仓库安装(纯 JS 零构建,无需 allowBuilds)
dsh plugin add github:PeiJingbobo/dsh-superpowers-plugin

# 方式二:下载 Release 产物安装
gh release download --repo PeiJingbobo/dsh-superpowers-plugin -p '*.tgz'
dsh plugin add ./dsh-superpowers-plugin-*.tgz

# 方式三:本地目录(开发体验)
dsh plugin add /path/to/dsh-superpowers-plugin

# 之后启动:
dsh web            # 或: dsh --profile <你的profile>
```

安装即生效:`dsh plugin add` 会识别包内的 `dsh.bundle` 清单并把插件行写入 profile。启动日志会出现:

```
dsh-superpowers-plugin: serving skills from .../skills
```

### 源码开发模式(不安装)

```sh
pnpm dsh web --patch /path/to/dsh-superpowers-plugin/cordis.local.example.yml
```

## 自动化

`.github/workflows/sync-and-release.yml` 在三种情况下运行:

| 触发 | 行为 |
|---|---|
| `push` 到 main | 同步上游快照 → 测试 → 打包 tgz → 版本标签不存在则发布 Release |
| `schedule`(每 6 小时) | 轮询上游 obra/superpowers main;有更新则提交同步 commit 并发新版本 —— 这就是"上游更新后自动构建"的规则(GitHub 无法被外部仓库 webhook 触发,轮询是标准做法) |
| `workflow_dispatch` | 手动触发,可选 `repo` / `ref` 参数临时切换上游源 |

要点:

- **版本策略**:同步脚本读取上游 `package.json` 的 `version` 写入本包,因此每个 Release 都精确对应一次上游发布(`v6.3.0` = superpowers 6.3.0 快照);同一版本的重复构建不会重复发版。
- **无循环**:同步 commit 使用 GITHUB_TOKEN 提交,GitHub 规定其 push 不会再触发 workflow。
- 手动触发:`gh workflow run sync-and-release.yml --repo PeiJingbobo/dsh-superpowers-plugin`
- ⚠️ 仓库连续 60 天无任何活动时,GitHub 会暂停 schedule;任意 push 或手动运行即可恢复。

### 本地手动同步

```sh
node scripts/sync-upstream.mjs              # 从 UPSTREAM.json 的上游拉取最新
node scripts/sync-upstream.mjs --check      # 只检查漂移,落后时 exit 1(适合 CI)
node scripts/sync-upstream.mjs --from ../superpowers   # 从本地克隆同步(离线)
node scripts/sync-upstream.mjs --repo <url> --ref <branch>   # 临时换源(会持久化)
# 或:npm run sync / npm run sync:check
```

- 同步会把上游 `skills/` 整体替换到本包(含删除),记录 `{ repo, ref, commit, upstreamVersion, syncedAt }` 到 `UPSTREAM.json`,并刷新 `LICENSE-SUPERPOWERS`、对齐 `package.json` 版本号。
- **正在运行的 harness 无需重启**:插件监听 `skills/` 变化,目录变更会让技能目录失效并在下一轮自动重新发布(`<available_skills>` 更新提醒)。
- 上游内容保持逐字节一致,不做本地改写,因此永远可以干净地跟随 upstream。

## 配置(patch 行的 `config`)

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `providerName` | string | `"superpowers"` | 注册表中的 provider 名 |
| `skillsDir` | string | 包内 `./skills` | 改为指向任意 superpowers 克隆的 skills 目录 |
| `rank` | number | `600` | 同层重名裁决优先级,越小越优先 |
| `source` | string | `"bundled"` | 目录中展示的来源标签 |
| `disabledSkills` | string[] | `[]` | 按名禁用个别技能 |
| `bootstrap` | boolean | `true` | 是否注入会话引导(using-superpowers 定向) |

示例(profile 的 `cordis.patch.yml`):

```yaml
- update:
    id: dsh-superpowers-plugin
    config:
      bootstrap: false
      disabledSkills: [using-git-worktrees]
```

## 验证

```sh
dsh --dump-config          # 应看到 "# == dsh-superpowers-plugin" 层与 dsh-superpowers-plugin 行
```

进入会话后:

- 输入"帮我实现 X 功能"→ 模型应先调用 `skill` 加载 `brainstorming`;
- 输入 `/systematic-debugging` → 直接注入该技能全文;
- 新会话开头应出现一次 `You have superpowers.` 引导(system-reminder)。

## 测试

```sh
node --test test/*.test.mjs    # 11 个用例:frontmatter 解析、发现/加载、配置校验、引导注入语义
```

## 目录结构

```
dsh-superpowers-plugin/
├── package.json            # dsh.bundle 清单(patch: ./cordis.patch.yml);版本跟随上游
├── cordis.patch.yml        # bundle 层:插入 dsh-superpowers-plugin 插件行
├── cordis.local.example.yml# 源码开发 overlay 模板
├── index.js                # 插件主体:skill provider + 会话引导(零依赖 ESM)
├── scripts/sync-upstream.mjs # 上游同步脚本(含版本捕获)
├── skills/                 # 上游技能快照(sync 目标,勿手改)
├── UPSTREAM.json           # 上游跟踪元数据(repo/ref/commit/upstreamVersion/syncedAt)
├── .github/workflows/sync-and-release.yml # 同步+测试+打包+发版流水线
├── test/smoke.test.mjs     # node:test 冒烟测试
└── LICENSE-SUPERPOWERS     # 上游 MIT 许可证副本
```

## License

打包代码 MIT。`skills/` 内容来自 [obra/superpowers](https://github.com/obra/superpowers)(MIT,© Jesse Vincent),许可见 `LICENSE-SUPERPOWERS`。

---

### English summary

A zero-dependency DeepSeek Harness bundle that serves the [obra/superpowers](https://github.com/obra/superpowers) skill library as native DSH skills. It registers one `ctx.skills` provider over a vendored snapshot and optionally injects the one-shot `using-superpowers` session orientation with a DeepSeek Harness tool mapping.

Automation: a single workflow (`sync-and-release.yml`) re-syncs the snapshot on every push to `main`, polls upstream every 6 hours (the "upstream updated → rebuild" rule — external repos cannot webhook GitHub), runs the tests, packs the tarball, and publishes a GitHub Release tagged after the upstream version. Install with `dsh plugin add github:PeiJingbobo/dsh-superpowers-plugin` or grab a tarball from Releases.
