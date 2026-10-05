/** 返回 CLI 帮助文本，不执行命令或修改进程状态 */
export function getHelpText(): string {
  return `java-run — Java 源码工作区运行器

用法：
  java-run [run] [选项] [-- 应用参数...]
  java-run init [选项] [-- 应用参数...]
  java-run plan [选项]
  java-run help | version

命令：
  run                     准备并启动应用，默认命令
  init                    准备并选择目标，生成项目启动配置，不启动应用
  plan                    预览构建步骤，不运行构建工具或写入项目文件
  help, --help, -h        显示帮助，不读取项目配置
  version, --version      显示版本，不读取项目配置

常用选项：
  --cwd <path>            工作区根目录，默认当前目录
  --module <selector>     单个 Maven reactor 选择器或 Gradle 项目路径
  --main <class>          启动类，默认使用构建声明或唯一的已编译 main 方法
  --jvm-arg=<value>       JVM 参数，可重复；负号开头的值必须用等号
  --arg=<value>           应用参数，可重复；也可使用 -- 透传

高级选项：
  --tool <name>           auto（默认）/ maven / gradle
  --build <strategy>      auto（默认）/ none
                         auto 执行必要的源码准备，由构建工具管理依赖
                         none 不主动构建源码，要求产物已经准备好
  --build-arg=<value>     构建工具参数，可重复；负号开头的值必须用等号
  --include-tests         准备并加入测试输出和测试依赖，不执行测试
  --java <command>        应用启动使用的 Java 可执行文件
  --build-command <cmd>   构建工具可执行文件，默认优先使用项目 Wrapper
  --force                 仅用于 init，忽略已有配置并重新生成

项目配置：
  run / plan 从 --cwd 指定的根目录读取 .java-run.json，不向父目录查找。
  可用字段：buildTool、module、mainClass、jvmArgs、applicationArgs、
            buildArgs、build、includeTests
  CLI 标量覆盖配置，数组在配置之后追加。
  配置使用严格 JSON，不展开环境变量；未知字段和无效类型均报错。
  init 保存实际构建工具、模块、主类及本次显式参数，准备时可能编译或下载依赖。
  init 遇到已有配置时拒绝；--force 从本次选项重新生成，不合并旧配置。
  --cwd、--java、--build-command 不写入配置；取消或准备失败不写配置。
  plan 只预览步骤，主类和运行类路径仍待构建工具解析。

交互选择：
  终端中缺少目标或存在多个主类时补充选择，库模块不一定可运行。
  仅选择目标和入口，参数通过选项提供；run 本次使用，init 保存到配置。
  非交互环境请用 --module / --main 明确指定，run 也可读取配置；取消返回 130。

示例：
  java-run
  java-run init
  java-run init --module app --jvm-arg=-Xmx1g -- --server.port=8081
  java-run --module :app
  java-run plan --tool gradle --module :app
  java-run --jvm-arg=-Xmx1g -- --server.port=8081
  java-run --main com.example.Application --build-arg=-Dcustom.mode=dev
`;
}

/** 输出帮助，进程退出由调用方决定 */
export function helpLog(): void {
  console.log(getHelpText());
}

export default helpLog;
