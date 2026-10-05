package org.javarun.fixture;

import java.io.InputStream;
import java.util.Arrays;
import java.util.Properties;
import org.apache.commons.io.IOUtils;

/** 验证 Gradle application 主类、依赖项目和测试类路径 */
public final class GradleApplication {
    public static void main(String[] args) throws Exception {
        Properties properties = new Properties();
        try (InputStream stream = GradleApplication.class.getResourceAsStream("/fixture.properties")) {
            if (stream == null) {
                throw new IllegalStateException("fixture.properties missing");
            }
            properties.load(stream);
        }
        System.out.println("[fixture] kind=gradle-reactor-app");
        System.out.println("[fixture] library=" + GradleLibraryMarker.value("library.marker"));
        System.out.println("[fixture] library-version=" + GradleLibraryMarker.value("library.version"));
        System.out.println("[fixture] dependency-version=" + IOUtils.class.getPackage().getImplementationVersion());
        System.out.println("[fixture] gradle-profile=" + properties.getProperty("fixture.gradle.profile"));
        System.out.println("[fixture] jvm-value=" + System.getProperty("fixture.jvm", "absent"));
        for (String arg : args) {
            System.out.println("[fixture] arg=" + arg);
        }
        System.out.println("[fixture] test-dependency=" + presence("org.apache.commons.lang3.StringUtils"));
        System.out.println("[fixture] test-class=" + presence("org.javarun.fixture.GradleTestMarker"));
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
