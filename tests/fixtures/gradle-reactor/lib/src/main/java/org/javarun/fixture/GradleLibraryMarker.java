package org.javarun.fixture;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/** 从 Gradle 依赖项目的资源读取实际产物标记 */
public final class GradleLibraryMarker {
    private GradleLibraryMarker() {
    }

    public static String value(String name) throws IOException {
        Properties properties = new Properties();
        try (InputStream stream = GradleLibraryMarker.class.getResourceAsStream("/library.properties")) {
            if (stream == null) {
                throw new IOException("library.properties missing");
            }
            properties.load(stream);
        }
        return properties.getProperty(name);
    }
}
