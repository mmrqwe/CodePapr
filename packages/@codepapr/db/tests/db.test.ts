import { describe, it, expect } from 'vitest';
import { DSDatabase } from '../src/Database';
import { SessionRepository } from '../src/repository/SessionRepository';
import { MessageRepository } from '../src/repository/MessageRepository';
import { CacheStatsRepository } from '../src/repository/CacheStatsRepository';

function makeDB(): DSDatabase {
  const db = new DSDatabase(':memory:');
  db.init();
  return db;
}

describe('SessionRepository', () => {
  it('create + get 会话', () => {
    const db = makeDB();
    const repo = new SessionRepository(db);
    const id = repo.create({
      model: 'deepseek-chat',
      provider: 'deepseek',
      tools: [],
      systemPrompt: 'hi',
      parameters: {},
      isPrefixFrozen: true,
      prefixHash: 'abc',
    });
    const s = repo.get(id);
    expect(s).not.toBeNull();
    expect(s!.model).toBe('deepseek-chat');
    expect(s!.prefixHash).toBe('abc');
    db.close();
  });

  it('list 返回所有会话', () => {
    const db = makeDB();
    const repo = new SessionRepository(db);
    repo.create({
      model: 'm1',
      provider: 'deepseek',
      tools: [],
      systemPrompt: 'p',
      parameters: {},
      isPrefixFrozen: true,
    });
    repo.create({
      model: 'm2',
      provider: 'openai',
      tools: [],
      systemPrompt: 'p',
      parameters: {},
      isPrefixFrozen: true,
    });
    expect(repo.list().length).toBe(2);
    db.close();
  });
});

describe('MessageRepository - append-only', () => {
  it('索引连续追加成功', () => {
    const db = makeDB();
    const sRepo = new SessionRepository(db);
    const mRepo = new MessageRepository(db);
    const sid = sRepo.create({
      model: 'm',
      provider: 'deepseek',
      tools: [],
      systemPrompt: 'p',
      parameters: {},
      isPrefixFrozen: true,
    });
    mRepo.append(
      sid,
      { id: 'a', role: 'user', content: 'hi', timestamp: 1 },
      0
    );
    mRepo.append(
      sid,
      { id: 'b', role: 'assistant', content: 'ok', timestamp: 2 },
      1
    );
    expect(mRepo.getCount(sid)).toBe(2);
    expect(mRepo.validateContinuity(sid)).toBe(true);
    db.close();
  });

  it('索引不连续抛出 AppendOnlyViolationError', () => {
    const db = makeDB();
    const sRepo = new SessionRepository(db);
    const mRepo = new MessageRepository(db);
    const sid = sRepo.create({
      model: 'm',
      provider: 'deepseek',
      tools: [],
      systemPrompt: 'p',
      parameters: {},
      isPrefixFrozen: true,
    });
    expect(() =>
      mRepo.append(
        sid,
        { id: 'a', role: 'user', content: 'hi', timestamp: 1 },
        5
      )
    ).toThrow();
    db.close();
  });
});

describe('CacheStatsRepository', () => {
  it('save + aggregate', () => {
    const db = makeDB();
    const sRepo = new SessionRepository(db);
    const cRepo = new CacheStatsRepository(db);
    const sid = sRepo.create({
      model: 'm',
      provider: 'deepseek',
      tools: [],
      systemPrompt: 'p',
      parameters: {},
      isPrefixFrozen: true,
    });
    cRepo.save(sid, {
      cacheCreationTokens: 100,
      cacheReadTokens: 0,
      newInputTokens: 50,
      outputTokens: 30,
      cacheHitRate: 0,
    });
    cRepo.save(sid, {
      cacheCreationTokens: 0,
      cacheReadTokens: 150,
      newInputTokens: 10,
      outputTokens: 40,
      cacheHitRate: 0.93,
    });
    const agg = cRepo.getAggregate(sid);
    expect(agg.count).toBe(2);
    expect(agg.totalCacheRead).toBe(150);
    db.close();
  });
});
