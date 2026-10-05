package org.javarun.fixture;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

/** 仅启动 app 并验证 lib 依赖的 reactor 夹具 */
@SpringBootApplication
public class ReactorApplication {
    public static void main(String[] args) throws Exception {
        try (ConfigurableApplicationContext context = SpringApplication.run(ReactorApplication.class, args)) {
            System.out.println("[fixture] kind=boot-reactor-app");
            System.out.println("[fixture] library=" + LibraryMarker.value("library.marker"));
            System.out.println("[fixture] library-version=" + LibraryMarker.value("library.version"));
            System.out.println("[fixture] spring-profile=" + String.join(",", context.getEnvironment().getActiveProfiles()));
            System.out.println("[fixture] maven-profile=" + context.getEnvironment().getProperty("fixture.maven.profile"));
            System.out.println("[fixture] jvm-value=" + System.getProperty("fixture.jvm", "absent"));
            for (String arg : args) {
                System.out.println("[fixture] arg=" + arg);
            }
            System.out.println("[fixture] test-dependency=" + presence("org.apache.commons.lang3.StringUtils"));
            System.out.println("[fixture] test-class=" + presence("org.javarun.fixture.ReactorTestMarker"));
        }
    }

    private static String presence(String className) {
        try {
            Class.forName(className);
            return "present";
        } catch (ClassNotFoundException ignored) {
            return "absent";
        }
    }
}
