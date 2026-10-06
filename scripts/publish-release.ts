import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertReleaseAssets, assertReleaseLicense, releaseMetadata, releaseNotes } from './release';

const projectRoot = resolve(import.meta.dir, '..');

function command(directory: string, program: string, args: string[], input?: string): string {
  const result = spawnSync(program, args, { cwd: directory, encoding: 'utf8', input });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} 执行失败：${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** 正式发布只能由 master 上的手动请求启动，所有任务使用该请求锁定的提交 */
export function assertPublishRequest(event: string | undefined, ref: string | undefined, sha: string | undefined): asserts sha is string {
  if (event !== 'workflow_dispatch' || ref !== 'refs/heads/master' || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('请在 master 分支手动运行 Publish 工作流');
  }
}

/** 检查发布提交属于主分支，并拒绝指向其他提交的同名远端标签 */
export function verifyReleaseSource(directory: string, tag: string, sha: string): { tagged: boolean } {
  const git = (...args: string[]) => command(directory, 'git', args);
  const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
  releaseMetadata(version, tag);
  if (!/^[0-9a-f]{40}$/.test(sha) || git('rev-parse', 'HEAD') !== sha) throw new Error('当前检出提交与锁定的发布提交不一致');
  git('fetch', '--no-tags', 'origin', 'refs/heads/master:refs/remotes/origin/master');
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/master'], { cwd: directory });
  if (ancestor.error || ancestor.status !== 0) throw new Error('发布提交不属于远端 master');
  const refs = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  const entries = new Map(refs.split('\n').filter(Boolean).map(line => {
    const [object, ref] = line.split(/\s+/);
    return [ref!, object!] as const;
  }));
  const target = entries.get(`refs/tags/${tag}^{}`) ?? entries.get(`refs/tags/${tag}`);
  if (target && target !== sha) throw new Error(`远端标签 ${tag} 指向其他提交，不能覆盖`);
  return { tagged: target !== undefined };
}

/** 创建附注标签；重试时仅复用已经指向同一提交的远端标签 */
export function pushReleaseTag(directory: string, tag: string, sha: string): void {
  if (verifyReleaseSource(directory, tag, sha).tagged) return;
  // 直接创建附注对象，不复用或改写本地同名标签
  const annotation = `object ${sha}\ntype commit\ntag ${tag}\ntagger github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000\n\n${tag}\n`;
  const object = command(directory, 'git', ['mktag'], annotation);
  command(directory, 'git', ['push', 'origin', `${object}:refs/tags/${tag}`]);
}

interface DraftRelease {
  id: number;
  draft: true;
  assets: { name: string }[];
}

/** 查询未公开草稿；已发布版本、仓库不可访问和查询失败均拒绝继续 */
export async function readReleaseDraft(repository: string, tag: string, token: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<DraftRelease | undefined> {
  const [owner, name] = repository.split('/');
  // REST 的按标签查询只返回已公开版本，GraphQL 可同时读取草稿
  const response = await request('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!, $tag: String!) {
        repository(owner: $owner, name: $name) {
          release(tagName: $tag) {
            databaseId tagName isDraft
            releaseAssets(first: 100) { nodes { name } pageInfo { hasNextPage } }
          }
        }
      }`,
      variables: { owner, name, tag },
    }),
  });
  if (!response.ok) throw new Error(`查询 Release 失败：HTTP ${response.status}`);
  const result = await response.json() as {
    errors?: { message: string }[];
    data?: { repository: { release: {
      databaseId: number; tagName: string; isDraft: boolean;
      releaseAssets: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } };
    } | null } | null };
  };
  if (result.errors?.length || !result.data?.repository) throw new Error('查询 Release 失败：GitHub 返回错误或仓库不可访问');
  const release = result.data.repository.release;
  if (!release) return undefined;
  if (release.tagName !== tag) throw new Error('Release 标签与请求不一致');
  if (!release.isDraft) throw new Error(`版本 ${tag} 已公开发布，请使用新版本`);
  if (release.releaseAssets.pageInfo.hasNextPage) throw new Error('Release 草稿包含过多资产，请检查额外文件');
  return { id: release.databaseId, draft: true, assets: release.releaseAssets.nodes };
}

async function main(action: string | undefined): Promise<void> {
  const sha = process.env.GITHUB_SHA;
  assertPublishRequest(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, sha);
  if (action !== 'check' && action !== 'publish') throw new Error('用法：bun scripts/publish-release.ts check | publish');
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('缺少 GitHub 仓库或认证令牌');
  assertReleaseLicense(projectRoot);
  const version = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version;
  const metadata = releaseMetadata(version);
  const source = verifyReleaseSource(projectRoot, metadata.tag, sha);
  let draft = await readReleaseDraft(repository, metadata.tag, token);
  if (draft && !source.tagged) throw new Error('已有发布草稿但对应标签不存在，请检查草稿与发布提交');
  if (action === 'check') return;

  pushReleaseTag(projectRoot, metadata.tag, sha);
  const gh = (...args: string[]) => command(projectRoot, 'gh', args);
  const temporary = mkdtempSync(join(tmpdir(), 'java-run-release-'));
  try {
    const notes = join(temporary, 'notes.md');
    const changes = gh('api', '--method', 'POST', `repos/${repository}/releases/generate-notes`,
      '-f', `tag_name=${metadata.tag}`, '-f', `target_commitish=${sha}`, '--jq', '.body');
    writeFileSync(notes, `${releaseNotes(version)}\n${changes}\n`);
    draft = await readReleaseDraft(repository, metadata.tag, token);
    if (draft) {
      gh('release', 'edit', metadata.tag, '--title', `java-run ${metadata.tag}`,
        '--notes-file', notes, `--prerelease=${metadata.prerelease}`);
    } else {
      gh('release', 'create', metadata.tag, '--verify-tag', '--draft', '--title', `java-run ${metadata.tag}`,
        '--notes-file', notes, `--prerelease=${metadata.prerelease}`);
    }
    const beforeUpload = await readReleaseDraft(repository, metadata.tag, token);
    if (!beforeUpload) throw new Error('发布草稿不存在');
    if (!verifyReleaseSource(projectRoot, metadata.tag, sha).tagged) throw new Error('发布标签已被删除');
    const files = [...metadata.matrix.include.map(platform => platform.archive), 'SHA256SUMS'];
    gh('release', 'upload', metadata.tag, ...files.map(file => join('dist', file)), '--clobber');
    const ready = await readReleaseDraft(repository, metadata.tag, token);
    if (!ready || ready.id !== beforeUpload.id) throw new Error('发布草稿已发生变化');
    assertReleaseAssets(ready.assets.map(asset => asset.name), version);
    if (!verifyReleaseSource(projectRoot, metadata.tag, sha).tagged) throw new Error('发布标签已被删除');
    gh('release', 'edit', metadata.tag, '--draft=false', `--prerelease=${metadata.prerelease}`,
      ...(metadata.prerelease ? ['--latest=false'] : []));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  main(Bun.argv.length === 3 ? Bun.argv[2] : undefined).catch(error => {
    console.error(`java-run：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
