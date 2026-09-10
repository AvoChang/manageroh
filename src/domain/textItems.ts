/**
 * 자유 서술 답변을 "할 일 한 줄" 단위로 쪼갠다.
 *
 * 사람은 줄바꿈만으로 적지 않는다. 번호를 붙이고, 슬래시로 잇고, 가운뎃점으로 나눈다.
 * 그렇다고 아무 데서나 자르면 더 나쁘다 — 특히 **쉼표는 자르지 않는다.**
 * 한국어에서 쉼표는 항목 구분보다 문장 안 쉼표로 훨씬 자주 쓰인다
 * ("웹훅 ERD + PRD 작성, 영상님과 미팅 (~70%)" 은 두 개가 아니라 한 항목이다).
 *
 * 원문은 그대로 저장되고, 이 함수는 표시와 할 일 생성에만 쓴다.
 */

const MAX_ITEM_LENGTH = 200;

/**
 * 줄 맨 앞의 목록 기호: -, *, •, 1., 1), ①, ✅ 등.
 * 숫자 기호는 **뒤에 공백이 있을 때만** 목록으로 본다 —
 * 그러지 않으면 "2.5시간 공부" 가 "5시간 공부" 로 잘린다.
 */
const LEADING_MARKER =
  /^\s*(?:[-*•·▪◦‣–—]\s*|\d{1,2}[.)\]]\s+|[①-⑳]\s*|[✅☑✔✓☐⬜]\s*)+/u;

/** 줄 안에서 항목이 갈리는 지점 — 앞뒤에 공백이 있는 구분자만 인정한다 */
const INLINE_SPLIT = new RegExp(
  [
    '\\s+[•·▪◦‣]\\s*', // 가운뎃점·불릿
    '\\s+/\\s+', // 띄어쓴 슬래시 (URL 의 / 는 붙어 있어 안 걸린다)
    '\\s*;\\s*', // 세미콜론
    '\\s+\\|\\s+', // 파이프
    '\\s+(?=\\d{1,2}[.)]\\s)', // " 2. " 처럼 문장 중간에 다시 나오는 번호
  ].join('|'),
  'u',
);

/** 항목으로 볼 수 없는 답변 — "없음" 한 줄을 할 일로 만들면 안 된다 */
const NOISE = /^(?:없음|없습니다|특이사항\s*없음|해당\s*없음|n\/?a|none|-{1,3}|\.)$/iu;

export function splitItems(text: string, limit = 12): string[] {
  const items: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    for (const piece of line.split(INLINE_SPLIT)) {
      const item = clean(piece);
      if (item === null) continue;
      items.push(item);
      if (items.length >= limit) return items;
    }
  }

  return items;
}

function clean(piece: string | undefined): string | null {
  if (!piece) return null;
  let value = piece.replace(LEADING_MARKER, '').trim();
  // 끝에 남은 구분자 꼬리를 턴다
  value = value.replace(/[\s·•\-–—|;/]+$/u, '').trim();
  if (value.length === 0) return null;
  if (NOISE.test(value)) return null;
  return value.length > MAX_ITEM_LENGTH ? `${value.slice(0, MAX_ITEM_LENGTH - 1)}…` : value;
}
