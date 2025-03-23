import { join, relative, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import cliProgress from 'cli-progress';
import { parseStringPromise } from 'xml2js';

// 初始化进度条
const progressBar = new cliProgress.SingleBar({
  format: '🚀 进度: {bar} | 模块: {value}/{total} | 耗时: {duration}s',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true
});

// 性能监控
const startTime = performance.now();
let totalModules = 0;
let leafModules = 0;

// 递归解析pom.xml
async function parsePomModules(pomPath: string, baseDir: string): Promise<{ groupId: string, module: string, modulePath: string, version: string }[]> {
  if (!existsSync(pomPath)) return [];

  try {
    // 读取并解析XML
    const xmlContent = readFileSync(pomPath, 'utf-8');
    const pom = await parseStringPromise(xmlContent);
    
    // 提取模块列表
    const modules: string[] = pom.project?.modules?.[0]?.module || [];
    const groupId = pom.project?.groupId?.[0] || pom.project?.parent?.[0]?.groupId?.[0] || '';
    const artifactId = pom.project?.artifactId?.[0] || pom.project?.parent?.[0]?.artifactId?.[0] || '';
    const version = pom.project?.version?.[0] || pom.project?.parent?.[0]?.version?.[0] || '';
    
    const validModules = modules.filter(m => m && typeof m === 'string');

    // 进度条更新
    totalModules += validModules.length;
    progressBar.setTotal(totalModules);
    progressBar.increment(validModules.length);

    // 无子模块 → 叶子模块
    if (validModules.length === 0) {
      leafModules++;
      progressBar.setTotal(++totalModules);
      progressBar.increment()
      const modulePath = relative(baseDir, join(pomPath, '..'));
      return [{ groupId, module: artifactId ,modulePath, version }];
    }

    // 递归处理子模块
    const results = await Promise.all(validModules.map(async (module) => {
      const childPom = resolve(join(pomPath, '..', module, 'pom.xml'));
      return parsePomModules(childPom, baseDir);
    }));

    return (await Promise.all(results)).flat();
  } catch (e) {
    console.error(`解析失败: ${pomPath}`, e);
    return [];
  }
}

// 主程序
export default async function main(isLog = true) {
  console.log();
  console.log('⏳ 搜寻项目模块依赖信息');
  progressBar.start(0, 0);

  const baseDir = process.cwd();
  const rootPom = join(baseDir, 'pom.xml');
  const modules = await parsePomModules(rootPom, baseDir);

  progressBar.stop();
  
  // 输出构建路径
  const result = modules.map(m =>({ ...m, module: m.module.replace(/\\/g, '/') }));

  // 性能报告
  const duration = (performance.now() - startTime) / 1000;
  isLog && console.log(`
📊 性能报告:
   总耗时: ${duration.toFixed(1) !== "0.0" ? `${duration.toFixed(1)}s` : `${(duration * 1000).toFixed(2)}ms` }
   解析模块数: ${totalModules}
   叶子模块数: ${leafModules}
   速度: ${(totalModules/duration).toFixed(1)} modules/s
`);

  return result
}

// main(false).then(console.log).catch(console.error);