// ============================================================
// 文本分块器 — 按段落语义分块，保持上下文连贯
// ============================================================

export interface ChunkOptions {
  /** 目标块大小（字符数），默认 2000 */
  chunkSize?: number;
  /** 块间重叠（字符数），默认 200 */
  overlap?: number;
}

export interface TextChunk {
  /** 块内容 */
  text: string;
  /** 在原文中的起始位置 */
  start: number;
  /** 在原文中的结束位置 */
  end: number;
  /** 块索引 */
  index: number;
}

/**
 * 将长文本分割为带重叠的 chunk。
 * 优先在段落（\n\n）边界切割，其次在换行符处切割。
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const { chunkSize = 2000, overlap = 200 } = options;

  if (text.length <= chunkSize) {
    return [{ text, start: 0, end: text.length, index: 0 }];
  }

  const chunks: TextChunk[] = [];
  let pos = 0;
  let index = 0;

  while (pos < text.length) {
    let end = Math.min(pos + chunkSize, text.length);

    // 如果不是最后一块，尝试在段落或换行边界切割
    if (end < text.length) {
      end = findBestBreak(text, pos, end);
    }

    chunks.push({
      text: text.slice(pos, end),
      start: pos,
      end,
      index: index++,
    });

    // 下一块的起始位置：往回退 overlap 字符
    const nextPos = end - overlap;
    pos = nextPos > pos ? nextPos : end; // 防止死循环
  }

  return chunks;
}

/**
 * 在 [start, maxEnd] 范围内找到最佳断点。
 * 优先找段落分隔（\n\n），其次找换行（\n），最后硬切。
 */
function findBestBreak(text: string, start: number, maxEnd: number): number {
  // 在末尾向前搜索最近的段落分隔符
  const searchStart = Math.max(maxEnd - 500, start + 500); // 至少保留 500 字

  // 1. 找段落分隔
  const paragraphBreak = text.lastIndexOf('\n\n', maxEnd);
  if (paragraphBreak > searchStart) {
    return paragraphBreak + 2; // 包含分隔符
  }

  // 2. 找换行
  const lineBreak = text.lastIndexOf('\n', maxEnd);
  if (lineBreak > searchStart) {
    return lineBreak + 1;
  }

  // 3. 找句号/问号/感叹号
  for (let i = maxEnd; i > searchStart; i--) {
    const ch = text[i];
    if (ch === '。' || ch === '？' || ch === '！' || ch === '.' || ch === '?' || ch === '!') {
      return i + 1;
    }
  }

  // 4. 硬切
  return maxEnd;
}
