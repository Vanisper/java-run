# 多个 main 入口

这是一个 Java 17 的单模块 Maven 项目，包含两个传统 `public static void main(String[])` 入口，未声明默认主类：

- `com.example.HelloApplication`
- `com.example.ReportApplication`

两个入口分别输出自己的类名和收到的参数，不依赖业务库。
运行需要 JDK 17 或更新版本，以及 Maven。
按 [安装指南](../../docs/installation.md) 将 java-run 加入 PATH 后，在 java-run 仓库根目录执行下面的命令。

## 在终端选择入口

运行示例并传入两个应用参数：

```sh
java-run --cwd examples/multiple-main -- --format=table "hello world"
```

java-run 自动编译项目。
在标准输入与标准错误均连接终端时，两个入口会按类名排列为候选：

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

`--` 后的参数传给所选入口。
`hello world` 是一个参数，终端选择不会改变参数边界。

## 明确指定入口

脚本、CI 或重定向输入的环境使用 `--main`，无需菜单：

```sh
java-run --cwd examples/multiple-main \
  --main=com.example.HelloApplication -- --name=Alice
```

输出为：

```text
entry=com.example.HelloApplication
args=[--name=Alice]
```

非交互环境既没有保存主类、也没有传入 `--main` 时，java-run 会列出两个候选并要求明确入口，避免等待终端输入。

## 保存入口与参数

使用 `init` 将选择结果保存到示例项目的 `.java-run.json`：

```sh
java-run init --cwd examples/multiple-main -- --format=table "hello world"
```

此命令同样编译项目并显示两个主类。
输入 `2` 后保存 `ReportApplication` 和应用参数，此时不运行应用。
随后执行：

```sh
java-run --cwd examples/multiple-main
```

java-run 直接运行保存的入口，不再显示主类菜单：

```text
entry=com.example.ReportApplication
args=[--format=table, hello world]
```

重复初始化默认保留已有文件并报错。
需要重新选择时使用 `init --force`，原配置中的入口和参数会被本次选择及选项替换；取消或准备失败时保留原文件。

## 从源码运行示例

使用仓库中 [`.bun-version`](../../.bun-version) 指定的 Bun 版本，在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run src/cli.ts --cwd examples/multiple-main
```

也可以编译后运行：

```sh
bun run compile
./dist/java-run --cwd examples/multiple-main
```

其他示例的参数保持相同，只需将 `java-run` 换成 `bun run src/cli.ts` 或 `./dist/java-run`。
Windows 二进制路径使用 `./dist/java-run.exe`。
