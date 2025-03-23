import { Colors } from "./colors";

export const defaultConfig = {
  mainClass: "org.jeecg.JeecgSystemApplication",
  profilesActive: "dev",
}

export default () => {
  console.log(`
  ${Colors.FgGreen}${'='.repeat(60)}
  ${Colors.Bright}    Spring Boot 项目快捷启动工具    ${Colors.Reset}
  ${Colors.FgGreen}${'='.repeat(60)}${Colors.Reset}
  
  ${Colors.FgCyan}Usage:${Colors.Reset}
    java-run [script] [options]

  ${Colors.FgCyan}Options:${Colors.Reset}
    ${Colors.FgYellow}start${Colors.Reset}                  执行脚本程序，不指定时会显示此帮助信息
    ${Colors.FgYellow}not-run, no-run${Colors.Reset}        不运行主程序，仅执行其他操作
    ${Colors.FgYellow}-r${Colors.Reset}                     强制刷新项目依赖 class-paths 缓存
    ${Colors.FgYellow}main <class>${Colors.Reset}           指定启动类 (默认: ${Colors.FgMagenta}${defaultConfig.mainClass}${Colors.Reset})
    ${Colors.FgYellow}active <profile>${Colors.Reset}       指定激活的配置文件 (默认: ${Colors.FgMagenta}${defaultConfig.profilesActive}${Colors.Reset})
    ${Colors.FgYellow}local${Colors.Reset}                  启用本地配置，组合使用时格式为 local-<profile>
                              (示例: ${Colors.FgBlue}active=dev local → 最终生效: local-dev${Colors.Reset})
    ${Colors.FgYellow}-h, --help${Colors.Reset}             显示本帮助信息

  ${Colors.FgGreen}${'-'.repeat(60)}${Colors.Reset}
  ${Colors.FgCyan}示例：${Colors.Reset}
    ${Colors.FgBlue}# 使用默认配置启动${Colors.Reset}
    java-run start
  
    ${Colors.FgBlue}# 指定测试环境配置并强制刷新缓存${Colors.Reset}
    java-run start active=test -r
  
    ${Colors.FgBlue}# 使用缓存生成 cp-jar 包，不运行 java 主程序，并使用 local-prod 配置${Colors.Reset}
    java-run start no-run active=prod local
  ${Colors.FgGreen}${'-'.repeat(60)}${Colors.Reset}
`);
  process.exit(0); // 显示帮助后退出
}
