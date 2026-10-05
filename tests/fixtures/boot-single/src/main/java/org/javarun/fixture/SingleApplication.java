package org.javarun.fixture;

import java.util.Arrays;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

/** 单模块启动契约夹具 */
@SpringBootApplication
public class SingleApplication {
    public static void main(String[] args) {
        try (ConfigurableApplicationContext context = SpringApplication.run(SingleApplication.class, args)) {
            System.out.println("[fixture] kind=boot-single");
            System.out.println("[fixture] spring-profile=" + String.join(",", context.getEnvironment().getActiveProfiles()));
            System.out.println("[fixture] maven-profile=" + context.getEnvironment().getProperty("fixture.maven.profile"));
            System.out.println("[fixture] jvm-value=" + System.getProperty("fixture.jvm", "absent"));
            for (String arg : args) {
                System.out.println("[fixture] arg=" + arg);
            }
            System.out.println("[fixture] test-dependency=" + presence("org.apache.commons.lang3.StringUtils"));
            System.out.println("[fixture] test-class=" + presence("org.javarun.fixture.SingleTestMarker"));
            if (Arrays.asList(args).contains("--exit=7")) {
                System.exit(7);
            }
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
