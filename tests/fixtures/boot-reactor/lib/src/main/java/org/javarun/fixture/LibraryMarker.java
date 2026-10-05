package org.javarun.fixture;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/** 从依赖模块的实际产物读取标记 */
public final class LibraryMarker {
    private LibraryMarker() {
    }

    public static String value(String name) throws IOException {
        Properties properties = new Properties();
        try (InputStream stream = LibraryMarker.class.getResourceAsStream("/library.properties")) {
            if (stream == null) {
                throw new IOException("library.properties missing");
            }
            properties.load(stream);
        }
        return properties.getProperty(name);
    }
}
