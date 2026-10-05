# 参与 java-run 开发

java-run 从 Java 源码工作区选择启动目标，由 Maven 或 Gradle 准备源码和运行依赖，再启动 Java。
使用契约见 [README](README.md)，模块职责见 [架构设计](docs/architecture.md)，演进方向见 [技术路线](docs/roadmap.md)。

## 开发环境与日常检查

- 使用 [`.bun-version`](.bun-version) 指定的 Bun，并按仓库锁文件安装依赖
- 在 PATH 中提供 JDK 的 `java`、`javac` 和 `jar`
- 安装 Maven 和 Gradle，用于真实项目验收；首次运行可能下载插件与依赖

CI 使用 JDK 17 / 21 和 Gradle 8.14，夹具以 Java 17 为最低版本。
目标项目存在 Wrapper 时，运行器优先使用 Wrapper；项目自身的 JDK 和构建工具要求仍需满足。

```sh
bun install --frozen-lockfile
bun run check
bun run compile
bun run smoke
```

| 命令 | 验证内容 |
| --- | --- |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun test` | 参数、配置、初始化、适配器、主类、类路径、交互和进程行为回归 |
| `bun run check` | 类型检查与回归测试 |
| `bun run compile` | 构建本机独立二进制及 `.sha256` 校验文件到 `dist` |
| `bun run smoke` | 使用该二进制运行真实 Maven / Gradle 夹具 |

回归测试中的真实 Gradle 用例使用 PATH 中的 Gradle，找不到时会跳过。
可用 `JAVA_RUN_TEST_GRADLE` 指定命令，并用 `GRADLE_USER_HOME` 隔离测试缓存：

```sh
GRADLE_USER_HOME=/tmp/java-run-test-gradle \
JAVA_RUN_TEST_GRADLE=/path/to/gradle \
bun run check
```

## 编译二进制

本地编译和发布构建共用 `bun run compile`。
默认输出 `dist/java-run`，Windows 自动使用 `.exe` 扩展名。
可用等号形式指定目标与输出路径：

```sh
bun run compile --target=bun-darwin-arm64 --outfile=dist/java-run
```

可用目标见下方[发布平台表](#发布平台与产物)。
编译成功后，在二进制旁生成 `<二进制文件名>.sha256`，自定义输出路径也遵循这一规则。
校验文件采用标准 SHA-256 清单格式，文件名相对于其所在目录。

二进制不自动加载运行目录中的 `.env` 或 `bunfig.toml`，显式继承的环境变量仍然生效。

## 二进制验收

smoke 将夹具复制到临时目录，使用独立的 Maven settings、本地仓库和 Gradle 用户目录。
它从被测二进制的 PATH 中移除当前 Bun 安装目录，验证产物可独立运行。

```sh
bun run smoke --suite=quick
bun run smoke --fixture=gradle-reactor
bun run smoke --cli=/path/to/java-run --suite=full --keep
```

| 选项 | 范围 |
| --- | --- |
| `--suite=quick` | 帮助、版本、静态预览、基本启动、初始化与配置复用 |
| `--suite=full` | 默认套件；在 quick 基础上验证测试类路径、配置优先级、资源与依赖更新、非零退出 |
| `--fixture=<名称>` | 限定项目夹具，保留帮助、版本和预览检查 |
| `--cli=<路径>` | 指定待验收的二进制，默认使用 `dist` 中的本机产物 |
| `--keep` | 成功后也保留临时目录 |

成功后默认清理临时目录；失败时保留项目副本及逐项 stdout / stderr 日志，并输出保留位置。
具体夹具与观测标记见 [夹具说明](tests/fixtures/README.md)，验收项数以脚本输出为准。

需要复用下载时，指定专用测试缓存：

```sh
JAVA_RUN_MAVEN_REPOSITORY=/tmp/java-run-test-maven \
JAVA_RUN_GRADLE_HOME=/tmp/java-run-test-gradle \
JAVA_RUN_GRADLE_COMMAND=/path/to/gradle \
bun run smoke
```

测试缓存应独立于个人 `~/.m2` 和 `~/.gradle`。
`JAVA_RUN_GRADLE_COMMAND` 控制 smoke 的 Gradle 命令，`JAVA_RUN_TEST_GRADLE` 控制回归测试的 Gradle 命令。
smoke 也接受 `JAVA_RUN_SMOKE_SUITE`、`JAVA_RUN_SMOKE_FIXTURE` 和 `JAVA_RUN_SMOKE_KEEP=1`，同名命令行选项优先。

## 修改与提交

从主分支创建具有单一意图的工作分支，如 `feat/gradle-project-selection` 或 `fix/process-exit-code`。
修改前检查工作区并保留其他人的未提交内容；同时处理独立修改时使用隔离分支或 worktree。

提交遵循 Conventional Commits：type 与 scope 使用英文，subject 使用中文，例如：

```text
feat(cli): 支持交互生成启动配置
fix(maven): 保留选定项目的运行依赖范围
test(gradle): 验证无关应用不参与编译
docs: 说明参数传递规则
```

提交按可审查的意图拆分，排除无关改动、生成产物和依赖缓存。
提交前检查差异并运行相关验证；PR 说明应写清触发场景、最终行为、实际测试结果和未验证的平台。

源码注释使用中文，说明必要的契约、边界和原因。
公开 API 的说明放在所属接口、字段或方法，架构取舍放入设计文档。
Markdown 正文使用正常中文标点，同组列表保持语法与标点统一。
较长段落按主题拆分，Markdown 源文件按语义换行。

## 验证要求

行为修改应验证调用者可以观察到的结果。
构建工具适配的修改需要真实项目验收，模拟输出用于覆盖具体边界。

回归重点包括：

- 单项目与多模块目标、上游依赖和无关项目隔离
- 自动准备与 `--build=none`，模型、资源或依赖变化后的重新解析
- 主类声明、唯一入口、多个入口和无入口
- JVM、应用和构建参数边界，以及空格、中文、`#`、`%` 等字符
- 默认测试隔离和显式测试类路径
- 正常与非零退出、平台对应的信号处理和进程树清理
- 帮助、版本和静态预览的无构建行为
- 终端选择、非 TTY 行为、EOF / Ctrl+C 取消和退出码
- `init` 保存后重复运行、参数保留、已有配置保护与 `--force` 重新生成
- 初始化失败或取消时保留已有配置

测试在临时项目或夹具副本中运行，保持 `tests/fixtures` 和用户提供的源仓库不变。
环境和信号测试使用隔离子进程，平台专用测试的跳过条件应与实际系统能力对应。
跨平台结论以对应系统上的执行结果为依据，跳过的测试不计为通过验收。

## CI 与发布

[Check 工作流](.github/workflows/check.yaml) 在分支 push、PR 和复用调用时运行。
Linux、macOS、Windows 与 JDK 17 / 21 组成六组矩阵，分别执行锁文件安装、类型检查、回归测试、本机编译和完整 smoke。
最新结果可在 [GitHub Actions](https://github.com/Vanisper/java-run/actions/workflows/check.yaml) 查看。

[Release 工作流](.github/workflows/release.yaml) 共用同一套构建与验收步骤，提供以下入口：

| 入口 | 验收与输出 |
| --- | --- |
| 分支 push 命中 `paths` | 五平台产物演练，保存 Actions artifacts 和发布说明预览；Check 独立运行 |
| `workflow_dispatch` | 手动产物演练，并复用完整 Check |
| `v*` 标签 push | 校验版本与许可证，执行完整 Check 和五平台验收，通过后发布 GitHub Release |

`paths` 限制分支演练的触发范围，包括工作流、发布脚本、相关测试、版本配置和安装指南等，完整清单以工作流为准。
标签 push 不受此路径条件限制。
工作流进入默认分支后，可通过 Actions 页面或 GitHub CLI 选择分支手动演练。

### 发布平台与产物

[平台清单](scripts/platforms.ts) 统一定义编译目标、原生 runner、包内目录和公开资产名称：

| ZIP 资产 | 编译目标 | 原生 runner |
| --- | --- | --- |
| `java-run-windows-x64.zip` | `bun-windows-x64` | `windows-2025` |
| `java-run-linux-x64.zip` | `bun-linux-x64` | `ubuntu-24.04` |
| `java-run-linux-arm64.zip` | `bun-linux-arm64` | `ubuntu-24.04-arm` |
| `java-run-darwin-arm64.zip` | `bun-darwin-arm64` | `macos-15` |
| `java-run-darwin-x64.zip` | `bun-darwin-x64` | `macos-15-intel` |

每个平台依次执行：

1. 编译一次待分发的二进制及校验文件，在 JDK 21 下执行完整 smoke。
2. 核对源二进制校验和，并打包 ZIP。Linux / macOS 使用 `zip`，Windows 使用 PowerShell `Compress-Archive`。
3. 解压实际 ZIP，核对文件集合、内容、二进制校验和及 Unix 可执行权限。
4. 使用 JDK 17 对解压出的二进制执行 quick 验收，再上传 ZIP。

每份 ZIP 只有一个 `java-run-<平台>/` 目录，包含：

- `java-run` 或 `java-run.exe`
- 对应的 `java-run.sha256` 或 `java-run.exe.sha256`
- 从 [安装指南](docs/installation.md) 复制的 `INSTALL.md`
- 仓库中存在的 `LICENSE`、`LICENSE.md` 或 `LICENSE.txt`

汇总步骤要求恰好包含五种非空 ZIP 普通文件，然后生成并核对 `SHA256SUMS`。
包内 `.sha256` 校验二进制，Release 单独提供的 `SHA256SUMS` 校验下载的 ZIP。
资产名称不带版本号，指定版本通过 `/releases/download/v<版本>/` 下载，最新稳定版使用 `/releases/latest/download/`。

源码 Check 在两个 JDK 上均执行完整回归；发布产物在 JDK 21 上执行 full，在 JDK 17 上执行 quick。
Linux 产物在 Ubuntu 24.04 的 glibc 环境验收，musl 和其他系统版本未纳入验证范围。

### 本地演练

`scripts/release.ts` 读取当前 `package.json` 的版本，提供五个子命令：

| 子命令 | 职责 |
| --- | --- |
| `metadata` | 校验版本，输出标签、预发布标识和平台矩阵；标签环境还校验标签与许可证 |
| `package <平台>` | 打包 `dist` 中已有的二进制与校验文件，解压核对并执行 quick |
| `checksums` | 核对 `dist` 中的五份 ZIP 集合，生成 `SHA256SUMS` |
| `notes` | 向标准输出生成下载与安装说明 |
| `verify-assets` | 从标准输入读取远端资产名称的 JSON 数组，核对五份 ZIP 和 `SHA256SUMS` 是否齐全且无额外文件 |

在对应平台的原生机器上构建并验收 ZIP，例如 macOS arm64：

```sh
bun scripts/release.ts metadata
bun run compile
bun run smoke --suite=full
bun scripts/release.ts package darwin-arm64
```

`package` 输出 `dist/java-run-darwin-arm64.zip`，其 quick 验收使用当前环境的 JDK。
本地复现发布矩阵时，先用 JDK 21 编译和执行 full，再切换到 JDK 17 执行 `package`。

五个平台的 ZIP 汇集到只含这些文件的 `dist` 目录后，可执行 `checksums`。
编译留下的裸二进制和 `.sha256` 不属于汇总输入。
分支与手动演练保存产物和说明预览，不创建标签或 GitHub Release。

### 发布版本

发布前完成以下准备：

- 确定开源许可证，添加非空的 `LICENSE`、`LICENSE.md` 或 `LICENSE.txt`
- 确定发布版本，更新 `package.json` 并核对版本输出
- 完成待发布提交的检查，审查平台产物和支持边界

`bun run version` 使用 bumpp 调整 `package.json`，不自动提交、创建标签或推送。
版本变更通过 PR 合入主分支后，创建并推送 `v<package.json 版本>` 标签。
版本必须符合 SemVer，标签必须与包版本严格一致。

元数据校验通过后，同一标签提交的六组 Check 与五平台产物验收并行执行。
全部通过后，工作流创建或恢复未公开草稿，上传五份 ZIP 和 `SHA256SUMS`。
Release 正文包含下载表、安装说明及 GitHub 生成的变更说明。

公开前会核对远端资产集合，缺失或额外文件均使流程失败并保留草稿。
上传和核对成功后自动公开，无需额外人工审批。
预发布版本标记为 prerelease，且不标记为 latest；稳定版的 latest 选择使用 GitHub 默认规则。
同一标签的运行串行执行，不中断正在进行的发布。

发布完成后，检查 Release 的标签、下载表、ZIP 内容和校验和，并按安装指南核对下载后的版本输出。

### 失败重试

网络、下载或上传偶发失败时，可重跑失败任务：

```sh
gh run rerun <run-id> --failed
```

重跑使用原始提交和 ref，已验收的 Actions artifacts 支持同名覆盖。
Release 资产只允许在未公开草稿中替换；已经公开的标签版本会被拒绝。
修改代码后应运行新提交的验收，已发布版本的修正通过新版本发布。
