# java-run 重构实施计划

本轮在 `feat/open-source-cli` 分支完成框架中立的 Java 源码工作区运行器，定位与契约以 [产品设计](product-design.md) 为准。原评估报告保留为旧实现的证据基线，其中优先特殊化 Spring Boot 的路线已经被本设计替代。

## 工作包与提交边界

1. 确定产品定位、自动准备行为和 Maven / Gradle 的职责
2. 实现严格的配置解析、统一进程执行、主类选择和 Java 启动
3. 完成 Maven 与 Gradle 两种构建工具适配，让工具自身裁决依赖和输出目录
4. 添加真实项目夹具、二进制 smoke、原生系统 CI 和可靠 Release
5. 完成用户文档与实际验证记录，形成可审查的分支提交

移除旧 `start`、`-c`、`active=`、`local`、`no-run` 等参数，避免继续维护源于旧脚本的操作模型。默认运行自动准备源码；`--build=none` 是明确的高级覆盖，`plan` 则仅作静态预览。

本轮不生成版本 tag，分支内按清晰意图提交；版本发布由检查通过后的 tag 工作流完成。保留原主分支作为重构前的基线。

## 验收要求

- Maven / Gradle 共用运行契约，Spring 等框架通过普通参数配置
- 正常与非零退出可追溯，POSIX 信号不遗留应用子进程
- 帮助、版本和 plan 不触发构建工具或创建项目缓存
- 多模块只解析选定应用；依赖准备由对应构建工具执行
- 唯一 main 可以发现，多个主类明确要求选择
- 测试输出、测试依赖、特殊路径、依赖与资源变更均有验证
- 原生操作系统 CI 运行本机二进制；本地未运行的系统不宣称已经验证
- 用户 java-template 在隔离副本补充验证，不修改原仓库

## 实施结果

2026-10-05 已完成运行契约与核心重构、两种构建适配器、配置与交互、真实项目夹具、原生 CI 和发布门禁、README 及迁移说明。源码按职责组织为 `cli`、`build-tools`、`core`、`process`，根目录保留 CLI 入口。旧入口、静态叶子模块并集和独立 classpath 缓存已经移除。

本轮本地环境为 macOS ARM64、Bun 1.4.2、Maven 3.9.16、Corretto JDK 21。Windows 专用用例在本地跳过，不能把已配置 CI 当成远端已经通过。

| 检查 | 实际结果 |
| --- | --- |
| 锁文件安装与严格类型检查 | 通过 |
| 核心回归 | 85 项通过、2 项 Windows 专用测试跳过，无失败 |
| Gradle 适配 | 8.14 / Java 21 与 9.7 / Java 26 的真实项目验证通过；buildSrc 与 included build 回归均通过 |
| 独立二进制完整 smoke | 同一次 20 项全部通过，82.2 秒；使用 JDK 21、Gradle 8.14 和独立测试缓存 |
| 目录整理后的二进制复验 | 重新类型检查、编译，7 项 quick smoke 全部通过 |
| 原生终端交互 | Maven 与 Gradle 实际列出模型候选，选择目标后正常运行；Maven 目标存在多个 main 时，选择另一入口并成功运行 |
| 用户 java-template | 隔离副本成功启动 AdminApplication，SIGTERM 返回 143，并执行应用关闭钩子 |

完整 smoke 覆盖 Maven 单项目和 reactor、普通 main 与 Boot main、测试作用域隔离、资源与依赖变更、配置默认值与 CLI 合并、非零退出和 Gradle 项目依赖。候选发现验证了不读取可能触发任务依赖的主类 Provider，也不编译无关应用。主类与 Manifest 使用真实 JDK 验证，包括空依赖、特殊路径和 Unicode 标识符。

`java-template` 固定在提交 `f7e463d85e3e527fae974130fb12939523c40ac4` 的归档副本，使用其 Gradle 8.14 Wrapper / Java 21 toolchain，目标为 `:apps:admin-server`，入口为 `cn.xxb.admin.AdminApplication`。验证用随机 Web 端口、H2 内存库和 create-drop，避免读写原仓库的数据文件；启动耗时约 214 秒，应用自身报告启动约 3.4 秒，其余主要为首次构建准备。应用启动后发送 SIGTERM，确认 JVM、Wrapper 与一次性 Gradle daemon 均已结束，原仓库保持干净。本次仅确认应用启动及关闭，不代替业务接口验收。

独立审查额外确认了无依赖 Maven 项目可以正常运行，并发现原主类正则拒绝组合字符标识符的问题；已统一校验器并用 javac / java 回归。实际模板验证发现 Gradle init script 会进入 buildSrc，已用主构建规范路径限定修复，并用约定插件及复合构建验证。

## 分支与发布边界

全部工作留在 `feat/open-source-cli`，`master` 保留原代码基线。提交分别记录评估、产品定位、核心重构、验收与发布流程、用户文档；本次没有推送、合并主分支、创建 tag 或发布版本。

核心实现提交为 `95f1b5f`，验收与 CI 提交为 `3005f8c`。评估与初始定位分别记录在 `4ba5822`、`40e87cf`，最终文档以本记录及 README 为准。

包版本仍为旧 `0.0.5`，README 明确当前契约尚未发布。下一步正式发布前需确定开源许可证与版本号，实际运行三种原生系统的 CI，并据结果确认支持矩阵。性能、命名运行配置和新增运行模式按 [后续技术路线](product-design.md#后续技术路线) 推进，不以未运行的计划代替验证。

## 首轮 CI 反馈与修复

用户推送后的 [首轮 Check](https://github.com/Vanisper/java-run/actions/runs/37256647164) 对应 `2ad210c`。Linux / JDK 17、21 与 macOS / JDK 21 完成全部验收；macOS / JDK 17 的 Unicode 测试及两组 Windows 回归失败。

macOS 的问题发生在测试源文件名：JDK 17 将文件路径转为 NFC，而 public 类使用 NFD。改用 ASCII 源文件名承载原有 NFD 类，保留主类发现和实际启动断言，JDK 17、21 都通过。

Windows 原生 JDK 将系统代码页无法表示的参数替换为 `?`。修复包括 Gradle 通过临时脚本中的 UTF-8 请求读取目录和模块、使用 ASCII 根代理任务，Java / Jar 使用相对受控路径，以及执行前按真实 JDK 编码检查用户参数。中文 classpath 目录继续保留，无法表示的原始参数以明确错误结束。Maven 有效模型的输出路径统一归一化，依赖元数据输出固定 UTF-8。另增加实际 Windows 批处理进程树清理用例。

修复后本地全量回归 91 项通过、3 项 Windows 专用测试跳过；新增 Maven 编码保护后专项 17 项通过。Gradle 8.14 在 JDK 17、21 下各 21 项验证通过，完整独立二进制 smoke 20 项全部通过。后续原生结果以 [分支 Check 运行](https://github.com/Vanisper/java-run/actions/workflows/check.yaml?query=branch%3Afeat%2Fopen-source-cli) 为准，不将本机结果替代 Windows 验收。

第二轮 Linux、macOS 的 JDK 17 / 21 均通过。Windows 暴露了目录短名与长名的等价性，以及 JDK 17 控制台丢失中文诊断的问题。目录断言改为验证实际文件系统身份；Gradle 的受控错误通过 ASCII 错误码传递，由 CLI 补充中文说明，保留构建工具原始输出和退出码，也不改变项目默认字符集。

复核 Maven 启动脚本时发现，它还会自行向 JVM 注入绝对项目根目录。Windows 的配置根无法由原生编码表示时，子进程使用相对 `MAVEN_BASEDIR` 读取 `.mvn`，再通过 Maven 3.9.2 引入的环境属性插值恢复模型中的绝对根目录；保留显式配置及最近 `.mvn` 祖先的含义，不修改父进程环境。可表示的路径保持绝对形式。完整二进制验收新增 `.mvn/maven.config` 属性经过资源过滤后实际生效的检查，覆盖中文项目目录和祖先目录，并验证模型根目录的绝对路径及配置位置；通常为 21 项，原生命令行编码无法表示 Unicode 的 Windows 环境为 23 项。

Windows 二进制验收进一步发现，Maven 对相对模块目录进行路径比较时，CI 临时目录的 8.3 短名无法匹配有效模型中的长名。执行前使用原生 `realpath` 规范化工作目录及已有配置根，保留 `--module app` 的目录选择语义。六个平台的结果仍由上述分支 Check 验证。
