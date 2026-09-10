import { db, nowIso } from './index.js';
import type { TaskRow, TaskSource, TaskStatus } from './types.js';

export function addTask(input: {
  userId: string;
  workday: string;
  title: string;
  milestoneId?: number | null;
  source?: TaskSource;
  status?: TaskStatus;
}): TaskRow {
  const ts = nowIso();
  const status = input.status ?? 'planned';
  const result = db()
    .prepare(
      `INSERT INTO tasks (user_id, workday, title, status, milestone_id, source, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.userId,
      input.workday,
      input.title.trim(),
      status,
      input.milestoneId ?? null,
      input.source ?? 'checkin',
      ts,
      status === 'done' ? ts : null,
    );
  return getTask(Number(result.lastInsertRowid))!;
}

export function getTask(id: number): TaskRow | undefined {
  return db().prepare<[number], TaskRow>('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function tasksForDay(userId: string, workday: string): TaskRow[] {
  return db()
    .prepare<[string, string], TaskRow>(
      `SELECT * FROM tasks
       WHERE user_id = ? AND workday = ? AND status != 'dropped'
       ORDER BY CASE status WHEN 'planned' THEN 0 ELSE 1 END, id`,
    )
    .all(userId, workday);
}

export function tasksInRange(userId: string, from: string, to: string): TaskRow[] {
  return db()
    .prepare<[string, string, string], TaskRow>(
      `SELECT * FROM tasks
       WHERE user_id = ? AND workday BETWEEN ? AND ? AND status != 'dropped'
       ORDER BY workday, id`,
    )
    .all(userId, from, to);
}

export function openTasksBefore(userId: string, workday: string): TaskRow[] {
  return db()
    .prepare<[string, string], TaskRow>(
      `SELECT * FROM tasks
       WHERE user_id = ? AND workday < ? AND status = 'planned'
       ORDER BY workday, id`,
    )
    .all(userId, workday);
}

export function setTaskStatus(id: number, status: TaskStatus): void {
  db()
    .prepare('UPDATE tasks SET status = ?, done_at = ? WHERE id = ?')
    .run(status, status === 'done' ? nowIso() : null, id);
}

export function setTaskMilestone(id: number, milestoneId: number | null): void {
  db().prepare('UPDATE tasks SET milestone_id = ? WHERE id = ?').run(milestoneId, id);
}

export function moveTask(id: number, workday: string): void {
  db().prepare('UPDATE tasks SET workday = ? WHERE id = ?').run(workday, id);
}

export function deleteTask(id: number): void {
  db().prepare("UPDATE tasks SET status = 'dropped' WHERE id = ?").run(id);
}

/** 마일스톤에 물린 할 일 개수 — 진행도 자동 계산용 */
export function milestoneTaskCounts(milestoneId: number): { total: number; done: number } {
  const row = db()
    .prepare<[number], { total: number; done: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM tasks WHERE milestone_id = ? AND status != 'dropped'`,
    )
    .get(milestoneId);
  return { total: row?.total ?? 0, done: row?.done ?? 0 };
}

export function tasksForMilestone(milestoneId: number): TaskRow[] {
  return db()
    .prepare<[number], TaskRow>(
      "SELECT * FROM tasks WHERE milestone_id = ? AND status != 'dropped' ORDER BY workday, id",
    )
    .all(milestoneId);
}

/** 하루 통계 — 보고서용 */
export function dayStats(userId: string, workday: string): { planned: number; done: number } {
  const rows = tasksForDay(userId, workday);
  return {
    planned: rows.length,
    done: rows.filter((t) => t.status === 'done').length,
  };
}

/**
 * done-next 의 NEXT 답변으로 자동 생성한 할 일을 지운다.
 * 사용자가 보고를 다시 쓰면 다음날 할 일도 새로 만들어야 하는데,
 * 손으로 추가한 할 일까지 지우면 안 되므로 source 로 좁힌다.
 */
export function clearStandupTasks(userId: string, workday: string): void {
  db()
    .prepare(
      "DELETE FROM tasks WHERE user_id = ? AND workday = ? AND source = 'standup' AND status = 'planned'",
    )
    .run(userId, workday);
}
