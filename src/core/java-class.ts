const CLASS_NAME = /^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Mn}\p{Mc}\p{Nd}\p{Cf}]*(?:\.[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Mn}\p{Mc}\p{Nd}\p{Cf}]*)*$/u;

/** 校验传统 Java 类全名，支持 Unicode 标识符和内部类名 */
export function isJavaClassName(value: string): boolean {
  return CLASS_NAME.test(value);
}
