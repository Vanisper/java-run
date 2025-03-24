import iconv from 'iconv-lite';
import jschardet from 'jschardet';
import { spawnSync } from 'child_process';

/** 执行命令并获取输出 */
export function executeCommand(command: string, args: string[], options?: Parameters<typeof spawnSync>[2]): string {
  const result = spawnSync(command, args, { ...options });
  
  if (result.status !== 0) {
    console.error(`❌ 执行错误: ${command} ${args.join(' ')}`);
    console.error(result.error);
    // console.log(result.stderr);
    process.exit(1);
  }

  if (!Buffer.isBuffer(result.stdout)) return result.stdout.trim();
  
  // 检测编码
  const detected = jschardet.detect(result.stdout);
  if (result.stdout.length && detected.encoding) {
    const str = iconv.decode(result.stdout, detected.encoding);
    return str.trim();
  }

  return result.stdout.toString().trim();
}