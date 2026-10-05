package org.javarun.fixture;

/** 被误启动时令 smoke 明确失败 */
public final class OtherApplication {
    public static void main(String[] args) {
        System.out.println("[fixture] FORBIDDEN_OTHER_APP");
        System.exit(23);
    }
}
