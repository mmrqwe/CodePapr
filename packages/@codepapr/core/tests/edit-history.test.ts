import { describe, expect, it } from 'vitest';
import { EditHistory } from '../src/tool/editHistory';

describe('EditHistory - undo/redo', () => {
  it('初始状态不可撤销/重做', () => {
    const history = new EditHistory();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it('撤销返回 before 状态，重做返回 after 状态', () => {
    const history = new EditHistory();
    history.record({ path: 'a.ts', before: 'old', after: 'new' });
    expect(history.canUndo()).toBe(true);

    const undone = history.undo();
    expect(undone).toEqual({ path: 'a.ts', content: 'old' });
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    const redone = history.redo();
    expect(redone).toEqual({ path: 'a.ts', content: 'new' });
    expect(history.canRedo()).toBe(false);
  });

  it('新建文件的 before 为 null，撤销表示删除', () => {
    const history = new EditHistory();
    history.record({ path: 'new.ts', before: null, after: 'content' });
    expect(history.undo()).toEqual({ path: 'new.ts', content: null });
  });

  it('记录新编辑后清空 redo 栈', () => {
    const history = new EditHistory();
    history.record({ path: 'a.ts', before: '1', after: '2' });
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.record({ path: 'b.ts', before: 'x', after: 'y' });
    expect(history.canRedo()).toBe(false);
  });

  it('遵守容量上限', () => {
    const history = new EditHistory(2);
    history.record({ path: '1', before: null, after: '1' });
    history.record({ path: '2', before: null, after: '2' });
    history.record({ path: '3', before: null, after: '3' });
    expect(history.undoDepth).toBe(2);
  });

  it('多次连续撤销按 LIFO 顺序', () => {
    const history = new EditHistory();
    history.record({ path: 'a', before: 'a0', after: 'a1' });
    history.record({ path: 'b', before: 'b0', after: 'b1' });
    expect(history.undo()).toEqual({ path: 'b', content: 'b0' });
    expect(history.undo()).toEqual({ path: 'a', content: 'a0' });
  });
});
