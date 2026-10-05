/** 从源码工作区运行 Java 应用的配置 */
export interface RunConfig {
  action: 'help' | 'version' | 'run' | 'plan';
  cwd: string;
  buildTool: 'auto' | 'maven' | 'gradle';
  /** Maven reactor 选择器或 Gradle 项目路径，只能选择一个项目 */
  module?: string;
  /** 未指定时采用构建工具声明的主类或唯一的已编译 main 方法 */
  mainClass?: string;
  jvmArgs: string[];
  applicationArgs: string[];
  buildArgs: string[];
  /** auto 由适配器执行必要准备；none 要求产物已经准备好 */
  build: 'auto' | 'none';
  includeTests: boolean;
  javaCommand?: string;
  buildCommand?: string;
}

/** 保持参数边界的单个外部命令 */
export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  stage: string;
}

/** 构建工具裁决后可交给统一 Java 启动器的信息 */
export interface PreparedProject {
  directory: string;
  classesDirectories: string[];
  classpath: string[];
  mainClass?: string;
  javaCommand?: string;
  jvmArgs: string[];
}

/** 未执行构建工具时可预览的准备步骤 */
export interface BuildPlan {
  tool: 'maven' | 'gradle';
  commands: CommandSpec[];
  notes: string[];
}

/** Maven 选定项目的有效元数据 */
export interface MavenProject {
  pomFile: string;
  directory: string;
  groupId: string;
  artifactId: string;
  version: string;
  packaging: string;
  outputDirectory: string;
  testOutputDirectory: string;
  mainClass?: string;
}
