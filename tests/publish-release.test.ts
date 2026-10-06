import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPublishRequest, pushReleaseTag, readReleaseDraft, verifyReleaseSource } from '../scripts/publish-release';
import { assertReleaseLicense } from '../scripts/release';

// 实际 Git 进程集成测试需要覆盖不同平台的进程启动耗时
const gitTestTimeout = 30_000;

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'java-run-publish-'));
  const remote = join(directory, 'remote.git');
  const cwd = join(directory, 'checkout');
  function run(at: string, args: string[]) {
    const result = spawnSync('git', args, { cwd: at, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
    return result.stdout.trim();
  }
  const git = (...args: string[]) => run(cwd, args);
  run(directory, ['init', '--bare', remote]);
  run(directory, ['init', '--initial-branch=master', cwd]);
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'core.hooksPath', '');
  writeFileSync(join(cwd, 'package.json'), '{"name":"release-test","version":"1.2.3"}\n');
  git('add', 'package.json');
  git('commit', '-m', 'Initial version');
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'master');
  const sha = git('rev-parse', 'HEAD');
  return { cwd, remote, sha, git, run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

describe('手动发布契约', () => {
  test('仅接受 master 的手动请求与完整提交 SHA', () => {
    const sha = 'a'.repeat(40);
    expect(() => assertPublishRequest('workflow_dispatch', 'refs/heads/master', sha)).not.toThrow();
    for (const [event, ref, commit] of [
      ['push', 'refs/heads/master', sha],
      ['workflow_dispatch', 'refs/heads/feature', sha],
      ['workflow_dispatch', 'refs/tags/v1.2.3', sha],
      ['workflow_dispatch', 'refs/heads/master', 'master'],
      ['workflow_dispatch', 'refs/heads/master', undefined],
    ]) expect(() => assertPublishRequest(event, ref, commit)).toThrow('master');
  });

  test('缺失或空白许可证拒绝发布，允许三种许可证文件名', () => {
    const directory = mkdtempSync(join(tmpdir(), 'java-run-license-'));
    try {
      expect(() => assertReleaseLicense(directory)).toThrow('LICENSE');
      writeFileSync(join(directory, 'LICENSE'), ' \n\t');
      expect(() => assertReleaseLicense(directory)).toThrow('LICENSE');
      for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
        writeFileSync(join(directory, filename), 'Test license\n');
        expect(() => assertReleaseLicense(directory)).not.toThrow();
        rmSync(join(directory, filename));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('验收提交创建附注标签，重跑不改标签对象', () => {
    const repo = repository();
    try {
      expect(verifyReleaseSource(repo.cwd, 'v1.2.3', repo.sha)).toEqual({ tagged: false });
      pushReleaseTag(repo.cwd, 'v1.2.3', repo.sha);
      expect(repo.run(repo.remote, ['cat-file', '-t', 'refs/tags/v1.2.3'])).toBe('tag');
      expect(repo.run(repo.remote, ['rev-parse', 'refs/tags/v1.2.3^{}'])).toBe(repo.sha);
      const tagObject = repo.run(repo.remote, ['rev-parse', 'refs/tags/v1.2.3']);
      pushReleaseTag(repo.cwd, 'v1.2.3', repo.sha);
      expect(repo.run(repo.remote, ['rev-parse', 'refs/tags/v1.2.3'])).toBe(tagObject);
      expect(repo.git('status', '--porcelain')).toBe('');
    } finally { repo.cleanup(); }
  }, gitTestTimeout);

  test('主分支前进后仍发布原先锁定的提交', () => {
    const repo = repository();
    try {
      repo.git('commit', '--allow-empty', '-m', 'Later feature');
      repo.git('push', 'origin', 'master');
      repo.git('checkout', '--detach', repo.sha);
      pushReleaseTag(repo.cwd, 'v1.2.3', repo.sha);
      expect(repo.run(repo.remote, ['rev-parse', 'refs/tags/v1.2.3^{}'])).toBe(repo.sha);
      expect(repo.run(repo.remote, ['rev-parse', 'master'])).not.toBe(repo.sha);
    } finally { repo.cleanup(); }
  }, gitTestTimeout);

  test('同名轻量标签也必须精确匹配提交', () => {
    const repo = repository();
    try {
      repo.git('tag', 'v1.2.3');
      repo.git('push', 'origin', 'refs/tags/v1.2.3');
      expect(verifyReleaseSource(repo.cwd, 'v1.2.3', repo.sha)).toEqual({ tagged: true });
      repo.git('commit', '--allow-empty', '-m', 'Changed release source');
      repo.git('push', 'origin', 'master');
      const newer = repo.git('rev-parse', 'HEAD');
      expect(() => pushReleaseTag(repo.cwd, 'v1.2.3', newer)).toThrow('不能覆盖');
      expect(repo.run(repo.remote, ['rev-parse', 'refs/tags/v1.2.3'])).toBe(repo.sha);
    } finally { repo.cleanup(); }
  }, gitTestTimeout);

  test('附注标签冲突、错误检出和未合入主分支的提交均拒绝发布', () => {
    const repo = repository();
    try {
      pushReleaseTag(repo.cwd, 'v1.2.3', repo.sha);
      repo.git('switch', '-c', 'feature');
      repo.git('commit', '--allow-empty', '-m', 'Unmerged change');
      const feature = repo.git('rev-parse', 'HEAD');
      expect(() => verifyReleaseSource(repo.cwd, 'v1.2.3', repo.sha)).toThrow('锁定');
      expect(() => verifyReleaseSource(repo.cwd, 'v1.2.3', feature)).toThrow('不属于');
      repo.git('switch', 'master');
      repo.git('merge', '--ff-only', 'feature');
      repo.git('push', 'origin', 'master');
      expect(() => pushReleaseTag(repo.cwd, 'v1.2.3', feature)).toThrow('不能覆盖');
      expect(repo.run(repo.remote, ['rev-parse', 'refs/tags/v1.2.3^{}'])).toBe(repo.sha);
    } finally { repo.cleanup(); }
  }, gitTestTimeout);

  test('标签必须匹配包版本，远端查询失败不能当成标签不存在', () => {
    const repo = repository();
    try {
      expect(() => pushReleaseTag(repo.cwd, 'v1.2.4', repo.sha)).toThrow('版本不一致');
      repo.git('remote', 'set-url', 'origin', join(repo.cwd, 'missing.git'));
      expect(() => pushReleaseTag(repo.cwd, 'v1.2.3', repo.sha)).toThrow('git 执行失败');
      expect(repo.run(repo.remote, ['tag', '--list'])).toBe('');
    } finally { repo.cleanup(); }
  }, gitTestTimeout);

  test('Release 草稿查询可恢复，错误响应与公开版本拒绝继续', async () => {
    const request = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    const response = (release: unknown) => ({ data: { repository: { release } } });
    await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(200, response(null)))).resolves.toBeUndefined();
    for (const status of [401, 403, 404, 429, 500]) {
      await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(status, {}))).rejects.toThrow(`HTTP ${status}`);
    }
    const draft = { databaseId: 42, tagName: 'v1.2.3', isDraft: true,
      releaseAssets: { nodes: [{ name: 'partial.zip' }], pageInfo: { hasNextPage: false } } };
    await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(200, response(draft)))).resolves.toEqual({
      id: 42, draft: true, assets: [{ name: 'partial.zip' }],
    });
    await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(200, response({ ...draft, isDraft: false })))).rejects.toThrow('已公开');
    await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(200, response({ ...draft, tagName: 'v1.2.4' })))).rejects.toThrow('标签');
    await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(200, { errors: [{ message: 'Denied' }] }))).rejects.toThrow('GitHub');
    await expect(readReleaseDraft('owner/repo', 'v1.2.3', 'test', request(200, { data: { repository: null } }))).rejects.toThrow('仓库');
  });

  test('普通演练不受标签环境影响，未知元数据选项被拒绝', () => {
    const root = join(import.meta.dir, '..');
    const script = join(root, 'scripts/release.ts');
    const env = { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.0.0', GITHUB_OUTPUT: '' };
    const preview = spawnSync(process.execPath, [script, 'metadata'], { cwd: root, env, encoding: 'utf8' });
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).version).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
    const invalid = spawnSync(process.execPath, [script, 'metadata', '--unknown'], { cwd: root, env, encoding: 'utf8' });
    expect(invalid.status).toBe(1);
  });
});
