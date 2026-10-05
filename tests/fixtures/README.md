# Java 源码启动验证夹具

这些项目用于 [smoke 脚本](../../scripts/smoke.ts) 的原生二进制验收，覆盖普通 Java、Spring Boot 依赖和 Gradle 多项目构建。
运行方式与测试环境见 [开发指南](../../CONTRIBUTING.md#二进制验收)。

脚本先复制夹具到临时目录，过滤 `target`、`build`、`.gradle` 和 `.cache` 等产物，再执行构建。
Maven 使用独立 settings 和本地仓库，Gradle 使用独立用户目录。
夹具源码应始终保持可从未构建状态运行。

## 项目与观测点

| 夹具 | 验证内容 |
| --- | --- |
| `boot-single` | Spring Boot 运行依赖、主类发现、正常退出和各层参数 |
| `boot-reactor` | `app` 依赖 `lib`、上游库与资源更新、有效 POM 变化、无关项目隔离 |
| `plain` | 显式主类、初始化与配置复用、测试类路径、参数优先级、依赖变化、Maven 配置根和非零退出 |
| `gradle-reactor` | `application` 主类声明、模块配置复用、上游库、资源与依赖变化、测试类路径和无关项目隔离 |

夹具以 Java 17 为最低版本，依赖版本在 POM 和 Gradle 构建文件中固定。
Gradle 夹具不携带 Wrapper，CI 安装固定版本 Gradle；本地可通过 `JAVA_RUN_GRADLE_COMMAND` 指定 smoke 使用的命令。

应用输出 `[fixture]` 标记供脚本断言：

| 观测点 | 判断依据 |
| --- | --- |
| Boot 启动 | 禁用 Web，输出标记后关闭上下文并正常退出 |
| 无关项目隔离 | `other-app` 没有生成构建目录，输出中没有 `FORBIDDEN_OTHER_APP` |
| 构建参数 | Maven 的 `ci` profile 或 Gradle 的 `-PfixtureProfile=ci` 改变资源中的 profile 标记 |
| JVM 参数 | Spring profile 通过 JVM 系统属性传入，与构建参数分别验证 |
| 测试类路径 | `test-dependency` 和 `test-class` 默认均为 `absent`，启用后均为 `present` |

测试依赖标记来自 `commons-lang3`，测试类标记来自各项目的测试源码。
资源和依赖版本均由应用读取实际加载结果，作为模型解析与类路径组装的验证依据。

## 验收范围

quick 套件验证帮助、版本、静态预览和基本启动，并覆盖 Maven / Gradle 的初始化与配置复用。
`init` 用例检查保存的入口和参数、初始化期间不启动应用，以及已有配置的覆盖保护。

full 套件还会在同一临时副本中修改构建声明与资源，再运行应用验证更新结果：

- Maven reactor 更新库资源标记，目标应用读取更新后的上游库
- `plain` 修改 `commons.io.version`，实际加载的依赖版本随之变化
- Gradle 修改库资源和应用依赖，分别验证资源准备与依赖重新解析
- 启用测试类路径后恢复默认运行，测试输出与依赖不进入普通启动
- 在 `.java-run.json` 默认值上追加或覆盖 CLI 参数，验证合并顺序
- 应用收到 `--exit=7` 后退出，运行器保留退出码

`plain` 在临时副本中创建 `.mvn/maven.config`，验证配置根的两个位置：

- 项目目录中的配置
- 最近祖先目录中的配置

两种情况均检查属性参与资源过滤，并确认 `${maven.multiModuleProjectDirectory}` 是指向配置根的绝对路径。
这些配置文件由脚本生成，夹具源码保持独立。

## 参数与平台编码

临时项目目录包含空格、中文、`#` 和 `%`，所有系统均保留这些路径。
脚本根据实际 JDK 的原生命令行编码选择参数断言：

- 能够完整表示 Unicode 参数时，验证参数往返传递
- 无法完整表示时，使用可表示参数完成启动，并检查 JVM 参数和应用参数的拒绝行为

拒绝用例要求明确报错、应用未启动，且诊断不泄漏参数值。
验收项数取决于套件、选定夹具和实际编码能力，以脚本输出为准。

smoke 验证真实构建模型与原生二进制启动。
交互、信号转发和进程树清理由对应回归测试验证。
