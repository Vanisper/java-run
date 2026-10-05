import { linkSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProjectConfig } from './config';

/** 已检查目标位置、等待保存启动配置的写入器 */
export interface ProjectConfigWriter {
  readonly path: string;
  /** 完整写入后发布配置；目标冲突或写入失败时抛出错误并清理暂存文件 */
  save(config: ProjectConfig): void;
}

function checkDestination(path: string, force: boolean): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) return;
  if (!force) throw new Error(`配置已存在：${path}，如需重新生成，请使用 init --force`);
  if (!existing.isFile()) throw new Error(`无法替换配置：${path} 不是普通文件`);
}

/**
 * 检查配置位置并返回延迟写入器，不创建或读取现有配置
 *
 * @description 默认拒绝已有目标；force 仅允许替换普通文件，保存时再次检查并从同目录暂存文件发布
 */
export function createProjectConfigWriter(cwd: string, force = false): ProjectConfigWriter {
  const path = join(cwd, '.java-run.json');
  checkDestination(path, force);
  return {
    path,
    save(config) {
      checkDestination(path, force);
      const temporary = join(cwd, `.java-run-init-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
        if (force) {
          checkDestination(path, true);
          renameSync(temporary, path);
        } else {
          try {
            linkSync(temporary, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') checkDestination(path, false);
            throw error;
          }
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
