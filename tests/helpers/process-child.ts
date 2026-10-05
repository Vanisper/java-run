import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../src/process/exec';

const [mode, directory] = process.argv.slice(2);
const helperPath = fileURLToPath(import.meta.url);

if (mode === 'args') {
  console.log(JSON.stringify(process.argv.slice(3)));
} else if (mode === 'runner' || mode === 'exiting-runner') {
  const running = runCommand({
    command: process.execPath,
    args: [helperPath, 'tree', directory!],
    cwd: directory!,
    stage: '信号转发测试',
  });
  if (mode === 'exiting-runner') {
    setInterval(() => {
      if (existsSync(path.join(directory!, 'leaf.pid'))) process.exit(0);
    }, 10);
  } else {
    writeFileSync(path.join(directory!, 'result.json'), JSON.stringify(await running));
  }
} else if (mode === 'windows-runner') {
  const batch = path.join(directory!, 'tree entry.cmd');
  writeFileSync(batch, `@echo off\r\n"${process.execPath}" "${helperPath}" tree "${directory}"\r\n`);
  const running = runCommand({ command: batch, args: [], cwd: directory!, stage: 'Windows 进程树清理' });
  const ready = setInterval(() => {
    if (existsSync(path.join(directory!, 'leaf.pid'))) {
      clearInterval(ready);
      // Windows 没有可移植的 POSIX 信号发送，直接触发执行器已注册的转发入口
      process.emit('SIGTERM');
    }
  }, 10);
  writeFileSync(path.join(directory!, 'result.json'), JSON.stringify(await running));
} else if (mode === 'tree' || mode === 'orphan') {
  writeFileSync(path.join(directory!, 'child.pid'), String(process.pid));
  spawn(process.execPath, [helperPath, 'leaf', directory!], { stdio: 'inherit' });
  if (mode === 'orphan') {
    const ready = setInterval(() => {
      if (existsSync(path.join(directory!, 'leaf.pid'))) {
        clearInterval(ready);
        process.exit(0);
      }
    }, 10);
  } else {
    setInterval(() => {}, 1000);
  }
} else if (mode === 'leaf') {
  writeFileSync(path.join(directory!, 'leaf.pid'), String(process.pid));
  setInterval(() => {}, 1000);
}
