package org.javarun.fixture;

import java.io.InputStream;
import java.util.Arrays;
import java.util.Properties;
import org.apache.commons.io.IOUtils;

/** 验证直接 Java 模式的类路径、参数和退出码 */
public final class PlainApplication {
    public static void main(String[] args) throws Exception {
        Properties properties = new Properties();
        try (InputStream stream = PlainApplication.class.getResourceAsStream("/fixture.properties")) {
            if (stream == null) {
                throw new IllegalStateException("fixture.properties missing");
            }
            properties.load(stream);
        }
        System.out.println("[fixture] kind=plain");
        System.out.println("[fixture] dependency-version=" + IOUtils.class.getPackage().getImplementationVersion());
        System.out.println("[fixture] maven-profile=" + properties.getProperty("fixture.maven.profile"));
        System.out.println("[fixture] spring-profile=" + System.getProperty("spring.profiles.active", "absent"));
        System.out.println("[fixture] jvm-value=" + System.getProperty("fixture.jvm", "absent"));
        for (String arg : args) {
            System.out.println("[fixture] arg=" + arg);
        }
        System.out.println("[fixture] test-dependency=" + presence("org.apache.commons.lang3.StringUtils"));
        System.out.println("[fixture] test-class=" + presence("org.javarun.fixture.PlainTestMarker"));
        if (Arrays.asList(args).contains("--exit=7")) {
            System.exit(7);
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
