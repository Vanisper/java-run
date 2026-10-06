import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRelease } from '../scripts/prepare-release';

// 实际 Git 进程集成测试需要覆盖不同平台的进程启动耗时
const gitTestTimeout = 30_000;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

function fixture(version = '0.0.5') {
  const directory = mkdtempSync(join(tmpdir(), 'java-run-prepare-test-'));
  directories.push(directory);
  const cwd = join(directory, 'checkout');
  const origin = join(directory, 'origin.git');
  git(directory, 'init', '--bare', '--initial-branch=master', origin);
  git(directory, 'init', '--initial-branch=master', cwd);
  git(cwd, 'config', 'user.name', 'Release test');
  git(cwd, 'config', 'user.email', 'release-test@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  const manifest = { name: 'java-run', version, scripts: { test: 'bun test' }, dependencies: { example: '^1.0.0' } };
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(cwd, 'README.md'), '# Test project\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Initial project');
  git(cwd, 'remote', 'add', 'origin', origin);
  git(cwd, 'push', '-u', 'origin', 'master');
  const baseSha = git(cwd, 'rev-parse', 'HEAD');
  const requests: ReturnType<NonNullable<Parameters<typeof prepareRelease>[0]['pullRequests']>['list']> = [];
  const created: { branch: string; title: string; body: string }[] = [];
  const pullRequests = {
    list(_branch: string) { return requests; },
    create(branch: string, title: string, bodyFile: string) {
      const url = `https://github.com/example/project/pull/${created.length + 1}`;
      created.push({ branch, title, body: readFileSync(bodyFile, 'utf8') });
      requests.push({ url, state: 'OPEN', headRefName: branch, headRefOid: git(origin, 'rev-parse', `refs/heads/${branch}`), isCrossRepository: false });
      return url;
    },
  };
  return { cwd, origin, baseSha, manifest, requests, created, options: { cwd, baseSha, repository: 'example/project', version: '0.1.0', pullRequests } };
}

describe('发布准备', () => {
  test('脚本入口拒绝非主分支或非手动事件，不触及远端', () => {
    for (const event of [
      { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/master' },
    ]) {
      const result = spawnSync(process.execPath, [join(import.meta.dir, '../scripts/prepare-release.ts')], {
        encoding: 'utf8', env: { ...process.env, ...event },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('只能从 master 手动运行');
    }
  });

  test('只在新发布分支更新版本，主分支和工作区保持原内容', () => {
    const project = fixture();
    const result = prepareRelease(project.options);
    expect(result.branch).toBe('release/0.1.0');
    expect(result.pr_url).toBe('https://github.com/example/project/pull/1');
    expect(git(project.origin, 'rev-parse', 'refs/heads/master')).toBe(project.baseSha);
    expect(git(project.cwd, 'rev-parse', 'HEAD')).toBe(project.baseSha);
    expect(git(project.cwd, 'status', '--porcelain')).toBe('');
    expect(git(project.origin, 'show', '-s', '--format=%P', result.sha)).toBe(project.baseSha);
    expect(git(project.origin, 'diff', '--name-only', project.baseSha, result.sha)).toBe('package.json');
    expect(JSON.parse(git(project.origin, 'show', `${result.sha}:package.json`))).toEqual({ ...project.manifest, version: '0.1.0' });
    expect(JSON.parse(readFileSync(join(project.cwd, 'package.json'), 'utf8'))).toEqual(project.manifest);
    expect(git(project.origin, 'tag', '--list')).toBe('');
    expect(project.created[0]?.body).toContain('Approve workflows to run');
    expect(project.created[0]?.body).toContain('**Publish**');
  }, gitTestTimeout);

  test('同一提交和版本重跑恢复已有 PR，不追加提交或创建重复 PR', () => {
    const project = fixture();
    const original = prepareRelease(project.options);
    expect(prepareRelease(project.options)).toEqual(original);
    expect(project.created).toHaveLength(1);
    expect(git(project.origin, 'rev-list', '--count', 'master..release/0.1.0')).toBe('1');
  }, gitTestTimeout);

  test('推送后创建 PR 失败，可在重跑时从相同分支恢复', () => {
    const project = fixture();
    expect(() => prepareRelease({ ...project.options, pullRequests: {
      list: () => [], create: () => { throw new Error('PR API unavailable'); },
    } })).toThrow('PR API unavailable');
    const pushed = git(project.origin, 'rev-parse', 'refs/heads/release/0.1.0');
    expect(prepareRelease(project.options).sha).toBe(pushed);
    expect(project.created).toHaveLength(1);
  }, gitTestTimeout);

  test('拒绝无效、相同、回退和仅构建元数据不同的版本', () => {
    const project = fixture('1.0.0');
    for (const version of ['v2.0.0', '2.0', '2.0.0;echo test', '2.0.0\n', '1.0.0', '0.9.9', '1.0.0-rc.1', '1.0.0+build.2']) {
      expect(() => prepareRelease({ ...project.options, version })).toThrow();
    }
    expect(git(project.origin, 'branch', '--list')).toBe('* master');
    expect(project.created).toHaveLength(0);
  }, gitTestTimeout);

  test('接受从预发布版推进到正式版', () => {
    const project = fixture('1.0.0-rc.1');
    expect(prepareRelease({ ...project.options, version: '1.0.0' }).branch).toBe('release/1.0.0');
  }, gitTestTimeout);

  test('已有标签时不创建准备分支', () => {
    const project = fixture();
    git(project.cwd, 'tag', 'v0.1.0');
    git(project.cwd, 'push', 'origin', 'refs/tags/v0.1.0');
    expect(() => prepareRelease(project.options)).toThrow('标签 v0.1.0 已存在');
    expect(git(project.origin, 'branch', '--list')).toBe('* master');
  }, gitTestTimeout);

  test('不覆盖已有用户分支或准备后追加的用户改动', () => {
    const project = fixture();
    const result = prepareRelease(project.options);
    git(project.cwd, 'switch', '--detach', result.sha);
    writeFileSync(join(project.cwd, 'README.md'), '# User update\n');
    git(project.cwd, 'add', 'README.md');
    git(project.cwd, 'commit', '-m', 'User change');
    const changed = git(project.cwd, 'rev-parse', 'HEAD');
    git(project.cwd, 'push', 'origin', 'HEAD:refs/heads/release/0.1.0');
    git(project.cwd, 'switch', 'master');
    expect(() => prepareRelease(project.options)).toThrow('拒绝覆盖已有分支');
    expect(git(project.origin, 'rev-parse', 'refs/heads/release/0.1.0')).toBe(changed);
    expect(project.created).toHaveLength(1);
  }, gitTestTimeout);

  test('同样的版本内容也不能冒充由工作流准备的分支', () => {
    const project = fixture();
    git(project.cwd, 'switch', '-c', 'release/0.1.0');
    writeFileSync(join(project.cwd, 'package.json'), `${JSON.stringify({ ...project.manifest, version: '0.1.0' }, null, 2)}\n`);
    git(project.cwd, 'add', 'package.json');
    git(project.cwd, 'commit', '-m', 'Manually update version');
    git(project.cwd, 'push', 'origin', 'release/0.1.0');
    const userCommit = git(project.cwd, 'rev-parse', 'HEAD');
    git(project.cwd, 'switch', 'master');
    expect(() => prepareRelease(project.options)).toThrow('拒绝覆盖已有分支');
    expect(git(project.origin, 'rev-parse', 'refs/heads/release/0.1.0')).toBe(userCommit);
  }, gitTestTimeout);

  test('已有关闭的同版本 PR 或其他未合并发布 PR 时拒绝重复准备', () => {
    const project = fixture();
    project.requests.push({ url: 'https://github.com/example/project/pull/8', state: 'OPEN', headRefName: 'release/0.2.0', headRefOid: project.baseSha, isCrossRepository: false });
    expect(() => prepareRelease(project.options)).toThrow('其他未合并的发布准备 PR');
    project.requests[0]!.headRefName = 'release/0.1.0';
    project.requests[0]!.state = 'CLOSED';
    expect(() => prepareRelease(project.options)).toThrow('已关联关闭');
    expect(git(project.origin, 'branch', '--list')).toBe('* master');
  }, gitTestTimeout);

  test('已关闭的其他版本与来自 fork 的同名 PR 不阻止准备', () => {
    const project = fixture();
    project.requests.push(
      { url: 'https://github.com/example/project/pull/8', state: 'CLOSED', headRefName: 'release/0.2.0', headRefOid: project.baseSha, isCrossRepository: false },
      { url: 'https://github.com/example/project/pull/9', state: 'OPEN', headRefName: 'release/0.1.0', headRefOid: project.baseSha, isCrossRepository: true },
    );
    expect(prepareRelease(project.options).branch).toBe('release/0.1.0');
    expect(project.created).toHaveLength(1);
  }, gitTestTimeout);

  test('不改动脏工作区，且只能使用当前检出的指定主分支提交', () => {
    const project = fixture();
    expect(() => prepareRelease({ ...project.options, baseSha: 'a'.repeat(40) })).toThrow('检出提交');
    writeFileSync(join(project.cwd, 'README.md'), '# Uncommitted work\n');
    expect(() => prepareRelease(project.options)).toThrow('未提交改动');
    expect(readFileSync(join(project.cwd, 'README.md'), 'utf8')).toBe('# Uncommitted work\n');
    expect(git(project.origin, 'branch', '--list')).toBe('* master');
  }, gitTestTimeout);
});
