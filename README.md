# java-run

java-run 是面向源码工作区的 Java 运行器，为 Maven 和 Gradle 提供统一的开发启动入口：选择一个项目，由构建工具准备源码和运行依赖，再启动独立的 Java 进程。普通 `main`、Spring Boot 和其他基于 classpath 的应用使用同一套契约。定位与边界见 [产品设计](docs/product-design.md)。

**当前文档对应重构分支，尚未发布。** 仓库中的 `0.0.5` 版本号仍是旧版本标识；现有 Release 不代表本分支已经发布。新命令与旧版参数不兼容，迁移方式见下文。

## 快速开始

从源码使用需要 [Bun](https://bun.sh) **1.4.2**，版本固定在 `.bun-version`；运行 Java 项目还需要符合该项目要求的 JDK，以及 Maven / Gradle 或项目 Wrapper。JDK 的 `java` 和 `jar` 必须可用。

在 java-run 仓库中安装锁定依赖并编译本机二进制：

```sh
bun --version
bun install --frozen-lockfile
bun run compile
```

产物为 `dist/java-run`，Windows 使用 `dist/java-run.exe`。把产物放到 PATH 后，在 Java 项目根目录执行：

```sh
java-run
```

编译后的二进制不需要安装 Bun，仍需要 JDK 和目标项目的构建工具。源码调试可以直接使用：

```sh
bun run src/cli.ts --cwd /path/to/java-project
```

默认优先使用项目根目录的 `mvnw` / `mvnw.cmd` 或 `gradlew` / `gradlew.bat`；没有 Wrapper 时使用 PATH 中的构建工具。Wrapper 存在但运行失败时直接报错，不自动换用系统版本。可以用 `--build-command` 显式指定其他可执行文件。

## 命令与启动目标

```sh
java-run [run] [选项] [-- 应用参数...]
java-run plan [选项]
java-run help
java-run version
```

`run` 是默认命令。`plan` 读取本地配置并预览步骤，不调用构建工具、不生成项目缓存、不发起交互；其中主类、有效项目模型和运行类路径仍未验证。`help` / `--help` / `-h` 和 `version` / `--version` 不读取项目配置。

多模块仓库中的聚合项目、库模块和应用模块各有职责，并非每个模块都能执行。用 `--module` 选择一个目标，用 `--main` 在需要时指定入口：

```sh
java-run --module :app
java-run --tool gradle --module :apps:admin-server --main cn.xxb.admin.AdminApplication
java-run plan --module :app
```

Maven 接受单个 reactor 选择器，如 `app`、`:artifactId` 或 `groupId:artifactId`；Gradle 接受项目路径，如 `:apps:admin-server`。不接受多个目标、排除选择器或可选选择器。目录同时存在 Maven 与 Gradle 构建文件时，需要通过 `--tool` 明确选择。

在 stdin 和 stderr 都连接终端的情况下，未指定模块时可以发现候选：Maven 聚合项目列出有效 reactor 中的 `jar` 项目，Gradle 列出启用了 Java 插件的项目。一个候选自动采用，多个候选通过数字选择。候选表示可以进一步检查的 Java 项目，可能仍是库模块，不代表已经确认存在入口。选定目标准备完成后，优先使用显式主类或构建声明；没有声明时查找目标输出中的传统 `public static void main(String[])`，唯一入口直接采用，多个入口可交互选择。

候选发现会执行构建工具配置，可能下载插件、Wrapper 分发包或准备 `buildSrc` 等构建逻辑；不会为了列出候选编译每个候选应用，也不解析它们的运行依赖。非交互环境和 CI 不进行选择，遇到目标或主类歧义时需通过 CLI 或 `.java-run.json` 明确指定。交互只补齐目标和入口，不提供参数向导，也不自动写入配置；Ctrl+C 或 EOF 取消返回 130。

## 参数放在哪一层

| 层次 | 配置方式 | 示例 | 影响 |
| --- | --- | --- | --- |
| 启动目标 | `--cwd`、`--module`、`--main` | `--module=:apps:admin-server` | 决定工作区、选定项目和 Java 入口 |
| 构建 | `--tool`、`--build`、`--build-arg` | `--build-arg=-Pdev` | 传给 Maven / Gradle，影响构建模型、依赖和准备步骤 |
| JVM | `--jvm-arg` | `--jvm-arg=-Xmx1g`、`--jvm-arg=-Dspring.profiles.active=dev` | 传给应用 JVM，影响内存、系统属性和 agents |
| 应用 | `--arg` 或 `--` 后的参数 | `-- --server.port=8081` | 原样传给 `main(String[])`，由应用解释 |
| 环境 | 启动 java-run 的 shell 或 CI 环境 | `JAVA_HOME`、`GRADLE_USER_HOME`、应用环境变量 | 构建工具和 Java 子进程继承环境；没有环境变量向导或自动 `.env` 加载 |

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
| `--cwd <path>` | 当前目录，相对调用时的工作目录解析 |
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

未识别的选项、重复标量和无效值均报错。

## 保存项目默认值

在传给 `--cwd` 的项目根目录保存 `.java-run.json`。例如，`java-template` 可以使用以下配置，随后只执行 `java-run`：

```json
{
  "buildTool": "gradle",
  "module": ":apps:admin-server",
  "mainClass": "cn.xxb.admin.AdminApplication",
  "jvmArgs": [
    "-Xmx1g",
    "-Dspring.profiles.active=dev"
  ],
  "applicationArgs": [
    "--server.port=8081"
  ]
}
```

可用字段为 `buildTool`、`module`、`mainClass`、`jvmArgs`、`applicationArgs`、`buildArgs`、`build`、`includeTests`。配置使用严格 JSON，不支持注释、未知字段、环境变量插值或配置继承。三个参数字段必须是字符串数组，`includeTests` 必须是布尔值。

只读取最终项目根目录中的配置，不向父目录搜索。显式 CLI 标量覆盖文件值，未指定时保留文件值；数组在文件数组之后追加。例如，配置已有 `applicationArgs` 时，`--arg` 不清空原参数。`--cwd`、`--java` 和 `--build-command` 仅通过 CLI 设置。

## 构建与运行行为

默认 `--build=auto` 执行必要准备，并由构建工具负责依赖裁决和增量构建：

| 项目 | 自动准备 |
| --- | --- |
| Maven 单项目 | `compile`；开启 `--include-tests` 时使用 `test-compile` |
| Maven 已选 reactor 模块 | 对目标及上游执行 `install -DskipTests`，然后仅解析选定目标的运行类路径 |
| Gradle Java 项目 | 由任务图执行所需 `classes` / 测试类准备及运行依赖相关任务 |

Maven reactor 的 `install` 会更新**本地 Maven 仓库**，不执行 `deploy`。Maven 生命周期中的测试执行通过 `-DskipTests` 跳过；测试编译可能是 `install` 的一部分，但默认运行类路径仍排除测试输出和测试依赖。`--include-tests` 表示把这些内容加入运行环境，不表示运行测试。

`--build=none` 不主动编译源码，但仍执行模型与运行依赖解析，必要时仍会下载依赖；它要求目标和项目依赖已有可用产物，不能代替 `plan`。缺少产物时直接报错。

java-run 不维护独立的 classpath 缓存。每次由 Maven / Gradle 重新裁决，下载和增量计算复用构建工具自身缓存。适配器的元数据、Gradle init script 和运行 classpath Jar 放在系统临时目录，请求结束后清理；目标项目的 `target` / `build` 和构建工具缓存正常保留。classpath 使用正确编码的文件 URL，支持空格、中文、`#`、`%` 等路径字符。

构建命令在配置的工作区根目录执行，Java 应用的工作目录为选定项目目录。JVM 参数顺序为默认 `-Dfile.encoding=UTF-8`、构建声明的参数、项目配置数组、CLI 追加参数，因此后续同名系统属性可以覆盖默认值。Java 命令优先采用 `--java`，其次采用构建工具提供的工具链，再使用 `JAVA_HOME` 或 PATH。

## 与项目原生运行任务的关系

已有 Gradle `application` 的项目可以直接使用 `run`，Spring Boot Gradle 插件提供 `bootRun`。java-run 的价值是提供跨 Maven / Gradle 的统一入口，而项目原生任务本身已经能完成常见开发启动。[Gradle Application Plugin](https://docs.gradle.org/current/userguide/application_plugin.html)、[Spring Boot Gradle 运行说明](https://docs.spring.io/spring-boot/gradle-plugin/running.html)

例如，在 `java-template` 中也可以直接执行：

```sh
./gradlew :apps:admin-server:bootRun
```

java-run 启动独立 Java 进程，不模拟自定义 `JavaExec` / `bootRun` 的全部副作用，也不会自动搬运任务专用环境变量、agents、附加资源或启动前后逻辑。依赖这些设置的项目应使用原生任务，或把所需运行参数明确配置给 java-run。

## 从旧版迁移

| 旧用法 | 当前用法 |
| --- | --- |
| `start` | 默认执行或使用 `run` |
| `-c` / `compile` | 默认 `--build=auto` 自动准备，不再手动补编译步骤 |
| `main=<class>` | `--main=<class>` 或配置 `mainClass` |
| `active=<profile>` | `--jvm-arg=-Dspring.profiles.active=<profile>` 或应用参数 |
| `local` | 直接给出项目需要的完整 profile 名称 |
| `no-run` / `not-run` | 查看计划使用 `plan`；没有仅执行准备的旧模式 |
| `-r` / 刷新旧缓存 | 没有 java-run 独立缓存；构建工具选项通过 `--build-arg` 传递 |

旧版 `.cache` 中的 classpath 文件和 `cp.jar` 不再读取。

## 支持范围与验证

当前支持 Maven `jar` 项目和启用了 Gradle Java 插件的项目，以及传统 `public static void main(String[])` 的 classpath 启动。主类发现只检查选定项目的已编译输出，不遍历所有依赖 Jar 寻找应用。JPMS、Android、native image、应用守护和热重启、部署不属于当前支持范围。

Windows 的 Java 原生启动器按系统代码页转换命令行参数。classpath 文件 URL 可以保留中文路径，但主类名、JVM / 应用参数和传给构建工具的参数仍需能被该编码完整表示。java-run 会检测 JDK 的 `native.encoding` 并提前拒绝无法表示的参数，避免它们静默变成 `?`。需要传递任意 Unicode 参数时，应按系统要求启用 UTF-8 区域设置；`-Dfile.encoding=UTF-8` 控制应用文件编码，不能替代这项设置。自定义构建入口自行切换 JDK 时，还需核对其实际使用的工具链。[JDK Windows 启动器说明](https://www.oracle.com/java/technologies/javase/21-0-9-relnotes.html)

开发与验证命令：

```sh
bun run check
bun run compile
bun run smoke
```

`check` 执行类型检查和快速测试；`compile` 构建本机独立二进制；`smoke` 使用临时项目副本检验真实 Maven / Gradle 运行，需要 JDK、Maven 和 Gradle，也可能下载依赖。测试和本机验证记录见 [实施计划](docs/implementation-plan.md)，夹具说明见 [tests/fixtures/README.md](tests/fixtures/README.md)，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

开源许可证尚未确定，正式发布前需要补齐许可证与发布检查。本轮重构不创建版本 tag 或发布新版本。
