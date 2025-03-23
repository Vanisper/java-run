import { resolve } from 'path';
import { writeFileSync } from 'fs';
import getMavenModules from "./find-maven-modules";
import { buildClasspath } from './classpath-builder';
import { executeCommand } from "./exec";
import parseArgvs from "./parse-argvs";
import helpLog, { defaultConfig } from "./help-log";

parseArgvs.set(Bun.argv);

// ----------- 配置参数 -----------
/** 不运行主程序，只执行其他操作 */
const NOT_RUN = !!parseArgvs.booleans(['not-run', 'no-run']);
/** 是否刷新缓存 */
const REFRESH_CACHE: boolean = !!parseArgvs.boolean('-r');
/** 启动类 */
let TARGET_CLASS = defaultConfig.mainClass

if (parseArgvs.key("main")) {
  const temp = parseArgvs.key("main")
  if (temp) TARGET_CLASS = temp
}

/** 指定配置文件 */
let PROFILES_ACTIVE = defaultConfig.profilesActive
if (parseArgvs.key("active")) {
  const temp = parseArgvs.key("active")
  if (temp) PROFILES_ACTIVE = temp
}

const LOCAL_FLAG_KEY = 'local'
const PROFILES_LOCAL_FLAG = !!parseArgvs.boolean(LOCAL_FLAG_KEY)
if (PROFILES_LOCAL_FLAG) {
  PROFILES_ACTIVE = PROFILES_ACTIVE.replace(`${LOCAL_FLAG_KEY}-`, "")
  PROFILES_ACTIVE = `${LOCAL_FLAG_KEY}-${PROFILES_ACTIVE}`
}

/** 没有指定 start 参数，只输出帮助信息 */
const HELP_FLAG = !!parseArgvs.booleans(["help", "-help", "--help", "h", "-h", "--h"]) || !parseArgvs.boolean('start')

// 获取项目版本号
function getProjectVersion(): string {
  return executeCommand('mvn', [
    'help:evaluate',
    '-Dexpression=project.version',
    '-q',
    '-DforceStdout'
  ]);
}

function getProjectGroupId(projectName?: string): string {
  return executeCommand('mvn', [
    'help:evaluate',
    '-Dexpression=project.groupId',
    '-q',
    '-DforceStdout',
    ...(projectName ? ['-pl', projectName] : [])
  ]);
}

// 构建项目
function buildProject(): void {
  console.log('正在构建项目...');
  executeCommand('mvn', ['clean', 'package']);
}

// 启动Java应用
function startApplication(classpath: string, mainClass: string, profile: string): void {
  const jvmArgs = [
    `-Dspring.profiles.active=${profile}`,
    `-Dspring.output.ansi.enabled=always`,
    `-Dfile.encoding=UTF-8`,
    '-classpath', classpath,
    mainClass
  ];

  console.log('启动应用程序...\n');
  executeCommand('java', jvmArgs, { 
    stdio: 'inherit',
    windowsHide: true
  });
}

// 主流程
async function main() {
  if (HELP_FLAG) {
    return helpLog()
  }
  
  // 1. 获取模块路径
  const modulesInfos = await getMavenModules(false);
  
  // 2. 获取项目元数据
  const version = getProjectVersion();
  console.log(`项目版本: ${version}`);

  // 3. 构建项目
  // buildProject();

  // 4. 准备运行环境
  const fullClasspath = buildClasspath(modulesInfos, {
    refresh: REFRESH_CACHE,
    includeTests: false
  });

  console.log('项目完整依赖数:', fullClasspath.length);
  const classpathFile = resolve(".cache", "classpath.cache");
  
  const classPathString = fullClasspath.map((item) => `file:/${item.replace(/\\/g, '/')}`).join(' ')
  const fullString = `Class-Path: ${classPathString}`;
  const lines: string[] = [];
  let remaining = fullString;
  // 处理首行 (最多72字符)
  lines.push(remaining.substring(0, 72));
  remaining = remaining.slice(72);
  // 处理后续行 (每行71字符 + 前导空格)
  while (remaining.length > 0) {
    const line = ` ${remaining.substring(0, 71)}`;
    lines.push(line);
    remaining = remaining.slice(71);
  }

  writeFileSync(classpathFile, [
    'Manifest-Version: 1.0',
    ...lines,
    'Created-By: Generated Tool',
    '' // 必须的空行
  ].join('\n'))

  const result = executeCommand('jar', ['-cvfm', '.cache/cp.jar', classpathFile])
  console.log(result);
  
  if (NOT_RUN) return
  // 5. 启动应用
  startApplication('.cache/cp.jar', TARGET_CLASS, PROFILES_ACTIVE);
  console.log('\n🎉 应用正常退出');
}

main().catch(err => {
  console.error('运行失败:', err);
  process.exit(1);
});
