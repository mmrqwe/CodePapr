/**
 * editHistory: 真正的 undo/redo 编辑历史（纯逻辑）
 *
 * 在写文件/打补丁前记录文件的前后内容快照；undo 恢复到 before，redo 重做到 after。
 * 实际的文件读写由调用方完成，本模块只维护可撤销/重做的栈，便于在任何文件系统（Node / Tauri）上复用并独立测试。
 * before/after 为 null 表示该路径在此操作前/后不存在（undo 一个新建文件 => 删除）。
 */

export interface EditRecord {
  /** 相对项目根目录的文件路径 */
  path: string;
  /** 操作前内容；null 表示文件原本不存在 */
  before: string | null;
  /** 操作后内容；null 表示操作删除了文件 */
  after: string | null;
}

export interface RevertAction {
  path: string;
  /** 目标内容；null 表示应删除该文件 */
  content: string | null;
}

export class EditHistory {
  private readonly undoStack: EditRecord[] = [];
  private readonly redoStack: EditRecord[] = [];
  private readonly limit: number;

  constructor(limit = 100) {
    this.limit = Math.max(1, limit);
  }

  /** 记录一次编辑；记录后清空 redo 栈（标准编辑器语义）。 */
  record(record: EditRecord): void {
    this.undoStack.push(record);
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * 撤销最近一次编辑。返回需要写回的目标状态（恢复到 before），
   * 没有可撤销项时返回 null。
   */
  undo(): RevertAction | null {
    const record = this.undoStack.pop();
    if (!record) {
      return null;
    }
    this.redoStack.push(record);
    return { path: record.path, content: record.before };
  }

  /**
   * 重做最近一次被撤销的编辑。返回需要写回的目标状态（恢复到 after），
   * 没有可重做项时返回 null。
   */
  redo(): RevertAction | null {
    const record = this.redoStack.pop();
    if (!record) {
      return null;
    }
    this.undoStack.push(record);
    return { path: record.path, content: record.after };
  }

  /** 当前可撤销的编辑数量。 */
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** 当前可重做的编辑数量。 */
  get redoDepth(): number {
    return this.redoStack.length;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
