import { join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import cliProgress from 'cli-progress';
import { spawnSync } from 'child_process';
import { delimiter } from  './constant'

// 初始化进度条
const progressBar = new cliProgress.SingleBar({
  format: '🚀 进度: {bar} | 模块: {value}/{total} | 耗时: {duration}s',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true
});

// 配置常量
const CACHE_DIR = resolve('.cache/dependency-paths');
// 初始化缓存目录
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}
const TARGET_DIRS = ['classes', 'test-classes']; // 需要包含的编译目录

interface ClasspathConfig {
  refresh?: boolean;
  includeTests?: boolean;
}

export function buildClasspath(modulesInfos: { module: string, modulePath: string, groupId: string, version: string }[], config: ClasspathConfig = {}) {
  const modules = modulesInfos.map(item => item.modulePath)
  // 1. 生成模块路径
  const moduleClassPaths = modules.flatMap(m => 
    TARGET_DIRS.map(d => `${resolve(m, 'target', d)}/`)
  ).filter(p => existsSync(p));
  
  const modulePaths = modules.flatMap<string>(m => resolve(m, 'pom.xml')).filter(p => existsSync(p)).map(item => item.replace(/\\/g, '/').replace(/\/pom\.xml$/, ''));

  // 2. 获取依赖路径（带缓存）
  const depPaths = getDependencyPaths(modulePaths, config.refresh);
  
  const disableModules = modulesInfos.map<string>(item => join(item.groupId.split('.').join('/'), item.module, item.version, `${item.module}-${item.version}.jar`)); 
  
  // 3. 组合完整类路径
  return [
    ...moduleClassPaths,
    ...depPaths.filter(item => !disableModules.some(i => item.endsWith(i))),
  ];
}

function getDependencyPaths(modulePaths: string[], refresh = false) {
  console.log();
  console.log('⏳ 获取项目完整依赖', refresh ? '刷新缓存' : '使用缓存');
  progressBar.start(modulePaths.length, 0);
  const paths: string[] = [];

  // 递归处理每个模块路径
  const processModule = (modulePath: string) => {
    const absPath = resolve(modulePath);
    const pomPath = join(absPath, 'pom.xml');
    
    if (!existsSync(pomPath)) {
      throw new Error(`找不到 pom.xml: ${pomPath}`);
    }

    // 生成唯一缓存文件名 (基于模块路径哈希)
    const hash = Buffer.from(absPath).toString('base64url');
    const cacheFile = join(CACHE_DIR, `${hash}.cache`);

    // 检查缓存有效性
    const cacheValid = existsSync(cacheFile)
      && existsSync(join(absPath, 'target'));
      // && (Date.now() - require('fs').statSync(cacheFile).mtimeMs < 3600_000);

    if (!refresh && cacheValid) {
      paths.push(readFileSync(cacheFile, 'utf-8'));
      return progressBar.increment();
    }

    // 执行 mvn 命令生成依赖路径
    const result = spawnSync('mvn', [
      'dependency:build-classpath',
      '-Dmdep.outputFile=' + cacheFile,
      // '-Dmdep.includeScope=compile,runtime',
      '-Dmdep.useRepositoryLayout=true',
      '-q',
      '-B',
      '-f', pomPath
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`依赖解析失败: ${absPath}\n尝试执行 mvn clean install -U \n${result.stdout?.toString()}`);
    }

    // 收集当前模块路径
    paths.push(readFileSync(cacheFile, 'utf-8'));

    // 递归处理子模块
    const childModules = detectChildModules(pomPath);
    childModules.forEach(child => 
      processModule(join(absPath, child)));
    progressBar.increment();
  };

  // 开始处理
  modulePaths.forEach(processModule);
  progressBar.stop();

  // 合并路径并去重
  return Array.from(new Set(paths.flatMap<string>(p => p.split(delimiter).map(item => resolve(item)))))
    .filter((v, i, a) => a.indexOf(v) === i);
}

// 辅助函数：解析子模块列表
function detectChildModules(pomPath: string): string[] {
  try {
    const content = readFileSync(pomPath, 'utf-8');
    const match = content.match(/<modules>(.*?)<\/modules>/s);
    return match?.[1]?.match(/<module>(.*?)<\/module>/g)
      ?.map(m => m.replace(/<\/?module>/g, '').trim()) || [];
  } catch {
    return [];
  }
}
