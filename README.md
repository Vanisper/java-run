# java-run

## 项目说明

本项目的立项目的是为了脱离对 java 编辑器的重度依赖，而实现的一个 java 项目启动脚本。

起初笔者尝试使用过 bat 或者 shell 编写过脚本，但是考虑到跨平台的需求，加上脚本实现有些困难，故使用 ts 作为脚本书写语言。

本项目使用 [Bun](https://bun.sh) 创建，可直接编译二进制文件，可执行 `bun run compile`，前往 `dist` 目录查看编译后的二进制文件。

## Todo

> 当前此程序服务于一个 Jeecg 项目，本质上是 Spring Boot 的多模块项目。
>
> 是否可通用于通用的 Spring Boot 多模块/单模块项目，还需进一步验证。
>
当前项目的任务与进展：

- [x] 递归解析 Maven pom.xml，识别多模块并提取叶子模块
- [x] 调用 mvn dependency:build-classpath 构建依赖并做缓存（可用 -r 刷新）
- [x] 汇总 target/classes 与依赖到 Manifest，生成 cp.jar 并通过 -classpath 运行
- [x] 支持指定 main=<class>、active=<profile>，以及 local 前缀组合（local-<profile>）
- [x] 可选执行 mvn compile（-c 或 compile）
- [x] 跨平台路径分隔符兼容（Windows/Linux/Mac）
- [ ] 在非 Jeecg 的通用 Spring Boot 项目中验证可用性并完善兼容性
- [ ] 可配置是否包含测试类路径（includeTests）
- [ ] 更完善的错误提示、日志与失败恢复策略
- [ ] 增加单元测试与文档示例，完善 README 使用说明

## Tips

1. 使用本脚本程序之前，确保主机环境存在 `java` 和 `maven` 环境。

2. 确保事先执行过 `mvn compile`，或者可以在使用本脚本程序时，加入 `-c` 传参，详情可以查看 cli 的 `help-log`。

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
