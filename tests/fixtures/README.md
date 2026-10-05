# Java 源码启动验证夹具

这些项目用于 [smoke 脚本](../../scripts/smoke.ts) 的原生二进制验收，分别覆盖普通 Java、Spring Boot 依赖和 Gradle 多项目构建。运行方式与测试环境见 [开发指南](../../CONTRIBUTING.md#二进制验收)。

脚本先复制夹具到临时目录，过滤 `target`、`build`、`.gradle` 和 `.cache` 等产物，再执行构建。Maven 使用独立 settings 和本地仓库，Gradle 使用独立用户目录。夹具源码应始终保持可从未构建状态运行。

## 项目与观测点

| 夹具 | 验证内容 |
| --- | --- |
| `boot-single` | Spring Boot 作为普通运行依赖，验证主类发现、正常退出和各层参数 |
| `boot-reactor` | `app` 依赖 `lib`，验证上游库、资源和有效 POM 变化；`other-app` 用于检测无关项目被构建或启动 |
| `plain` | 显式主类、初始化保存与配置复用、测试类路径、配置优先级、依赖变化、Maven 配置根和非零退出 |
| `gradle-reactor` | `application` 主类声明、模块配置保存与复用、`app` 依赖 `lib`、资源与依赖变化、测试类路径和无关项目隔离 |

夹具以 Java 17 为最低版本。Gradle 夹具不携带 Wrapper，CI 安装固定版本 Gradle；本地可使用 `JAVA_RUN_GRADLE_COMMAND` 指定 smoke 的 Gradle 命令。依赖版本在 POM 和 Gradle 构建文件中固定，用于验证实际加载结果。

应用输出 `[fixture]` 标记供脚本断言。Boot 应用禁用 Web，在输出结果后关闭上下文，以正常退出证明启动成功。无关应用若被启动会输出 `FORBIDDEN_OTHER_APP`；脚本同时检查它的构建目录没有生成，避免只依据输出判断目标隔离。

Maven 的 `ci` profile 和 Gradle 的 `-PfixtureProfile=ci` 分别改变资源中的构建 profile 标记。Spring profile 通过普通 JVM 系统属性传入，与构建参数分开验证。测试依赖中的 `commons-lang3` 和测试源码中的标记类分别输出 `test-dependency`、`test-class`；默认值应为 `absent`，启用测试类路径后应为 `present`。

## 完整验收

完整套件在同一临时副本中修改构建声明和资源，随后读取应用真正加载的值，验证下一次运行会重新解析依赖与模型：

- Maven reactor 更新库资源标记，验证目标应用读取更新后的上游库
- `plain` 修改 `commons.io.version`，验证实际依赖版本变化
- Gradle 修改库资源和应用依赖，分别验证资源准备与依赖重新解析
- 启用测试类路径后恢复默认运行，验证测试输出与依赖不会遗留在普通启动中
- `.java-run.json` 的默认值与 CLI 追加或覆盖值，验证配置合并顺序
- Maven 与 Gradle 的 `init` 保存入口和参数后直接运行，验证初始化不启动应用及已有配置保护
- 应用收到 `--exit=7` 后退出，验证运行器保留退出码

`plain` 还会在临时副本中创建 `.mvn/maven.config`，检查项目目录和最近祖先配置根的属性实际参与资源过滤，并验证 `${maven.multiModuleProjectDirectory}` 是指向配置根的绝对路径。这些文件只属于测试副本，不作为夹具默认配置提交。

## 参数与平台编码

临时项目目录包含空格、中文、`#` 和 `%`，所有系统均保留这些路径。脚本检查实际 JDK 的原生命令行编码：能够完整表示 Unicode 参数时验证其往返传递；不能表示时，使用可表示参数完成启动，并追加 JVM 参数与应用参数的拒绝检查，要求明确报错、应用未启动且诊断不泄漏参数值。

验收项目数取决于套件、选定夹具和实际编码能力，以脚本输出为准。交互、信号转发和进程树清理由对应回归测试验证，smoke 主要验证真实构建模型与原生二进制启动。
