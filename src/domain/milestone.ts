import { milestoneTaskCounts } from '../db/tasks.js';
import type { MilestoneRow } from '../db/types.js';
import { daysBetween, type Ymd } from '../util/time.js';

export interface MilestoneProgress {
  percent: number;
  doneTasks: number;
  totalTasks: number;
  mode: 'auto' | 'manual';
  /** 목표일까지 남은 일수. 목표일이 없으면 null, 지났으면 음수 */
  daysLeft: number | null;
  /** 남은 기간 대비 진행이 뒤처졌는지 */
  behind: boolean;
}

export function progressOf(milestone: MilestoneRow, today: Ymd): MilestoneProgress {
  const counts = milestoneTaskCounts(milestone.id);
  const auto = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
  const percent =
    milestone.status === 'done'
      ? 100
      : milestone.progress_mode === 'manual'
        ? milestone.manual_progress
        : auto;

  const daysLeft = milestone.target_date ? daysBetween(today, milestone.target_date) : null;

  // 기대 진행률: 만든 날 0% → 목표일 100% 의 직선. 그보다 15%p 넘게 뒤지면 경고.
  let behind = false;
  if (milestone.target_date && milestone.status === 'active') {
    const created = milestone.created_at.slice(0, 10);
    const span = daysBetween(created, milestone.target_date);
    if (span > 0) {
      const elapsed = Math.max(0, daysBetween(created, today));
      const expected = Math.min(100, Math.round((elapsed / span) * 100));
      behind = percent + 15 < expected;
    }
  }

  return {
    percent,
    doneTasks: counts.done,
    totalTasks: counts.total,
    mode: milestone.progress_mode,
    daysLeft,
    behind,
  };
}

/** `████████░░` 형태의 진행 막대 */
export function progressBar(percent: number, width = 10): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function deadlineLabel(progress: MilestoneProgress): string {
  if (progress.daysLeft === null) return '기한 없음';
  if (progress.daysLeft < 0) return `${Math.abs(progress.daysLeft)}일 지남`;
  if (progress.daysLeft === 0) return '오늘까지';
  return `${progress.daysLeft}일 남음`;
}

export function milestoneLine(milestone: MilestoneRow, today: Ymd): string {
  const p = progressOf(milestone, today);
  const flag = milestone.status === 'done' ? '✅ ' : p.behind ? '⚠️ ' : '';
  const counts = p.mode === 'auto' && p.totalTasks > 0 ? ` · ${p.doneTasks}/${p.totalTasks}개` : '';
  return `${flag}*${milestone.title}* \`#${milestone.id}\`\n\`${progressBar(p.percent)}\` ${p.percent}% · ${deadlineLabel(p)}${counts}`;
}
