import { db, nowIso } from './index.js';
import type { MilestoneRow, MilestoneStatus, ProgressMode } from './types.js';

export function createMilestone(input: {
  userId: string;
  title: string;
  description?: string;
  targetDate?: string | null;
}): MilestoneRow {
  const ts = nowIso();
  const result = db()
    .prepare(
      `INSERT INTO milestones (user_id, title, description, target_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.userId, input.title.trim(), input.description ?? '', input.targetDate ?? null, ts, ts);
  return getMilestone(Number(result.lastInsertRowid))!;
}

export function getMilestone(id: number): MilestoneRow | undefined {
  return db().prepare<[number], MilestoneRow>('SELECT * FROM milestones WHERE id = ?').get(id);
}

export function listMilestones(userId: string, status?: MilestoneStatus): MilestoneRow[] {
  if (status) {
    return db()
      .prepare<[string, string], MilestoneRow>(
        `SELECT * FROM milestones WHERE user_id = ? AND status = ?
         ORDER BY CASE WHEN target_date IS NULL THEN 1 ELSE 0 END, target_date, id`,
      )
      .all(userId, status);
  }
  return db()
    .prepare<[string], MilestoneRow>(
      `SELECT * FROM milestones WHERE user_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
                CASE WHEN target_date IS NULL THEN 1 ELSE 0 END, target_date, id`,
    )
    .all(userId);
}

export function updateMilestone(
  id: number,
  patch: Partial<{
    title: string;
    description: string;
    target_date: string | null;
    status: MilestoneStatus;
    progress_mode: ProgressMode;
    manual_progress: number;
    completed_at: string | null;
  }>,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const params: unknown[] = [
    ...keys.map((k) => (patch as Record<string, unknown>)[k] ?? null),
    nowIso(),
    id,
  ];
  db().prepare(`UPDATE milestones SET ${sets}, updated_at = ? WHERE id = ?`).run(...params);
}

export function deleteMilestone(id: number): void {
  db().prepare('DELETE FROM milestones WHERE id = ?').run(id);
}
