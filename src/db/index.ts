import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { MIGRATIONS, SCHEMA } from './schema.js';

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;

  const path = config.databasePath;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  conn.exec(SCHEMA);

  for (const stmt of MIGRATIONS) {
    try {
      conn.exec(stmt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 이미 적용된 ALTER 는 정상 상태다 (추가는 duplicate, 삭제는 no such column).
      // 그 밖의 오류만 시끄럽게 알린다.
      if (!/duplicate column|already exists|no such column/i.test(message)) {
        log.error(`마이그레이션 실패: ${stmt}`, message);
        throw err;
      }
    }
  }

  log.info(`SQLite 열림: ${path}`);
  instance = conn;
  return conn;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
