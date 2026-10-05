# 参与 java-run 开发

产品契约以 [产品设计](docs/product-design.md) 为准，实施状态记录在 [实施计划](docs/implementation-plan.md)。java-run 的核心职责是为源码工作区解析一个启动目标，并交给 Maven / Gradle 准备后启动 Java；框架特殊逻辑应留在项目和构建工具中。

## 环境与日常检查

使用 `.bun-version` 固定的 Bun **1.4.2** 和锁文件，不用个人全局依赖替代项目依赖。真实项目验证需要 JDK、Maven 和 Gradle；当前 CI 使用 JDK 17 / 21、Gradle 8.14，目标项目自己的 Wrapper 与工具链优先。

```sh
bun install --frozen-lockfile
bun run check
bun run compile
bun run smoke
```

`check` 包含类型检查和快速回归。`compile` 构建本机二进制，smoke 随后运行这个产物，并从子进程 PATH 中移除 Bun 所在目录，检验二进制能独立运行。只交叉编译成功不足以说明目标系统能够运行。

smoke 默认运行完整夹具集，也可以缩小范围：

```sh
bun run smoke --suite=quick
bun run smoke --fixture=gradle-reactor
bun run smoke --cli=/path/to/java-run --suite=full --keep
```

成功后默认清理临时目录，失败或 `--keep` 时保留项目副本及 stdout / stderr 日志。默认在临时目录中建立隔离的 Maven 仓库、settings 和 Gradle 用户目录，不写入个人依赖仓库或初始化脚本目录。

需要复用下载时使用**专用测试缓存**，不要指向个人 `~/.m2` 或 `~/.gradle`：

```sh
JAVA_RUN_MAVEN_REPOSITORY=/tmp/java-run-test-maven \
JAVA_RUN_GRADLE_HOME=/tmp/java-run-test-gradle \
JAVA_RUN_GRADLE_COMMAND=/path/to/gradle \
bun run smoke
```

其他脚本选项可使用 `JAVA_RUN_SMOKE_SUITE`、`JAVA_RUN_SMOKE_FIXTURE`、`JAVA_RUN_SMOKE_KEEP=1` 配置。变量名应与任务或测试域相关，不覆盖 `HOME`、`CODEX_HOME` 等系统变量。

## 分支与提交

从主分支创建具有单一意图的工作分支，如 `feat/gradle-project-selection` 或 `fix/process-exit-code`。本轮完整重构使用 `feat/open-source-cli`，保留主分支作为旧实现基线。修改前检查工作区，避免覆盖他人的未提交内容；并行工作采用隔离分支或 worktree。

提交遵循 Conventional Commits：type 与 scope 使用英文，subject 使用中文，例如：

```text
feat(cli): 支持缺失主类的终端选择
fix(maven): 保留选定项目的运行依赖范围
test(gradle): 验证无关应用不参与编译
docs: 说明参数分层与旧版本迁移
```

提交按可审查的意图拆分，避免把无关重构、生成产物和依赖缓存混入同一个提交。提交前检查差异并运行相关验证；PR 说明应写清触发场景、最终行为、实际测试结果和未验证的平台。

未经明确发布安排，不生成 tag 或推送版本发布。当前重构尚未发布，旧 `0.0.5` Release 不能作为本分支新契约的安装依据。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| CLI / 配置 | 验证调用契约，合并根目录 `.java-run.json`，处理命令入口 |
| Maven / Gradle 适配器 | 使用真实构建模型，裁决单个目标、源码准备、运行依赖和工具链 |
| 主类发现 / 交互 | 检查目标输出中的 main 方法，仅在终端中补充缺失选择 |
| classpath / 启动 | 编码文件 URL、生成临时 classpath Jar、构造 Java 参数 |
| 进程执行 | 保持参数边界、输出、退出码与信号，清理子进程 |

新增适配能力时保持 `PreparedProject` 的公共契约，不把框架 profile、应用环境或自定义运行任务写入核心配置。候选模块来自构建模型，候选不等于已经确认有入口；不要先编译所有模块来寻找可运行应用。

源码注释和 API 文档使用中文，说明契约、边界和原因，避免复述代码。Markdown 正文按文章语境使用中文标点；同组列表保持语法与标点统一。public API 的说明下沉到所属接口、字段或方法，避免跨层重复维护。

## 测试要求

对行为修改选择能够验证调用者结果的测试，不堆叠复述实现的断言。适配器修改应有真实项目 smoke 证据，不能只用假 Maven / Gradle 输出宣称兼容。

回归重点包括：

- Maven / Gradle 单项目与多模块目标、上游依赖和无关项目隔离
- 默认自动准备与 `--build=none`，模型或依赖变化后的重新解析
- 主类声明、唯一入口、多个入口、无入口和终端取消
- JVM / 应用 / 构建参数边界，空格、中文、`#`、`%` 等字符
- 默认测试隔离、显式测试类路径和资源变化
- 正常与非零退出，Ctrl+C / SIGTERM 转发和子进程清理
- 帮助、版本与静态 plan 不调用构建工具、不创建项目缓存

始终将夹具复制到临时目录后运行。不要在 `tests/fixtures` 下生成 `target`、`build`、`.gradle` 或 `.cache`，也不要修改用户提供的源仓库。临时目录应在成功时清理，失败时留下可追溯日志。

交互测试需要验证 EOF / Ctrl+C 不挂起、取消返回 130，以及非 TTY 不提示。环境和信号测试应使用隔离子进程，避免污染同一测试进程中的其他用例。

## CI 与 Release

[Check 工作流](.github/workflows/check.yaml) 在 Linux、macOS、Windows 与 JDK 17 / 21 的矩阵中执行锁文件安装、类型检查、测试、本机二进制编译和完整 smoke。它验证的是运行器实际运行的原生环境；本地未执行过的平台应留待 CI 证明。

[Release 工作流](.github/workflows/release.yaml) 由 `v*` tag 触发，先通过 Check，再构建五类产物：

| 产物 | 编译目标 |
| --- | --- |
| Windows x64 baseline | `bun-windows-x64-baseline` |
| Linux x64 baseline | `bun-linux-x64-baseline` |
| Linux arm64 | `bun-linux-arm64` |
| macOS arm64 | `bun-darwin-arm64` |
| macOS x64 | `bun-darwin-x64` |

工作流汇总产物后生成并核对 `SHA256SUMS`，发布到触发事件对应的 tag，不用“最近一个 tag”替代事件版本。五种产物的交叉编译与三类系统的原生 smoke 是不同证据，不应混称全部架构都已原生验证。

正式发布前需要确定并补齐开源许可证，明确不兼容迁移对应的版本与发布说明，确认上述检查、平台产物和校验和完整。当前阶段不创建发布 tag。
