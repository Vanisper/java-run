# 安装 java-run

java-run 的预编译版本可直接执行，不需要安装 Bun。运行目标项目仍需要符合该项目要求的 JDK，以及 Maven / Gradle 或项目 Wrapper；JDK 的 `java` 和 `jar` 必须可用。项目存在 `mvnw` / `mvnw.cmd` 或 `gradlew` / `gradlew.bat` 时优先使用 Wrapper，没有时使用 PATH 中的构建工具。发布验收覆盖 JDK 17 和 21，目标项目自身的 Java 版本要求仍需满足。

## 选择下载文件

在 [GitHub Releases](https://github.com/Vanisper/java-run/releases) 选择版本，下载对应平台的 ZIP 和同一版本的 `SHA256SUMS`：

| 系统与体系结构 | 最新稳定版下载 |
| --- | --- |
| Windows x64 | [java-run-windows-x64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-windows-x64.zip) |
| Linux x64 | [java-run-linux-x64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-linux-x64.zip) |
| Linux arm64 | [java-run-linux-arm64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-linux-arm64.zip) |
| macOS arm64（Apple Silicon） | [java-run-darwin-arm64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-darwin-arm64.zip) |
| macOS x64（Intel） | [java-run-darwin-x64.zip](https://github.com/Vanisper/java-run/releases/latest/download/java-run-darwin-x64.zip) |

[最新稳定版校验和](https://github.com/Vanisper/java-run/releases/latest/download/SHA256SUMS) 覆盖这五个 ZIP。macOS / Linux 可运行 `uname -m`：`x86_64` 对应 x64，`arm64` / `aarch64` 对应 arm64。Windows 可在“设置 → 系统 → 关于”查看系统类型，当前提供 x64 版本。

Linux 产物在 Ubuntu 24.04 的 glibc 环境验收；musl（如 Alpine）和其他系统版本未纳入发布验收。

资产名称固定，版本位于 URL 中。指定版本的下载地址格式为：

```text
https://github.com/Vanisper/java-run/releases/download/vX.Y.Z/java-run-<平台>.zip
https://github.com/Vanisper/java-run/releases/download/vX.Y.Z/SHA256SUMS
```

将 `vX.Y.Z` 替换为所选 Release 的完整标签；预发布版本也使用完整标签下载。`/releases/latest/download/` 用于最新稳定版。ZIP 解压后只有一个 `java-run-<平台>/` 目录，内含 `java-run` 或 `java-run.exe`、对应的 `java-run.sha256` 或 `java-run.exe.sha256`、本安装指南 `INSTALL.md`，以及存在时按原文件名附带的许可证。Release 的 `SHA256SUMS` 校验下载的 ZIP，包内 `.sha256` 校验解压后的二进制。

## macOS / Linux

下面以 macOS arm64 为例，在一个空的下载目录中执行。根据上表调整 `platform`；要固定版本，将 `release_url` 改成对应的 `/releases/download/vX.Y.Z`：

```sh
platform=darwin-arm64
release_url=https://github.com/Vanisper/java-run/releases/latest/download
asset="java-run-${platform}.zip"
curl -fL "$release_url/$asset" -o "$asset"
curl -fL "$release_url/SHA256SUMS" -o SHA256SUMS
```

解压前核对 ZIP 的 SHA-256。macOS 使用：

```sh
shasum -a 256 "$asset"
```

Linux 使用：

```sh
sha256sum "$asset"
```

将输出与 `SHA256SUMS` 中该 ZIP 对应的值核对，一致后再继续；不一致时重新下载同一版本的 ZIP 和校验和。

```sh
unzip "$asset"
cd "java-run-${platform}"
```

在解压目录中核对二进制。macOS 使用：

```sh
shasum -a 256 -c java-run.sha256
```

Linux 使用：

```sh
sha256sum --check java-run.sha256
```

确认输出 `java-run: OK` 后，再检查版本并安装：

```sh
chmod +x java-run
./java-run version
mkdir -p "$HOME/.local/bin"
cp java-run "$HOME/.local/bin/java-run"
export PATH="$HOME/.local/bin:$PATH"
java-run version
```

`chmod +x` 确保可执行权限。把上述 `export PATH` 加入当前 shell 的配置文件（如 `~/.zshrc` 或 `~/.bashrc`），使之后的终端也能找到命令。这种安装方式只写入当前用户目录，无需 `sudo`。

## Windows

下载 `java-run-windows-x64.zip` 和同一版本的 `SHA256SUMS`，在下载目录中打开 PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 .\java-run-windows-x64.zip
```

将结果与 `SHA256SUMS` 中 `java-run-windows-x64.zip` 对应的值核对，比较时忽略字母大小写。一致后解压并核对二进制：

```powershell
Expand-Archive -Path .\java-run-windows-x64.zip -DestinationPath .\java-run-download
Set-Location .\java-run-download\java-run-windows-x64
$expectedHash = ((Get-Content -Raw .\java-run.exe.sha256) -split '\s+')[0]
if ((Get-FileHash -Algorithm SHA256 .\java-run.exe).Hash -ne $expectedHash) {
    throw 'java-run.exe SHA-256 校验失败'
}
```

校验通过后，在同一目录检查版本并安装：

```powershell
& .\java-run.exe version
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\java-run'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Force .\java-run.exe $installDir
$env:Path = "$installDir;$env:Path"
java-run version
```

在“编辑账户的环境变量”中，将 `%LOCALAPPDATA%\Programs\java-run` 加入用户的 `Path`，随后打开新终端验证 `java-run version`。安装到当前用户目录无需管理员权限。

## 使用与升级

在 Java 项目根目录执行 `java-run`；需要查看选项时执行 `java-run help`。多模块或多个主类的选择、应用参数与项目配置见 [项目 README](https://github.com/Vanisper/java-run#readme)。

升级时下载所选版本的 ZIP 与校验和，完成上述核对和版本检查，再替换 PATH 中已有的可执行文件。Windows 先退出正在使用该可执行文件的进程。升级后运行 `java-run version`，确认结果与所选 Release 的版本一致；回退也可按同样步骤安装指定旧版本。

从源码构建与参与开发见 [项目仓库](https://github.com/Vanisper/java-run)。
