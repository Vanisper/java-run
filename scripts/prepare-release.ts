import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { releaseMetadata } from './release';

interface PullRequest {
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefOid: string;
  headRefName: string;
  isCrossRepository: boolean;
}

interface PullRequests {
  list(branch: string): PullRequest[];
  create(branch: string, title: string, bodyFile: string): string;
}

/** 已准备的发布分支、提交和对应 PR */
export interface PreparedRelease {
  branch: string;
  sha: string;
  pr_url: string;
}

function command(cwd: string, program: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} 执行失败：${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function githubPullRequests(cwd: string, repository: string): PullRequests {
  return {
    list(branch) {
      const opened: PullRequest[] = JSON.parse(command(cwd, 'gh', [
        'pr', 'list', '--repo', repository, '--base', 'master', '--state', 'open',
        '--json', 'url,state,headRefOid,headRefName,isCrossRepository', '--limit', '1000',
      ]));
      if (opened.length === 1000) throw new Error('未合并 PR 数量过多，无法确认其他发布准备，请由维护者核对');
      const matching: PullRequest[] = JSON.parse(command(cwd, 'gh', [
        'pr', 'list', '--repo', repository, '--base', 'master', '--head', branch,
        '--state', 'all', '--json', 'url,state,headRefOid,headRefName,isCrossRepository', '--limit', '100',
      ]));
      return [...matching, ...opened.filter(request => request.headRefName !== branch)];
    },
    create(branch, title, bodyFile) {
      try {
        return command(cwd, 'gh', [
          'pr', 'create', '--repo', repository, '--base', 'master', '--head', branch,
          '--title', title, '--body-file', bodyFile,
        ]);
      } catch (error) {
        throw new Error(`无法创建发布 PR，已推送的 ${branch} 分支会保留，可修正后使用同版本重跑。\n${(error as Error).message}\n若仓库禁止 Actions 创建 PR，请由维护者在 Settings → Actions → General → Workflow permissions 启用 Allow GitHub Actions to create and approve pull requests。`);
      }
    },
  };
}

/**
 * 从指定 master 提交准备版本并创建或恢复发布 PR
 *
 * @description 只写入新的远端发布分支；已有分支必须与本次准备的父提交、文件内容和机器人提交标识完全一致
 */
export function prepareRelease(options: {
  cwd: string;
  version: string;
  baseSha: string;
  repository: string;
  pullRequests?: PullRequests;
}): PreparedRelease {
  const { cwd, version, baseSha, repository } = options;
  const metadata = releaseMetadata(version);
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('发布准备必须指定完整的 master 提交 SHA');
  const git = (...args: string[]) => command(cwd, 'git', args);
  if (git('rev-parse', 'HEAD') !== baseSha) throw new Error('当前检出提交与发布准备提交不一致');
  if (git('status', '--porcelain')) throw new Error('工作区存在未提交改动，请先保存改动');
  git('merge-base', '--is-ancestor', baseSha, 'origin/master');
  const manifest = JSON.parse(git('show', `${baseSha}:package.json`));
  if (typeof manifest.version !== 'string') throw new Error('package.json 必须包含版本字符串');
  releaseMetadata(manifest.version);
  const previousVersion = manifest.version;
  if (Bun.semver.order(version, manifest.version) <= 0) {
    throw new Error(`新版本 ${version} 必须高于当前版本 ${manifest.version}，构建元数据不提高版本优先级`);
  }

  const branch = `release/${version}`;
  const branchRef = `refs/heads/${branch}`;
  const title = `chore(release): prepare ${metadata.tag}`;
  const message = `${title}\n\nJava-Run-Release-Base: ${baseSha}`;
  git('check-ref-format', branchRef);
  if (git('ls-remote', '--refs', 'origin', `refs/tags/${metadata.tag}`)) {
    throw new Error(`标签 ${metadata.tag} 已存在，请使用新的发布版本`);
  }
  const requests = options.pullRequests ?? githubPullRequests(cwd, repository);
  const releaseRequests = requests.list(branch).filter(request => !request.isCrossRepository);
  if (releaseRequests.some(request => request.state === 'OPEN'
    && request.headRefName.startsWith('release/') && request.headRefName !== branch)) {
    throw new Error('已有其他未合并的发布准备 PR，请先合并或关闭它，再准备新版本');
  }
  const existingRequests = releaseRequests.filter(request => request.headRefName === branch);
  if (existingRequests.length > 1 || existingRequests.some(request => request.state !== 'OPEN')) {
    throw new Error(`${branch} 已关联关闭、合并或多个 PR，请使用新版本或由维护者核对已有 PR`);
  }
  const existingRequest = existingRequests[0];
  const remoteSha = git('ls-remote', '--refs', 'origin', branchRef).split(/\s+/)[0] || undefined;
  if (existingRequest && !remoteSha) throw new Error('已有发布 PR 的远端分支不存在，请由维护者检查');

  const temporary = mkdtempSync(join(tmpdir(), 'java-run-prepare-release-'));
  const worktree = join(temporary, 'worktree');
  let worktreeAdded = false;
  try {
    git('worktree', 'add', '--detach', worktree, baseSha);
    worktreeAdded = true;
    manifest.version = version;
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    command(worktree, 'git', ['add', '--', 'package.json']);
    const tree = command(worktree, 'git', ['write-tree']);
    let sha: string;
    if (remoteSha) {
      git('fetch', '--no-tags', 'origin', remoteSha);
      if (git('rev-parse', `${remoteSha}^{tree}`) !== tree
        || git('show', '-s', '--format=%P', remoteSha) !== baseSha
        || git('show', '-s', '--format=%B', remoteSha) !== message
        || git('show', '-s', '--format=%ae', remoteSha) !== '41898282+github-actions[bot]@users.noreply.github.com') {
        throw new Error(`${branch} 已存在且不匹配本次发布准备，拒绝覆盖已有分支`);
      }
      sha = remoteSha;
    } else {
      command(worktree, 'git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', message], {
        ...process.env,
        GIT_AUTHOR_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      });
      sha = command(worktree, 'git', ['rev-parse', 'HEAD']);
      command(worktree, 'git', ['push', 'origin', `${sha}:${branchRef}`]);
    }
    if (existingRequest) {
      if (existingRequest.headRefOid !== sha) throw new Error('已有发布 PR 的提交与远端发布分支不一致，请稍后重试');
      return { branch, sha, pr_url: existingRequest.url };
    }
    const bodyFile = join(temporary, 'pull-request.md');
    writeFileSync(bodyFile, `准备发布 \`${metadata.tag}\`，将 \`package.json\` 版本从 \`${previousVersion}\` 更新为 \`${version}\`。\n\n准备基于提交 \`${baseSha}\`，本 PR 不包含其他功能变更。\n\n由 Actions 创建的 PR 可能需要维护者点击 **Approve workflows to run** 才会开始检查。检查通过并合并到 \`master\` 后，在 Actions 中运行 **Publish** 工作流发布该版本。发布流程会验收固定提交的五平台产物，再创建标签和 GitHub Release；本 PR 不会自动合并或发布。\n`);
    return { branch, sha, pr_url: requests.create(branch, title, bodyFile) };
  } finally {
    if (worktreeAdded) git('worktree', 'remove', '--force', worktree);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/master') {
      throw new Error('发布准备只能从 master 手动运行 Prepare Release 工作流');
    }
    const result = prepareRelease({
      cwd: resolve(import.meta.dir, '..'),
      version: process.env.RELEASE_VERSION ?? '',
      baseSha: process.env.GITHUB_SHA ?? '',
      repository: process.env.GITHUB_REPOSITORY ?? '',
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(result).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `发布准备 PR：${result.pr_url}\n\n分支：\`${result.branch}\`\n\n提交：\`${result.sha}\`\n\n合并后，从 master 手动运行 Publish 发布。\n`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
