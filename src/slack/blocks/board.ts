import type { KnownBlock } from '@slack/types';
import { formatKorean, type Ymd } from '../../util/time.js';
import { blocks, context, divider, section } from './common.js';

/**
 * 공개 보드 채널의 하루 시작 알림.
 *
 * 질문과 답변은 DM 에서 오간다. 채널에는 "지금이 정리 시간이다" 는 신호와
 * 각자 제출한 요약만 올라온다 — 채널이 게시판이 아니라 사무실처럼 보이게 하는 장치다.
 */
export function boardOpener(opts: { workday: Ymd; participants: number }): KnownBlock[] {
  return blocks(
    section(
      `:sunny: *Daily Retro & Planning* — ${formatKorean(opts.workday)}\n` +
        `오늘 하루를 정리할 시간입니다. 각자 DM 으로 보내 드린 질문에 답해 주세요.`,
    ),
    context(`정리를 마치면 이 채널에 요약이 올라옵니다. · 참여자 ${opts.participants}명`),
    divider(),
  );
}

/** 마감 현황 — 낸 사람만 부른다. 안 낸 사람 이름은 부르지 않는다. */
export function boardWrapup(opts: {
  workday: Ymd;
  submitted: string[];
  total: number;
}): KnownBlock[] {
  const remaining = opts.total - opts.submitted.length;
  const names = opts.submitted.map((id) => `<@${id}>`).join(' ');

  return blocks(
    section(
      `*${formatKorean(opts.workday)} 정리 현황* — ${opts.total}명 중 ${opts.submitted.length}명 완료`,
    ),
    names ? context(`✅ ${names}`) : null,
    remaining > 0 ? context(`아직 ${remaining}명 남았습니다. 늦어도 괜찮으니 한 줄만 남겨 주세요.`) : null,
  );
}
