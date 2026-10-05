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
| `bun run compile` | 构建本机二进制到 `dist` |
| `bun run smoke` | 使用该二进制运行真实 Maven / Gradle 夹具 |

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

[Release 工作流](.github/workflows/release.yaml) 由 `v*` tag 触发，在同一标签提交上先执行 Check，再交叉编译以下产物：

| 产物 | 编译目标 |
| --- | --- |
| Windows x64 baseline | `bun-windows-x64-baseline` |
| Linux x64 baseline | `bun-linux-x64-baseline` |
| Linux arm64 | `bun-linux-arm64` |
| macOS arm64 | `bun-darwin-arm64` |
| macOS x64 | `bun-darwin-x64` |

工作流汇总产物后生成并核对 `SHA256SUMS`，发布到触发事件对应的标签。交叉编译证明产物可以构建；原生矩阵证明相应运行环境可以执行，二者不能替代。矩阵没有逐一覆盖五种产物架构。

发布准备包括：

- 确定开源许可证并补齐许可证文件
- 为源码接口确定版本号，更新 `package.json` 并核对版本输出
- 说明相对已发布接口的不兼容变化与迁移方法
- 完成待发布提交的检查，审查平台产物和支持边界

`package.json` 的 `0.0.5` 尚未表达当前源码接口的版本变更。发布时应确保 `v<版本>` 标签与包版本一致，再推送标签触发工作流；`bun run version` 提供 bumpp 版本调整入口。发布完成后检查 Release 的标签、产物和校验和，并更新安装说明。
