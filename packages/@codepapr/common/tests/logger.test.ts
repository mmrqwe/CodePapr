import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, type LogRecord, type LogSink } from '../src';

describe('Logger', () => {
  afterEach(() => {
    Logger.resetSinks();
    Logger.setLevel('info');
  });

  it('routes info/warn/error/debug records through registered sinks with structured payload', () => {
    const records: LogRecord[] = [];
    const captureSink: LogSink = { write: (record) => records.push(record) };
    Logger.setSinks([captureSink]);
    Logger.setLevel('debug');

    const log = new Logger('Test');
    log.info('hello', { a: 1 });
    log.warn('careful');
    log.error('boom', new Error('oops'));
    log.debug('details', 'payload');

    expect(records.map((r) => r.level)).toEqual(['info', 'warn', 'error', 'debug']);
    expect(records.every((r) => r.prefix === 'Test')).toBe(true);
    expect(records.every((r) => typeof r.timestamp === 'number')).toBe(true);
    expect(records[0]?.data).toEqual({ a: 1 });
    expect(records[2]?.data).toBeInstanceOf(Error);
  });

  it('drops records below the configured level before reaching sinks', () => {
    const records: LogRecord[] = [];
    Logger.setSinks([{ write: (record) => records.push(record) }]);
    Logger.setLevel('warn');

    const log = new Logger('Filter');
    log.debug('skip-debug');
    log.info('skip-info');
    log.warn('keep-warn');
    log.error('keep-error');

    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('silent level disables every channel', () => {
    const records: LogRecord[] = [];
    Logger.setSinks([{ write: (record) => records.push(record) }]);
    Logger.setLevel('silent');

    const log = new Logger('Silent');
    log.error('still dropped');

    expect(records).toHaveLength(0);
  });

  it('keeps emitting to remaining sinks when one sink throws', () => {
    const records: LogRecord[] = [];
    const throwingSink: LogSink = {
      write: () => {
        throw new Error('sink down');
      },
    };
    Logger.setSinks([throwingSink, { write: (record) => records.push(record) }]);
    Logger.setLevel('info');

    const log = new Logger('Resilient');
    expect(() => log.info('still works')).not.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]?.message).toBe('still works');
  });

  it('addSink/removeSink manage sinks alongside the default console sink', () => {
    Logger.resetSinks();
    const records: LogRecord[] = [];
    const extra: LogSink = { write: (record) => records.push(record) };
    Logger.addSink(extra);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    new Logger('Mix').info('routed');
    expect(records).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalled();

    expect(Logger.removeSink(extra)).toBe(true);
    records.length = 0;
    new Logger('Mix').info('after-remove');
    expect(records).toHaveLength(0);

    consoleSpy.mockRestore();
  });
});
