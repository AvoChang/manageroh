import { db, nowIso } from './index.js';

export interface SessionRow {
  user_id: string;
  workday: string;
  /** 대화가 지금 어느 단계인가. 한 번만 묻는 대화는 ask | complete 두 개뿐이다. */
  stage: string;
  channel_id: string;
  /** 답변 메시지. 사용자가 그걸 편집하면 여기로 되찾아 간다. */
  answer_ts: string | null;
  started_at: string;
  updated_at: string;
}

export interface SessionStore {
  get(userId: string, workday: string): SessionRow | undefined;
  open(userId: string): SessionRow | undefined;
  start(userId: string, workday: string, channelId: string): SessionRow;
  complete(userId: string, workday: string, answerTs?: string): void;
  findByAnswerTs(userId: string, messageTs: string): SessionRow | undefined;
  abandonStale(beforeWorkday: string): void;
}

/**
 * "봇이 묻고 사용자가 한 번 답하는" 대화의 저장소.
 *
 * 체크인·중간 점검이 같은 모양이라 테이블 이름만 갈아 끼운다.
 * 이걸 안 하면 거의 똑같은 파일이 질문 종류마다 하나씩 늘어난다.
 *
 * `table` 은 코드 안에 박힌 리터럴만 들어온다 (사용자 입력이 닿지 않는다).
 */
export function makeSessionStore(table: string): SessionStore {
  return {
    get(userId, workday) {
      return db()
        .prepare<[string, string], SessionRow>(
          `SELECT * FROM ${table} WHERE user_id = ? AND workday = ?`,
        )
        .get(userId, workday);
    },

    open(userId) {
      return db()
        .prepare<[string], SessionRow>(
          `SELECT * FROM ${table}
           WHERE user_id = ? AND stage != 'complete'
           ORDER BY workday DESC LIMIT 1`,
        )
        .get(userId);
    },

    start(userId, workday, channelId) {
      const ts = nowIso();
      db()
        .prepare(
          `INSERT INTO ${table} (user_id, workday, stage, channel_id, started_at, updated_at)
           VALUES (?, ?, 'ask', ?, ?, ?)
           ON CONFLICT(user_id, workday) DO UPDATE SET
             stage = 'ask', channel_id = excluded.channel_id,
             started_at = excluded.started_at, updated_at = excluded.updated_at`,
        )
        .run(userId, workday, channelId, ts, ts);
      return this.get(userId, workday)!;
    },

    complete(userId, workday, answerTs) {
      db()
        .prepare(
          `UPDATE ${table} SET stage = 'complete', answer_ts = COALESCE(?, answer_ts), updated_at = ?
           WHERE user_id = ? AND workday = ?`,
        )
        .run(answerTs ?? null, nowIso(), userId, workday);
    },

    findByAnswerTs(userId, messageTs) {
      return db()
        .prepare<[string, string], SessionRow>(
          `SELECT * FROM ${table} WHERE user_id = ? AND answer_ts = ? LIMIT 1`,
        )
        .get(userId, messageTs);
    },

    abandonStale(beforeWorkday) {
      db()
        .prepare(`UPDATE ${table} SET stage = 'complete' WHERE workday < ? AND stage != 'complete'`)
        .run(beforeWorkday);
    },
  };
}
