import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { MIGRATIONS, SCHEMA } from './schema.js';

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;

  const path = config.databasePath;
  const absolute = path === ':memory:' ? path : resolve(path);
  const existedBefore = path !== ':memory:' && existsSync(absolute);
  if (path !== ':memory:') mkdirSync(dirname(absolute), { recursive: true });

  const conn = new Database(absolute);
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

  instance = conn;
  reportStorage(absolute, existedBefore);
  return conn;
}

/**
 * 부팅할 때 저장소 상태를 눈에 보이게 남긴다.
 *
 * 배포판에서 데이터가 통째로 날아간 적이 있다. 볼륨은 붙였는데 DATABASE_PATH 가
 * 그 마운트를 안 가리켜서, 컨테이너 안 임시 디스크에 쌓이고 있었다.
 * 로그만 봐도 그걸 알 수 있어야 한다.
 */
function reportStorage(absolute: string, existedBefore: boolean): void {
  if (absolute === ':memory:') {
    log.info('SQLite: 메모리 (테스트용)');
    return;
  }

  const size = existsSync(absolute) ? statSync(absolute).size : 0;
  log.info(
    `SQLite 열림: ${absolute} · ${existedBefore ? '기존 파일 이어서 씀' : '새로 만듦'} · ${size}바이트`,
  );

  const counts = ['users', 'tasks', 'standups', 'attendance', 'job_runs']
    .map((t) => {
      const row = instance!
        .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)
        .get();
      return `${t}=${row?.c ?? 0}`;
    })
    .join(' ');
  log.info(`저장된 행: ${counts}`);

  // 상대경로는 컨테이너 작업 디렉터리 안으로 떨어진다 — 재배포하면 사라진다.
  if (!config.databasePath.startsWith('/') && isHostedRuntime()) {
    log.warn(
      '⚠️ DATABASE_PATH 가 상대경로입니다. 배포 환경에서는 재배포할 때마다 데이터가 사라집니다.\n' +
        '   볼륨 마운트 경로를 절대경로로 지정하세요 (예: DATABASE_PATH=/data/worklife.sqlite).',
    );
  } else if (!existedBefore && isHostedRuntime()) {
    log.warn(
      `⚠️ ${absolute} 에 기존 DB 가 없어 새로 만들었습니다.\n` +
        '   직전 배포의 데이터가 있어야 한다면 볼륨이 이 경로에 붙어 있는지 확인하세요.',
    );
  }
}

/**
 * 배포 환경인가. 로컬에서 거짓 경보를 울리면 진짜 경고까지 무시하게 되므로
 * 플랫폼이 직접 넣어 주는 변수만 본다 (PORT 는 로컬에도 있어서 신호가 못 된다).
 */
function isHostedRuntime(): boolean {
  return Boolean(
    process.env['RAILWAY_ENVIRONMENT'] ??
      process.env['RAILWAY_PROJECT_ID'] ??
      process.env['RAILWAY_SERVICE_ID'] ??
      (process.env['NODE_ENV'] === 'production' ? '1' : undefined),
  );
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
