const definitions = [
  { name: 'windows-x64', runner: 'windows-2025', target: 'bun-windows-x64', binary: 'java-run.exe', label: 'Windows x64' },
  { name: 'linux-x64', runner: 'ubuntu-24.04', target: 'bun-linux-x64', binary: 'java-run', label: 'Linux x64' },
  { name: 'linux-arm64', runner: 'ubuntu-24.04-arm', target: 'bun-linux-arm64', binary: 'java-run', label: 'Linux ARM64' },
  { name: 'darwin-arm64', runner: 'macos-15', target: 'bun-darwin-arm64', binary: 'java-run', label: 'macOS Apple Silicon' },
  { name: 'darwin-x64', runner: 'macos-15-intel', target: 'bun-darwin-x64', binary: 'java-run', label: 'macOS Intel' },
] as const;

/** 编译、发布矩阵、归档和下载说明共用的平台清单 */
export const platforms = definitions.map(platform => ({
  ...platform,
  folder: `java-run-${platform.name}`,
  archive: `java-run-${platform.name}.zip`,
}));

/** 支持的 Bun 编译目标 */
export type BuildTarget = typeof platforms[number]['target'];

/** 查找发布平台，未知名称时拒绝继续构建或打包 */
export function platformFor(name: string) {
  const platform = platforms.find(platform => platform.name === name);
  if (!platform) throw new Error(`不支持的发布平台：${name}`);
  return platform;
}
