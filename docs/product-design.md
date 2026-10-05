# java-run 产品定位与运行契约

java-run 是框架中立的 Java 源码工作区运行器。它为 Maven 与 Gradle 项目提供统一的开发启动入口，并将构建模型、依赖裁决和增量编译保留在构建工具中。本轮以这个定位完成重构，替代原评估报告中优先特殊化 Spring Boot 的实施建议。

## 用户需要掌握的内容

项目中执行 `java-run` 即启动默认应用。多模块项目在 `.java-run.json` 保存启动目标和参数，随后无需重复输入。没有明确目标或有多个主类时，工具给出选择要求，避免启动整个仓库或凭名称猜测应用。

命令只分为 `run`、`plan`、`help`、`version`。`plan` 读取本地项目配置并预览构建步骤，不执行构建工具，也不生成项目缓存；它明确表示主类和类路径仍待构建工具解析。

常用选项为 `--cwd`、`--module`、`--main`、`--jvm-arg`、`--arg`。高级用户可以选择 `--tool=maven|gradle`、`--build=none`、`--build-arg`、`--include-tests`、`--java` 和 `--build-command`。没有专用 Spring profile 参数，Spring 参数通过正常 JVM 或应用参数传递。

## 自动准备的含义

Maven 单项目自动编译；选定 reactor 模块时，自动 install 该模块和上游依赖，再只解析选定模块的运行类路径。这里的 install 是 Maven 的本地仓库操作，计划和运行提示都会说明，不会发布到远程仓库。当前选择这个保守方案，是为了避免单独解析模块时读取缺失或陈旧的兄弟模块 Jar。

Gradle 将 classes 与项目依赖交给任务图，不先单独编译每个模块，也不做 Maven 式的 install。通过临时 init script 获取选定项目的主 source set 和运行依赖；不改用户的构建脚本。`--build=none` 在两种工具中都表示不主动构建源码，缺失产物直接报错。

不会单独执行测试；`--include-tests` 只准备并加入测试输出和测试依赖。默认使用正常运行时依赖。重新解析依赖由构建工具自身缓存加速，java-run 不维护独立的失效不完整的 classpath 缓存。

## 框架与技术栈

Spring Boot、普通 Java main 和其他基于 classpath 的应用共享启动机制。Gradle 已有 application 的 mainClass 和默认 JVM 参数可以作为元数据；框架专用 run 任务的额外逻辑不自动模拟。如果用户依赖 bootRun 或自定义 JavaExec 的特殊环境、agents、附加资源，应继续使用该原生任务或显式配置，不宣称通用 runner 与所有任务等价。

目前保留 TypeScript / Bun，原因是 CLI、跨平台二进制和进程编排已有可用基础。关键改动在产品契约与构建工具适配，语言切换不能替代这项工作。JPMS、Android、native image、部署与服务守护不属于首版的支持范围。

## 内部模块与验证

CLI 解析配置，构建工具模块生成经过裁决的 PreparedProject，主类模块选择入口，启动模块生成 URL 编码正确的 classpath Jar，执行模块负责退出和信号。Maven 与 Gradle 是真实存在的两种适配器，框架不进入核心配置类型。

验证以同一契约覆盖两种工具：单项目、多模块依赖、无关项目隔离、参数边界、测试隔离、POM 或 Gradle 构建变更、特殊路径、正常和失败退出。用户提供的 java-template 作为 Gradle 实例补充验证，不修改其源仓库。
