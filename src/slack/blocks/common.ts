import type {
  ActionsBlock,
  Button,
  ContextBlock,
  DividerBlock,
  HeaderBlock,
  KnownBlock,
  SectionBlock,
} from '@slack/types';

export function header(text: string): HeaderBlock {
  return { type: 'header', text: { type: 'plain_text', text: truncate(text, 150), emoji: true } };
}

export function section(text: string): SectionBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: truncate(text, 3000) } };
}

export function context(text: string): ContextBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: truncate(text, 3000) }] };
}

export function divider(): DividerBlock {
  return { type: 'divider' };
}

export function actions(elements: ActionsBlock['elements'], blockId?: string): ActionsBlock {
  return blockId ? { type: 'actions', block_id: blockId, elements } : { type: 'actions', elements };
}

export function button(opts: {
  text: string;
  actionId: string;
  value?: string;
  style?: 'primary' | 'danger';
  url?: string;
}): Button {
  const el: Button = {
    type: 'button',
    text: { type: 'plain_text', text: truncate(opts.text, 75), emoji: true },
    action_id: opts.actionId,
  };
  if (opts.value !== undefined) el.value = opts.value;
  if (opts.style) el.style = opts.style;
  if (opts.url) el.url = opts.url;
  return el;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** 슬랙 mrkdwn 에서 의미를 갖는 문자를 중화한다 (사용자 입력을 그대로 넣을 때) */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const blocks = (...items: (KnownBlock | KnownBlock[] | null | undefined)[]): KnownBlock[] =>
  items.flat().filter((b): b is KnownBlock => Boolean(b));

/** 긴 텍스트를 슬랙 코드블록 섹션 여러 개로 나눈다 (섹션당 3000자 제한) */
export function codeBlocks(text: string): KnownBlock[] {
  const chunks: string[] = [];
  let buffer = '';
  for (const line of text.split('\n')) {
    if (buffer.length + line.length + 1 > 2800) {
      chunks.push(buffer);
      buffer = '';
    }
    buffer += (buffer ? '\n' : '') + line;
  }
  if (buffer) chunks.push(buffer);
  return chunks.map((c) => section(`\`\`\`\n${c}\n\`\`\``));
}

/** 여러 줄을 슬랙 섹션 여러 개로 나눈다 (섹션당 3000자 제한) */
export function mrkdwnSections(lines: string[], maxLines = 25): KnownBlock[] {
  const out: KnownBlock[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) out.push(section(buffer.join('\n')));
    buffer = [];
  };
  for (const line of lines) {
    const projected = [...buffer, line].join('\n');
    if (buffer.length >= maxLines || projected.length > 2800) flush();
    buffer.push(line);
  }
  flush();
  return out;
}
