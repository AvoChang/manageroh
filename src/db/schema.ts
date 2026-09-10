/**
 * 스키마. 전부 `IF NOT EXISTS` 라서 부팅할 때마다 그냥 다시 돌려도 안전하다.
 * 컬럼을 나중에 추가할 때는 아래 MIGRATIONS 배열에 ALTER 문을 덧붙이면 된다.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  slack_user_id    TEXT PRIMARY KEY,
  slack_team_id    TEXT,
  display_name     TEXT NOT NULL DEFAULT '',
  tz               TEXT NOT NULL,
  work_days        TEXT NOT NULL,              -- '1,2,3,4,5'
  checkin_time     TEXT NOT NULL,              -- 'HH:MM' 아침 리마인드
  standup_time     TEXT NOT NULL,              -- 'HH:MM' done-next 시작
  nudge_time       TEXT NOT NULL,              -- 'HH:MM' 미응답 넛지
  weekly_time      TEXT NOT NULL,              -- 금요일 주간보고
  dm_channel_id    TEXT,
  board_channel_id TEXT,                       -- 공개 보드 채널 (없으면 DM 만)
  share_to_board   INTEGER NOT NULL DEFAULT 1,
  paused_until     TEXT,                       -- 'YYYY-MM-DD' 까지 일시정지
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  target_date     TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | done | archived
  progress_mode   TEXT NOT NULL DEFAULT 'auto',    -- auto | manual
  manual_progress INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_milestones_user ON milestones(user_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  workday      TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planned',   -- planned | done | carried | dropped
  milestone_id INTEGER,
  source       TEXT NOT NULL DEFAULT 'checkin',   -- checkin | done | standup | plan
  created_at   TEXT NOT NULL,
  done_at      TEXT,
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE,
  FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_day ON tasks(user_id, workday);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestone_id);

-- 하루치 done-next 답변. 세 질문을 각각 통으로 보관한다.
CREATE TABLE IF NOT EXISTS standups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  workday      TEXT NOT NULL,
  done_text    TEXT NOT NULL DEFAULT '',   -- Q1 오늘 한 일
  next_text    TEXT NOT NULL DEFAULT '',   -- Q2 내일 할 일
  note_to_self TEXT NOT NULL DEFAULT '',   -- Q3 나에게 해주고 싶은 말
  blocker_text TEXT NOT NULL DEFAULT '',
  mood         INTEGER,
  submitted_at TEXT,                       -- Q3 까지 끝난 시각. 미완이면 NULL
  UNIQUE (user_id, workday),
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);

-- done-next 대화의 현재 위치. 봇이 "지금 몇 번 질문을 기다리는 중인가"를 안다.
CREATE TABLE IF NOT EXISTS standup_sessions (
  user_id    TEXT NOT NULL,
  workday    TEXT NOT NULL,
  stage      TEXT NOT NULL,               -- q1 | q2 | q3 | complete
  channel_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workday),
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_open ON standup_sessions(user_id, stage);

-- 오늘 할 일을 묻는 대화. done-next 와 같은 방식이지만 질문이 하나뿐이다.
CREATE TABLE IF NOT EXISTS checkin_sessions (
  user_id    TEXT NOT NULL,
  workday    TEXT NOT NULL,
  stage      TEXT NOT NULL,               -- ask | complete
  channel_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workday),
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checkin_open ON checkin_sessions(user_id, stage);

-- 출근/퇴근. 하루에 한 행. 여러 번 찍으면 첫 출근~마지막 퇴근으로 본다.
CREATE TABLE IF NOT EXISTS attendance (
  user_id        TEXT NOT NULL,
  workday        TEXT NOT NULL,
  clock_in       TEXT,                    -- ISO8601 (UTC)
  clock_out      TEXT,
  break_minutes  INTEGER NOT NULL DEFAULT 0,
  worked_minutes INTEGER,                 -- 휴게 제외한 결과. 퇴근 전에는 NULL
  auto_closed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, workday),
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attendance_day ON attendance(workday);

CREATE TABLE IF NOT EXISTS streaks (
  user_id      TEXT PRIMARY KEY,
  current      INTEGER NOT NULL DEFAULT 0,
  longest      INTEGER NOT NULL DEFAULT 0,
  last_workday TEXT,
  total_days   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(slack_user_id) ON DELETE CASCADE
);

-- 스케줄러 멱등성: 같은 (사용자, 잡, 날짜) 조합은 한 번만 실행된다.
-- Railway 재배포로 프로세스가 다시 떠도 그날 알림이 두 번 가지 않는다.
CREATE TABLE IF NOT EXISTS job_runs (
  user_id TEXT NOT NULL,
  job     TEXT NOT NULL,
  workday TEXT NOT NULL,
  ran_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, job, workday)
);
CREATE INDEX IF NOT EXISTS idx_job_runs_day ON job_runs(workday);
`;

/**
 * 이후 스키마 변경은 여기에 한 줄씩 추가한다.
 * 이미 적용된 문은 SQLite 가 "duplicate column" 으로 거절하므로 조용히 넘긴다.
 */
export const MIGRATIONS: string[] = [
  `ALTER TABLE standups ADD COLUMN note_to_self TEXT NOT NULL DEFAULT ''`,
  // 09:30 아카이브 알림은 09:00 아침 리마인드에 합쳐졌다 (2026-09-09).
  // 이미 컬럼이 생긴 DB 에서만 지워진다 — 없으면 조용히 넘어간다.
  `ALTER TABLE users DROP COLUMN archive_time`,
  `ALTER TABLE users DROP COLUMN archive_reminder`,
];
