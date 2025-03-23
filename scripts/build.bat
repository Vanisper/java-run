@echo off
REM 保存当前目录
set "ORIGINAL_DIR=%cd%"

REM 切换到 bat 所在目录
pushd "%~dp0"

REM 执行编译命令（核心操作）
bun build ..\src\cli.ts --compile --outfile ..\dist\java-run

REM 还原到原始目录
popd

REM 可选：清除临时变量
set "ORIGINAL_DIR="