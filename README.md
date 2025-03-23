# java-run

## 项目说明

本项目的立项目的是为了脱离对 java 编辑器的重度依赖，而实现的一个 java 项目启动脚本。

起初笔者尝试使用过 bat 或者 shell 编写过脚本，但是考虑到跨平台的需求，加上脚本实现有些困难，故使用 ts 作为脚本书写语言。

本项目使用 [Bun](https://bun.sh) 创建，可直接编译二进制文件，可执行 `bun run compile`，前往 `dist` 目录查看编译后的二进制文件。

## Todo

> 当前此程序服务于一个 jeecg 项目，本质上是 `spring-boot` 的多模块项目。
>
> 是否通用于 `spring-boot` 项目，还待进一步测试。
>

- [-] spring-boot

## Other

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

This project was created using `bun init` in bun v1.1.39. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
