# 多个 main 入口

这是一个 Java 17 的单模块 Maven 项目，包含两个传统 `public static void main(String[])` 入口，未声明默认主类：

- `com.example.HelloApplication`
- `com.example.ReportApplication`

两个入口分别输出自己的类名和收到的参数，不依赖业务库。运行需要 JDK 17 或更新版本，以及 Maven；从 java-run 源码运行还需要根目录 [README](../../README.md#快速开始) 指定的 Bun。

## 在终端选择入口

在 java-run 仓库根目录安装依赖，然后运行示例：

```sh
bun install --frozen-lockfile
bun run src/cli.ts --cwd examples/multiple-main -- --format=table "hello world"
```

java-run 自动编译项目。在标准输入与标准错误均连接终端时，两个入口会按类名排列为候选：

```text
选择启动主类
  1. com.example.HelloApplication
  2. com.example.ReportApplication
选择 [1-2]：
```

输入 `2` 并回车，`ReportApplication` 会运行并输出：

```text
entry=com.example.ReportApplication
args=[--format=table, hello world]
```

`--` 后的参数传给所选入口。`hello world` 是一个参数，终端选择不会改变参数边界。

也可以使用编译后的 java-run 二进制。在 java-run 仓库根目录执行：

```sh
bun run compile
./dist/java-run --cwd examples/multiple-main -- --format=table "hello world"
```

Windows 使用 `./dist/java-run.exe`。把二进制放入 PATH 后，可将上述命令中的 `./dist/java-run` 换为 `java-run`。

## 明确指定入口

脚本、CI 或重定向输入的环境使用 `--main`，无需菜单：

```sh
bun run src/cli.ts --cwd examples/multiple-main \
  --main=com.example.HelloApplication -- --name=Alice
```

输出为：

```text
entry=com.example.HelloApplication
args=[--name=Alice]
```

二进制用法相同：

```sh
./dist/java-run --cwd examples/multiple-main \
  --main=com.example.ReportApplication -- --format=json
```

非交互环境未指定主类时，java-run 会列出两个候选并要求明确入口，避免等待终端输入。
