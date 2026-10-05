# 参与 java-run 开发

java-run 从 Java 源码工作区选择一个启动目标，由 Maven 或 Gradle 准备源码和运行依赖，再启动 Java。使用契约见 [README](README.md)，模块职责与设计约束见 [架构设计](docs/architecture.md)，演进方向见 [技术路线](docs/roadmap.md)。

## 开发环境

- 使用 [`.bun-version`](.bun-version) 指定的 Bun，以及仓库中的依赖锁文件
- JDK 的 `java`、`javac` 和 `jar` 需要在 PATH 中可用；真实项目应使用符合自身要求的 JDK
- 完整验收需要 Maven 和 Gradle，首次运行可能下载插件与依赖

CI 使用 JDK 17 / 21 和 Gradle 8.14。夹具以 Java 17 为最低版本；这些版本构成验证环境，其他构建工具或 JDK 版本需要单独验证。目标项目存在 Wrapper 时，运行器优先使用 Wrapper。

安装依赖并执行日常检查：

```sh
bun install --frozen-lockfile
bun run check
bun run compile
bun run smoke
```

| 命令 | 验证内容 |
| --- | --- |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun test` | 参数、配置、适配器、主类、类路径、交互和进程行为回归 |
| `bun run check` | 类型检查与回归测试 |
| `bun run compile` | 构建压缩后的本机二进制到 `dist`，与发布产物使用同一入口 |
| `bun run smoke` | 使用该二进制运行真实 Maven / Gradle 夹具 |

编译入口支持等号形式的 `--target=<目标>` 和 `--outfile=<路径>`，可用目标与发布平台表一致。默认产物为 `dist/java-run`，Windows 自动使用 `.exe` 扩展名。二进制不自动加载运行目录中的 `.env` 或 `bunfig.toml`，显式继承的环境变量仍然生效。

回归测试中的真实 Gradle 用例使用 PATH 中的 Gradle；找不到时会跳过，不能据此判断 Gradle 适配已经通过验收。可通过 `JAVA_RUN_TEST_GRADLE` 指定测试命令，通过 `GRADLE_USER_HOME` 隔离测试用的 Gradle 缓存：

```sh
GRADLE_USER_HOME=/tmp/java-run-test-gradle \
JAVA_RUN_TEST_GRADLE=/path/to/gradle \
bun run check
```

## 二进制验收

smoke 会复制夹具到临时目录，使用独立的 Maven settings、本地仓库和 Gradle 用户目录，并从被测二进制的 PATH 中移除当前 Bun 安装目录，验证其运行不依赖 Bun。成功后默认清理临时目录；失败或指定 `--keep` 时保留项目副本与逐项 stdout / stderr 日志，输出中给出保留位置。

```sh
bun run smoke --suite=quick
bun run smoke --fixture=gradle-reactor
bun run smoke --cli=/path/to/java-run --suite=full --keep
```

`quick` 验证帮助、版本、静态预览和选定夹具的基本启动；`full` 是默认范围，进一步验证测试类路径、配置优先级、资源和依赖更新、非零退出等行为。`--fixture` 限定项目夹具，同时保留帮助、版本和预览检查。具体夹具与观测标记见 [夹具说明](tests/fixtures/README.md)，执行项目数以脚本输出为准。

需要复用下载时，可以指定专用测试缓存：

```sh
JAVA_RUN_MAVEN_REPOSITORY=/tmp/java-run-test-maven \
JAVA_RUN_GRADLE_HOME=/tmp/java-run-test-gradle \
JAVA_RUN_GRADLE_COMMAND=/path/to/gradle \
bun run smoke
```

不要将这些测试缓存指向个人 `~/.m2` 或 `~/.gradle`。`JAVA_RUN_GRADLE_COMMAND` 用于 smoke，`JAVA_RUN_TEST_GRADLE` 用于回归测试；两者各自控制对应脚本的 Gradle 命令。smoke 也支持 `JAVA_RUN_SMOKE_SUITE`、`JAVA_RUN_SMOKE_FIXTURE`、`JAVA_RUN_SMOKE_KEEP=1`，同名命令行选项优先。

## 修改与提交

从主分支创建具有单一意图的工作分支，如 `feat/gradle-project-selection` 或 `fix/process-exit-code`。修改前检查工作区，保留其他人的未提交内容；需要同时处理独立修改时使用隔离分支或 worktree。

提交遵循 Conventional Commits：type 与 scope 使用英文，subject 使用中文，例如：

```text
feat(cli): 支持缺失主类的终端选择
fix(maven): 保留选定项目的运行依赖范围
test(gradle): 验证无关应用不参与编译
docs: 说明参数传递规则
```

提交按可审查的意图拆分，避免混入无关改动、生成产物和依赖缓存。提交前检查差异并运行相关验证；PR 说明应写清触发场景、最终行为、实际测试结果和未验证的平台。

源码注释使用中文，说明必要的契约、边界和原因，避免复述代码。公开 API 的说明应放在所属接口、字段或方法；架构取舍放入设计文档。Markdown 正文使用正常中文标点，同组列表保持语法与标点统一。

## 验证要求

行为修改应验证调用者可以观察到的结果。构建工具适配的修改需要真实项目验收，不能只依赖模拟 Maven / Gradle 输出。

回归重点包括：

- 单项目与多模块目标、上游依赖和无关项目隔离
- 自动准备与 `--build=none`，模型、资源或依赖变化后的重新解析
- 主类声明、唯一入口、多个入口和无入口
- JVM、应用和构建参数边界，以及空格、中文、`#`、`%` 等字符
- 默认测试隔离和显式测试类路径
- 正常与非零退出、平台对应的信号处理和进程树清理
- 帮助、版本和静态预览的无构建行为
- 终端选择、非 TTY 行为、EOF / Ctrl+C 取消和退出码

测试应在临时项目或夹具副本中运行，不在 `tests/fixtures` 下生成 `target`、`build`、`.gradle` 或缓存，也不修改用户提供的源仓库。环境和信号测试使用隔离子进程，避免污染其他用例。平台专用测试的跳过条件应与实际系统能力对应；跨平台结论以对应系统上的执行结果为依据。

## CI 与发布

[Check 工作流](.github/workflows/check.yaml) 在分支 push、PR 和复用调用时运行。Linux、macOS、Windows 与 JDK 17 / 21 组成原生矩阵，各环境执行锁文件安装、类型检查、回归测试、本机二进制编译和完整 smoke。最新结果可在 [GitHub Actions](https://github.com/Vanisper/java-run/actions/workflows/check.yaml) 查看。

[Release 工作流](.github/workflows/release.yaml) 提供发布产物演练与标签发布两种入口，使用同一组构建和验收步骤。

### 产物构建与验收

五种产物在对应系统和体系结构的固定原生 runner 上构建：

| 产物 | 编译目标 | 原生 runner |
| --- | --- | --- |
| Windows x64 baseline | `bun-windows-x64-baseline` | `windows-2025` |
| Linux x64 baseline | `bun-linux-x64-baseline` | `ubuntu-24.04` |
| Linux arm64 | `bun-linux-arm64` | `ubuntu-24.04-arm` |
| macOS arm64 | `bun-darwin-arm64` | `macos-15` |
| macOS x64 | `bun-darwin-x64` | `macos-15-intel` |

每个任务使用 `bun run compile` 生成一次待分发的压缩二进制，先在 JDK 21 下执行完整 smoke，再切换到 JDK 17，对同一文件执行 quick 启动验收。验收通过后上传该文件，不重新构建。产物名称保留 x64 的 `baseline` 后缀；平台清单和文件名由 [发布脚本](scripts/release.ts) 统一生成。

汇总步骤要求恰好包含这五种非空普通文件，拒绝缺失、多余或无效产物，然后生成并核对 `SHA256SUMS`。源码 Check 的双 JDK 完整回归与发布文件的 JDK 21 full / JDK 17 quick 范围分别声明，不能将 quick 扩大为完整验收。

### 发布流程演练

分支 push 修改发布或检查工作流、编译 / 发布 / smoke 脚本、对应测试、包与版本配置等路径时，会触发五平台构建、原生验收和校验和汇总。完整路径条件以 Release 工作流的 `paths` 为准。分支演练只保存 Actions artifacts，不创建标签或 GitHub Release；日常 Check 独立运行，Release 不重复调用它。

`workflow_dispatch` 也是纯演练入口，并额外复用完整 Check。工作流进入默认分支后，可通过 Actions 页面或 GitHub CLI 手动选择分支运行。演练使用所选提交的包版本生成文件名，不代表该版本已经发布。

本地可先检查版本和平台清单：

```sh
bun scripts/release.ts metadata
```

### 标签发布与重试

任何 `v*` 标签 push 都进入发布校验，不受分支演练的路径条件限制。包版本必须是合法 SemVer，标签必须严格等于 `v<package.json 版本>`，且仓库需包含非空许可证文件。已经公开的标签版本会被拒绝，不能通过重跑覆盖。

元数据校验通过后，同一标签提交的六组 Check 与五平台产物验收并行执行。只有源码检查、产物验收和汇总全部成功，才创建或恢复该标签的未公开草稿，上传五份文件和校验和。公开前还会核对远端资产集合，缺失或额外文件均令流程失败并保留草稿；文件上传与核对全部成功后自动公开。草稿用于承接上传过程和失败重试，不需要额外人工审批。

SemVer 包含预发布段的版本自动标记为 prerelease，且不会标记为 latest；稳定版的 latest 选择交给 GitHub 默认规则。同一标签的运行串行执行，不中断正在进行的发布。

网络、下载或上传偶发失败时，可以重跑失败任务：

```sh
gh run rerun <run-id> --failed
```

重跑仍使用原始提交和 ref。已验收的 Actions artifacts 支持同名覆盖，Release 资产只在未公开草稿中允许替换。若修改了代码，需要运行新提交的验收；若版本已经公开，需要使用新版本，不能重跑发布来替换文件。

发布准备包括：

- 确定开源许可证并补齐许可证文件
- 为源码接口确定版本号，更新 `package.json` 并核对版本输出
- 完成待发布提交的检查，审查平台产物和支持边界

`bun run version` 使用 bumpp 调整 `package.json`，不自动提交、创建标签或推送。版本变更通过 PR 合入主分支后，再创建与包版本一致的标签并推送该标签，触发自动发布。发布完成后检查 Release 的标签、产物和校验和，并更新安装说明。
