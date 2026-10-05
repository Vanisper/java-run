package org.javarun.fixture;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
            properties.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
        }
        System.out.println("[fixture] kind=plain");
        System.out.println("[fixture] dependency-version=" + IOUtils.class.getPackage().getImplementationVersion());
        System.out.println("[fixture] maven-profile=" + properties.getProperty("fixture.maven.profile"));
        System.out.println("[fixture] maven-config=" + properties.getProperty("fixture.maven.config"));
        Path mavenRoot = Path.of(properties.getProperty("fixture.maven.root"));
        System.out.println("[fixture] maven-root-absolute=" + mavenRoot.isAbsolute());
        System.out.println("[fixture] maven-root-config=" + (Files.isRegularFile(mavenRoot.resolve(".mvn/maven.config")) ? "present" : "absent"));
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
