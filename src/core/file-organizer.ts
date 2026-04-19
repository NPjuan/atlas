/**
 * 文件迁移规划器
 *
 * 根据笔记 tags 计算它应该放到哪个文件夹，输出 FileMoveAction 清单。
 *
 * 纯函数 + 单测友好。实际的文件操作（app.fileManager.renameFile）由调用方完成。
 */

// ============================================================
// 类型
// ============================================================

/** 输入：一个笔记的当前状态 */
export interface FileInput {
  /** 笔记当前完整路径（含文件夹 + 文件名，如 `前端笔记/React-Hooks.md`） */
  currentPath: string;
  /** 该笔记的所有 tags（frontmatter 里写的，完整路径如 `前端开发/React`） */
  tags: string[];
}

/** 单个迁移动作 */
export interface FileMoveAction {
  /** 源路径 */
  fromPath: string;
  /** 目标路径（vault 根 + 分类路径 + 文件名） */
  toPath: string;
  /** 用于决定目标的那条 tag */
  chosenTag: string;
  /** 该笔记所有 tag（> 1 时说明用户可能需要选主路径） */
  allTags: string[];
  /** 是否需要用户介入选主路径（tag > 1 且多个 tag 都指向不同目录） */
  needsUserPickTag: boolean;
  /** 目标已存在同名文件 */
  hasNameConflict: boolean;
  /** 跳过：源 == 目标（已经在正确位置） */
  alreadyInPlace: boolean;
}

/** 冲突解决策略（用户在 Modal 选的） */
export type ConflictResolution = 'skip' | 'overwrite' | 'rename';

// ============================================================
// 规划
// ============================================================

/**
 * 根据 tag 算目标路径。
 *
 * - tag=`前端开发/React`，文件名=`React-Hooks.md`
 *   → toPath = `前端开发/React/React-Hooks.md`
 */
export function computeTargetPath(tag: string, fileName: string): string {
  // 清掉 tag 里可能的空白/尾斜杠
  const cleanTag = tag.trim().replace(/\/+$/, '');
  if (!cleanTag) return fileName;
  return `${cleanTag}/${fileName}`;
}

/** 从完整路径里取出文件名（含扩展名） */
export function extractFileName(fullPath: string): string {
  const idx = fullPath.lastIndexOf('/');
  return idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
}

/**
 * 规划一批文件的迁移动作。
 *
 * @param inputs 待处理的笔记列表
 * @param existingFiles vault 里所有现存文件路径的集合（用于冲突检测）
 * @returns FileMoveAction[]：每篇笔记一条记录（含不需动的）
 */
export function planFileMoves(
  inputs: FileInput[],
  existingFiles: Set<string>,
): FileMoveAction[] {
  // 先模拟这批迁移完成后的"占用"状态，用于后续条目检测冲突
  // （避免两篇同名笔记同时被规划到同一目标路径却都说"无冲突"）
  const occupied = new Set<string>(existingFiles);

  const actions: FileMoveAction[] = [];

  for (const inp of inputs) {
    const tags = inp.tags.filter(t => typeof t === 'string' && t.trim());
    const fileName = extractFileName(inp.currentPath);

    if (tags.length === 0) {
      // 无 tag 不动
      actions.push({
        fromPath: inp.currentPath,
        toPath: inp.currentPath,
        chosenTag: '',
        allTags: [],
        needsUserPickTag: false,
        hasNameConflict: false,
        alreadyInPlace: true,
      });
      continue;
    }

    // 默认取 tags[0] 作为主路径
    const chosenTag = tags[0];
    const toPath = computeTargetPath(chosenTag, fileName);
    const alreadyInPlace = toPath === inp.currentPath;

    // 冲突：目标路径已被 vault 其他文件占用（且不是当前文件自己）
    const hasNameConflict =
      !alreadyInPlace &&
      occupied.has(toPath) &&
      toPath !== inp.currentPath;

    // 多 tag 且各 tag 算出的目标路径不同 → 需要用户选
    const targetSet = new Set(tags.map(t => computeTargetPath(t, fileName)));
    const needsUserPickTag = targetSet.size > 1;

    actions.push({
      fromPath: inp.currentPath,
      toPath,
      chosenTag,
      allTags: tags,
      needsUserPickTag,
      hasNameConflict,
      alreadyInPlace,
    });

    // 如果没冲突，预约该目标路径（避免后续条目误判为无冲突）
    if (!alreadyInPlace && !hasNameConflict) {
      occupied.add(toPath);
      occupied.delete(inp.currentPath);  // 源路径解放
    }
  }

  return actions;
}

/**
 * 根据冲突解决策略重算某条动作的 toPath。
 *
 * - skip：toPath 不变，但 caller 应该不执行这条
 * - overwrite：toPath 不变，caller 执行 overwrite
 * - rename：给 toPath 加时间戳后缀
 */
export function resolveConflict(
  action: FileMoveAction,
  strategy: ConflictResolution,
): FileMoveAction {
  if (!action.hasNameConflict) return action;
  if (strategy !== 'rename') return action;

  const lastSlash = action.toPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? action.toPath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? action.toPath.slice(lastSlash + 1) : action.toPath;
  const dotIdx = fileName.lastIndexOf('.');
  const stem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  const ext = dotIdx > 0 ? fileName.slice(dotIdx) : '';

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');  // YYYYMMDD
  const newName = `${stem}-${stamp}${ext}`;
  const newToPath = dir ? `${dir}/${newName}` : newName;

  return { ...action, toPath: newToPath, hasNameConflict: false };
}

/**
 * 从 toPath 提取所有需要创建的中间文件夹（相对 vault 根）。
 * 用于 caller 在 rename 前先 ensureFolder。
 *
 * `前端开发/React/Hooks.md` → ['前端开发', '前端开发/React']
 */
export function collectFoldersToCreate(toPath: string): string[] {
  const lastSlash = toPath.lastIndexOf('/');
  if (lastSlash < 0) return [];
  const dir = toPath.slice(0, lastSlash);
  const parts = dir.split('/').filter(Boolean);
  const folders: string[] = [];
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    folders.push(acc);
  }
  return folders;
}
