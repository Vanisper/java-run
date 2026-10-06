/**
 * 按接收顺序为原始字节的每个物理行添加前缀
 *
 * @description 保留跨块状态，不解码字节或重置 ANSI 样式；CRLF 之间不插入前缀
 */
export function createLinePrefixer(prefix: string): {
  /** 空块不产生输出，末尾换行后的前缀延迟到下一块 */
  push(data: Buffer): Buffer;
  /** 调用方补齐行边界后，将下一块视为新行 */
  reset(): void;
} {
  const prefixBytes = Buffer.from(prefix);
  let lineStart = true;
  let afterCR = false;

  return {
    push(data) {
      if (!data.length) return data;
      const segments: Buffer[] = [];
      let start = 0;
      for (let index = 0; index < data.length; index++) {
        const byte = data[index]!;
        if (lineStart && !(afterCR && byte === 10) && prefixBytes.length) {
          if (start < index) segments.push(data.subarray(start, index));
          segments.push(prefixBytes);
          start = index;
        }
        lineStart = byte === 10 || byte === 13;
        afterCR = byte === 13;
      }
      if (!segments.length) return data;
      segments.push(data.subarray(start));
      return Buffer.concat(segments);
    },
    reset() {
      lineStart = true;
      afterCR = false;
    },
  };
}
