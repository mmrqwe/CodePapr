import { describe, it, expect, beforeEach } from 'vitest';
import { useToastStore, toast } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clearToasts();
  });

  it('appends a toast and assigns id', () => {
    const id = useToastStore.getState().showToast({
      variant: 'info',
      message: 'hello',
    });
    const list = useToastStore.getState().toasts;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].variant).toBe('info');
    expect(list[0].message).toBe('hello');
  });

  it('caps visible toasts to 5 and drops the oldest', () => {
    for (let i = 0; i < 7; i += 1) {
      toast.info(`msg-${i}`);
    }
    const list = useToastStore.getState().toasts;
    expect(list).toHaveLength(5);
    expect(list[0].message).toBe('msg-2');
    expect(list[4].message).toBe('msg-6');
  });

  it('dismissToast removes by id', () => {
    const id = toast.success('done');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('error variant defaults to a longer duration than info', () => {
    const errorId = toast.error('boom');
    const infoId = toast.info('hello');
    const all = useToastStore.getState().toasts;
    const errorItem = all.find((t) => t.id === errorId)!;
    const infoItem = all.find((t) => t.id === infoId)!;
    expect((errorItem.durationMs ?? 0)).toBeGreaterThan(infoItem.durationMs ?? 0);
  });

  it('clearToasts empties the list', () => {
    toast.info('a');
    toast.warning('b');
    useToastStore.getState().clearToasts();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
