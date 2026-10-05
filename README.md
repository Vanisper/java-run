# java-run

java-run 为 Maven 和 Gradle 源码工作区提供统一的开发启动入口：选择一个 Java 项目，由构建工具准备源码和运行依赖，再启动独立的 Java 进程。普通 Java、Spring Boot 和其他基于 classpath 的应用使用同一套运行契约。

## 快速开始

从 [GitHub Releases](https://github.com/Vanisper/java-run/releases) 下载对应系统和体系结构的 ZIP。预编译版本不需要 Bun；运行 Java 项目仍需要符合该项目要求的 JDK，以及 Maven / Gradle 或项目 Wrapper。JDK 的 `java` 和 `jar` 必须可用。

| 系统与体系结构 | 最新稳定版下载 |
| --- | --- |
| Windows x64 | [java-run-windows-x64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-windows-x64.zip) |
| Linux x64 | [java-run-linux-x64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-linux-x64.zip) |
| Linux arm64 | [java-run-linux-arm64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-linux-arm64.zip) |
| macOS arm64（Apple Silicon） | [java-run-darwin-arm64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-darwin-arm64.zip) |
| macOS x64（Intel） | [java-run-darwin-x64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-darwin-x64.zip) |

macOS / Linux 使用 `uname -m` 查看体系结构：`x86_64` 对应 x64，`arm64` / `aarch64` 对应 arm64。Windows 可在“设置 → 系统 → 关于”查看系统类型，当前提供 x64 版本。Linux 产物在 Ubuntu 24.04 的 glibc 环境验收；musl（如 Alpine）和其他系统版本未纳入发布验收。

按照 [安装指南](docs/installation.md) 核对 ZIP 和包内二进制的 SHA-256，再将可执行文件加入 PATH；ZIP 内附有二进制校验文件和独立的 `INSTALL.md`。随后在 Java 工作区根目录执行：

```sh
java-run
```

### 从源码构建

源码构建需要 [Bun](https://bun.sh) **1.4.2**，版本固定在 `.bun-version`。

在 java-run 仓库中安装锁定依赖并编译本机二进制：

```sh
bun --version
bun install --frozen-lockfile
bun run compile
```

产物为 `dist/java-run` 和 `dist/java-run.sha256`；Windows 使用 `dist/java-run.exe` 和 `dist/java-run.exe.sha256`。校验文件记录二进制的 SHA-256，可按[安装指南](docs/installation.md)中的二进制校验命令在 `dist` 目录核对。将可执行文件放入 PATH 后即可使用上述命令。源码调试可以直接使用：

```sh
bun run src/cli.ts --cwd /path/to/java-project
```

默认优先使用项目根目录的 `mvnw` / `mvnw.cmd` 或 `gradlew` / `gradlew.bat`；没有 Wrapper 时使用 PATH 中的构建工具。Wrapper 存在但运行失败时直接报错，不自动换用系统版本。可以用 `--build-command` 显式指定其他可执行文件。

## 命令与启动目标

```sh
java-run [run] [选项] [-- 应用参数...]
java-run init [选项] [-- 应用参数...]
java-run plan [选项]
java-run help
java-run version
```

`run` 是默认命令。`init` 准备并选择启动目标，将结果保存为项目配置，随后执行 `java-run` 即可复用。`plan` 读取本地配置并预览步骤，不调用构建工具、不生成项目缓存、不发起交互；其中主类、有效项目模型和运行类路径仍未验证。`help` / `--help` / `-h` 和 `version` / `--version` 不读取项目配置。

多模块仓库中的聚合项目、库模块和应用模块各有职责，并非每个模块都能执行。用 `--module` 选择一个目标，用 `--main` 在需要时指定入口：

```sh
java-run --module :app
java-run --tool gradle --module :app --main com.example.Application
java-run plan --module :app
```

Maven 接受单个 reactor 选择器，如 `app`、`:artifactId` 或 `groupId:artifactId`；Gradle 接受项目路径，如 `:app` 或 `:apps:server`。不接受多个目标、排除选择器或可选选择器。目录同时存在 Maven 与 Gradle 构建文件时，需要通过 `--tool` 明确选择。

当 stdin 和 stderr 都连接终端时，缺少目标或入口的信息可以通过交互补齐：

- Maven 聚合项目列出有效 reactor 中的 `jar` 项目，Gradle 列出启用了 Java 插件的项目；一个候选自动采用，多个候选通过数字选择
- 候选可能是库模块，入口需要在选定目标准备完成后确认
- 主类优先采用 `--main` / 配置值，其次采用构建声明；没有声明时查找目标输出中的传统 `public static void main(String[])`，唯一入口直接采用，多个入口通过数字选择

候选发现会执行构建工具配置，可能下载插件、Wrapper 分发包或准备 `buildSrc` 等构建逻辑。候选应用的编译和运行依赖解析在选定目标后执行。非交互环境和 CI 遇到目标或主类歧义时，需要通过 CLI 或 `.java-run.json` 明确指定。

交互只选择目标和入口，运行参数通过选项或配置传入。普通运行中的选择仅用于本次启动；需要保存时使用 `init`。Ctrl+C 或 EOF 取消返回 130。

### 多入口选择示例

[双入口示例项目](examples/multiple-main/README.md)包含 `HelloApplication` 和 `ReportApplication` 两个主类，未配置默认入口。将 java-run 放入 PATH 后，在本仓库根目录执行：

```sh
java-run --cwd examples/multiple-main -- --name=demo
```

准备完成后，终端会显示：

```text
选择启动主类
  1. com.example.HelloApplication
  2. com.example.ReportApplication
选择 [1-2]：
```

输入 `2` 并回车，启动 `ReportApplication`，`--name=demo` 传给它的 `main(String[])`。此例只有一个 Maven 项目，菜单选择的是项目中的入口。

脚本和 CI 可以直接指定主类：

```sh
java-run --cwd examples/multiple-main \
  --main com.example.ReportApplication \
  -- --name=demo
```

显式主类、配置中的 `mainClass` 或构建声明已经确定入口时，直接启动该入口，不显示主类菜单。

## 参数放在哪一层

| 层次 | 配置方式 | 示例 | 影响 |
| --- | --- | --- | --- |
| 启动目标 | `--cwd`、`--module`、`--main` | `--module=:app` | 决定工作区、选定项目和 Java 入口 |
| 构建 | `--tool`、`--build`、`--build-arg` | `--build-arg=-Pdev` | 传给 Maven / Gradle，影响构建模型、依赖和准备步骤 |
| JVM | `--jvm-arg` | `--jvm-arg=-Xmx1g`、`--jvm-arg=-Dspring.profiles.active=dev` | 传给应用 JVM，影响内存、系统属性和 agents |
| 应用 | `--arg` 或 `--` 后的参数 | `-- --server.port=8081` | 原样传给 `main(String[])`，由应用解释 |
| 环境 | 启动 java-run 的 shell 或 CI 环境 | `JAVA_HOME`、`GRADLE_USER_HOME`、应用环境变量 | 构建工具和 Java 子进程继承环境；`.env` 需由 shell 或其他工具加载 |

Maven `-Pdev` 激活的是 **Maven profile**，与 Spring profile 分属不同层。java-run 没有 Spring 专用参数；Spring profile 使用正常 JVM 属性或应用参数传递。

三个参数数组都支持重复。负号开头的值使用等号形式，值中的后续等号、空格和 shell 字符会保留；含空格的整个参数仍需按当前 shell 的规则引用：

```sh
java-run --module :app \
  --build-arg=-Pdevelopment \
  --jvm-arg=-Xmx1g \
  --jvm-arg=-Dspring.profiles.active=dev \
  --arg="--message=hello world" \
  -- --server.port=8081
```

`--` 后的内容全部属于应用，不再解释为 java-run 选项。构建参数由适配器校验；不能借它改写启动目标、注入额外任务或覆盖内部元数据输出步骤。

完整选项：

| 选项 | 默认值或行为 |
| --- | --- |
| `--cwd <path>` | 工作区根目录；默认为当前目录，相对调用时的工作目录解析 |
| `--tool <auto\|maven\|gradle>` | `auto`，根据根目录构建文件选择 |
| `--module <selector>` | 单个目标；缺失时按根项目和交互条件处理 |
| `--main <class>` | 构建声明或目标输出中的唯一传统 main |
| `--jvm-arg=<value>` | 追加一个 JVM 参数，可重复 |
| `--arg=<value>` | 追加一个应用参数，可重复 |
| `--build-arg=<value>` | 追加一个构建工具参数，可重复 |
| `--build <auto\|none>` | `auto` |
| `--include-tests` | 准备并加入测试输出和依赖，默认关闭 |
| `--java <command>` | 显式覆盖 Java 可执行文件 |
| `--build-command <command>` | 显式覆盖构建工具可执行文件 |
| `--force` | 仅用于 `init`，忽略已有配置并重新生成 |

未识别的选项、重复标量和无效值均报错。

## 保存项目默认值

在 Java 工作区中执行 `init`，准备项目并选择要保存的模块和主类：

```sh
java-run init
java-run
```

`init` 在 `--cwd` 指定的工作区根目录生成 `.java-run.json`。它复用运行时的构建工具检测、模块选择、产物准备和入口确定流程，但不启动应用。准备可能编译源码、下载依赖、更新构建工具缓存或执行项目构建配置；Maven reactor 的自动准备仍会写入本地 Maven 仓库。只有一个候选时自动采用，多个模块或入口在终端中通过数字选择；非交互环境存在歧义时，使用 `--module` / `--main` 明确指定。

运行参数通过同一组选项一起保存，无需逐项回答参数问题。例如，初始化 Maven 工作区中的 `app` 模块并保存内存和应用参数：

```sh
java-run init --module app --jvm-arg=-Xmx1g -- --server.port=8081
java-run
```

生成的配置记录实际使用的构建工具、选定模块和主类、本次显式提供的三类参数，以及非默认的 `--build` / `--include-tests` 设置。`--cwd`、`--java` 和 `--build-command` 只用于本次定位或准备，不保存到配置。

已有 `.java-run.json` 时，`init` 在运行构建工具前报错并保留原文件。需要重新配置时使用 `java-run init --force`；它忽略旧配置、按本次选项重新生成，因此也可替换格式损坏的配置。取消或准备失败时不写入配置。

配置也可以直接编辑。例如：

```json
{
  "buildTool": "gradle",
  "module": ":app",
  "mainClass": "com.example.Application",
  "jvmArgs": [
    "-Xmx1g",
    "-Dspring.profiles.active=dev"
  ],
  "applicationArgs": [
    "--server.port=8081"
  ]
}
```

可用字段为 `buildTool`、`module`、`mainClass`、`jvmArgs`、`applicationArgs`、`buildArgs`、`build`、`includeTests`。配置使用严格 JSON，不支持注释、未知字段、环境变量插值或配置继承。三个参数字段必须是字符串数组；`jvmArgs` 和 `buildArgs` 的元素不能是空字符串或纯空白字符串，`applicationArgs` 原样保留空字符串和空白参数，与 `--` 透传一致。`includeTests` 必须是布尔值。

只读取该工作区根目录的配置，不向父目录搜索，也不在选定模块后重新读取。显式 CLI 标量覆盖文件值，未指定时保留文件值；数组在文件数组之后追加。例如，配置已有 `applicationArgs` 时，`--arg` 会追加参数。`--cwd`、`--java` 和 `--build-command` 仅通过 CLI 设置。

## 构建与运行行为

默认 `--build=auto` 执行必要准备，并由构建工具负责依赖裁决和增量构建：

| 项目 | 自动准备 |
| --- | --- |
| Maven 单项目 | `compile`；开启 `--include-tests` 时使用 `test-compile` |
| Maven 已选 reactor 模块 | 对目标及上游执行 `install -DskipTests`，然后仅解析选定目标的运行类路径 |
| Gradle Java 项目 | 由任务图执行所需 `classes` / 测试类准备及运行依赖相关任务 |

Maven reactor 的 `install` 会更新**本地 Maven 仓库**，不执行 `deploy`。Maven 生命周期中的测试执行通过 `-DskipTests` 跳过；测试编译可能是 `install` 的一部分，但默认运行类路径仍排除测试输出和测试依赖。`--include-tests` 表示把这些内容加入运行环境，不表示运行测试。

`--build=none` 不主动编译源码，但仍执行模型与运行依赖解析，必要时仍会下载依赖；它要求目标和项目依赖已有可用产物，不能代替 `plan`。缺少产物时直接报错。

每次启动的运行类路径由 Maven / Gradle 裁决，下载和增量计算复用构建工具自身缓存。java-run 的请求文件和 classpath Jar 放在系统临时目录，请求结束后清理；目标项目的 `target` / `build` 和构建工具缓存正常保留。classpath 支持空格、中文、`#`、`%` 等路径字符。

构建命令在配置的工作区根目录执行，Java 应用的工作目录为选定项目目录。JVM 参数顺序为默认 `-Dfile.encoding=UTF-8`、构建声明的参数、项目配置数组、CLI 追加参数，因此后续同名系统属性可以覆盖默认值。

Java 命令优先采用 `--java`，其次采用 Gradle 提供的项目工具链，再使用 `JAVA_HOME` 或 PATH。Maven 应用启动暂不读取 Maven toolchains 配置，需要不同 JDK 时使用 `--java` 显式指定。

## 与项目原生运行任务的关系

已有 Gradle `application` 的项目可以直接使用 `run`，Spring Boot Gradle 插件提供 `bootRun`。java-run 的价值是提供跨 Maven / Gradle 的统一入口，而项目原生任务本身已经能完成常见开发启动。[Gradle Application Plugin](https://docs.gradle.org/current/userguide/application_plugin.html)、[Spring Boot Gradle 运行说明](https://docs.spring.io/spring-boot/gradle-plugin/running.html)

例如，Gradle 应用模块可以使用对应的原生任务：

```sh
./gradlew :app:run
./gradlew :app:bootRun
```

java-run 启动独立 Java 进程，不模拟自定义 `JavaExec` / `bootRun` 的全部副作用，也不会自动搬运任务专用环境变量、agents、附加资源或启动前后逻辑。依赖这些设置的项目应使用原生任务，或把所需运行参数明确配置给 java-run。

## 支持范围与验证

当前支持 Maven `jar` 项目和启用了 Gradle Java 插件的项目，以及传统 `public static void main(String[])` 的 classpath 启动。主类发现只检查选定项目的已编译输出，不遍历所有依赖 Jar 寻找应用。JPMS、Android、native image、应用守护和热重启、部署不属于当前支持范围。

Windows 的 Java 原生启动器按系统代码页转换命令行参数。classpath 文件 URL 可以保留中文路径，但主类名、JVM / 应用参数和传给构建工具的参数仍需能被该编码完整表示。java-run 会检测 JDK 的 `native.encoding` 并提前拒绝无法表示的参数，避免它们静默变成 `?`。需要传递任意 Unicode 参数时，应按系统要求启用 UTF-8 区域设置；`-Dfile.encoding=UTF-8` 控制应用文件编码，不能替代这项设置。自定义构建入口自行切换 JDK 时，还需核对其实际使用的工具链。[JDK Windows 启动器说明](https://www.oracle.com/java/technologies/javase/21-0-9-relnotes.html)

Windows 上的 Maven 配置根超出系统代码页时，需要 Maven **3.9.2 或更新版本**。java-run 会检查这一条件，保留 `.mvn` 配置和 POM 中项目根目录属性的绝对路径语义；版本不满足时明确报错。[Maven 3.9.2 命令行属性插值](https://maven.apache.org/docs/3.9.2/release-notes.html)

类型检查、快速测试和原生运行验收通过 `bun run check`、`bun run compile`、`bun run smoke` 执行。具体环境要求、CI 和发布流程见[参与开发](CONTRIBUTING.md)。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [安装指南](docs/installation.md) | 平台选择、下载安装、校验和升级 |
| [架构设计](docs/architecture.md) | 产品边界、模块职责、构建适配与跨平台运行契约 |
| [技术路线](docs/roadmap.md) | 已有工程能力、支持缺口和后续工作的验收条件 |
| [参与开发](CONTRIBUTING.md) | 本地开发、验证、分支协作与发布流程 |
| [验收夹具](tests/fixtures/README.md) | 真实项目场景、隔离方式和验证覆盖 |
