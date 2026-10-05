# Java 源码启动验证夹具

这些项目仅用于回归验证。测试脚本先复制到临时目录，再运行选定的 Maven 或 Gradle，不在夹具源码目录生成 `target`、`build`、`.gradle` 或缓存。Maven 使用单独的 settings 文件和临时本地仓库，`JAVA_RUN_MAVEN_REPOSITORY` 可指向专用缓存以复用下载；Gradle 使用独立的 `GRADLE_USER_HOME`。

| 夹具 | 验证内容 |
| --- | --- |
| `boot-single` | 以 Spring Boot 3.4.4 为普通依赖，验证主类发现、正常退出、构建和 JVM、应用参数 |
| `boot-reactor` | `app` 依赖 `lib`，从已安装的库资源读取标记和版本；`other-app` 误启动时输出 `FORBIDDEN_OTHER_APP` 并返回 23 |
| `plain` | 显式主类的直接 Java 启动、测试类路径、退出码和依赖更新 |
| `gradle-reactor` | Gradle `application` 主类配置、`app` 对 `lib` 的依赖、资源、测试类路径和无关应用隔离 |

夹具统一以 Java 17 为最低版本。Boot 应用禁用 Web 并在打印 `[fixture]` 标记后关闭上下文，避免通过超时或端口探测推测启动结果。

`ci` Maven profile 将资源中的 `fixture.maven.profile` 改为 `ci`。Gradle 的 `-PfixtureProfile=ci` 对应资源中的 `fixture.gradle.profile`。Spring profile 通过普通 JVM 系统属性传递，验证构建参数与运行参数的边界。测试作用域中的 `commons-lang3` 与 `src/test/java` 中的标记类分别输出 `test-dependency` 和 `test-class`，默认均应为 `absent`，显式包含测试类路径后均应为 `present`。

`plain` 的 `commons.io.version` 默认是 `2.18.0`。测试在临时副本中将其改为 `2.19.0`，随后读取实际加载依赖的实现版本，验证 POM 修改能够影响下一次启动。传入应用参数 `--exit=7` 则打印结果后返回 7。

Gradle 夹具不携带 Wrapper 二进制，CI 固定安装 Gradle `8.14`。本机 smoke 使用 PATH 中的 Gradle，`JAVA_RUN_GRADLE_COMMAND` 可覆盖命令；临时 `GRADLE_USER_HOME` 与个人 Gradle 初始化脚本隔离，`JAVA_RUN_GRADLE_HOME` 可指向专用缓存。
