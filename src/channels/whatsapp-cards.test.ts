import crypto from 'crypto';

import { proto } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';

import { normalizeOptions } from './ask-question.js';
import {
  buildQuestionPoll,
  decryptPollSelection,
  matchPollSelection,
  renderAmbiguousReply,
  renderCardText,
  renderQuestionText,
  resolveQuestionReply,
  type TrackedQuestion,
} from './whatsapp.js';

const APPROVAL_OPTIONS = normalizeOptions([
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
]);

const CHAT = '972500000000@s.whatsapp.net';

function approval(id: string, messageId?: string, chatJid = CHAT): TrackedQuestion {
  return { questionId: id, chatJid, title: `Title ${id}`, options: APPROVAL_OPTIONS, messageId, createdAt: 0 };
}

describe('renderCardText', () => {
  it('renders title, description, children and link actions', () => {
    const text = renderCardText({
      title: 'Deploy',
      description: 'Build finished',
      children: ['line one', { text: 'line two' }],
      actions: [
        { label: 'Open', url: 'https://example.com' },
        { label: 'Callback', value: 'x' },
      ],
    });
    expect(text).toBe('**Deploy**\n\nBuild finished\n\nline one\n\nline two\n\n• Open: https://example.com');
  });

  it('uses fallback text when the card has no body', () => {
    expect(renderCardText({ title: 'Only title' }, 'full fallback')).toBe('full fallback');
    expect(renderCardText(undefined, 'fb')).toBe('fb');
  });

  it('returns empty string when nothing is renderable', () => {
    expect(renderCardText({}, '')).toBe('');
  });
});

describe('renderQuestionText', () => {
  it('numbers options and includes the id', () => {
    const text = renderQuestionText('appr-1', 'Approve?', 'Do the thing', APPROVAL_OPTIONS);
    expect(text).toContain('1. /approve');
    expect(text).toContain('2. /reject');
    expect(text).toContain('ID: appr-1');
    expect(text).toContain('/approve appr-1');
  });
});

describe('resolveQuestionReply', () => {
  it('resolves a bare command when one question is pending', () => {
    const r = resolveQuestionReply('/approve', CHAT, undefined, [approval('appr-1')]);
    expect(r).toMatchObject({ kind: 'answer', questionId: 'appr-1', value: 'approve' });
  });

  it('reports ambiguity when several questions fit a bare command', () => {
    const r = resolveQuestionReply('/approve', CHAT, undefined, [approval('appr-1'), approval('appr-2')]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(renderAmbiguousReply('/approve', r.candidates)).toContain('/approve appr-2');
    }
  });

  it('ignores questions pending in other chats', () => {
    const r = resolveQuestionReply('/approve', CHAT, undefined, [
      approval('appr-1'),
      approval('appr-2', undefined, 'other'),
    ]);
    expect(r).toMatchObject({ kind: 'answer', questionId: 'appr-1' });
  });

  it('resolves `/cmd <id>` to that question', () => {
    const r = resolveQuestionReply('/reject appr-2', CHAT, undefined, [approval('appr-1'), approval('appr-2')]);
    expect(r).toMatchObject({ kind: 'answer', questionId: 'appr-2', value: 'reject', tracked: true });
  });

  it('forwards an untracked approval id with a raw approve/reject value', () => {
    const r = resolveQuestionReply('/approve appr-9', CHAT, undefined, []);
    expect(r).toMatchObject({ kind: 'answer', questionId: 'appr-9', value: 'approve', tracked: false });
    expect(resolveQuestionReply('/approve msg-9', CHAT, undefined, []).kind).toBe('none');
  });

  it('resolves a quoted reply by number, command or label', () => {
    const pending = [approval('appr-1', 'WA1'), approval('appr-2', 'WA2')];
    expect(resolveQuestionReply('2', CHAT, 'WA1', pending)).toMatchObject({ questionId: 'appr-1', value: 'reject' });
    expect(resolveQuestionReply('/approve', CHAT, 'WA2', pending)).toMatchObject({
      questionId: 'appr-2',
      value: 'approve',
    });
    expect(resolveQuestionReply('approve', CHAT, 'WA2', pending)).toMatchObject({ questionId: 'appr-2' });
  });

  it('tolerates the ellipsis on "Reject with reason…"', () => {
    const r = resolveQuestionReply('/reject-with-reason', CHAT, undefined, [approval('appr-1')]);
    expect(r).toMatchObject({ kind: 'answer', value: 'reject_with_reason' });
  });

  it('leaves plain conversation alone', () => {
    const pending = [approval('appr-1', 'WA1')];
    expect(resolveQuestionReply('approve', CHAT, undefined, pending).kind).toBe('none');
    expect(resolveQuestionReply('sounds good', CHAT, 'WA1', pending).kind).toBe('none');
    expect(resolveQuestionReply('/help', CHAT, undefined, pending).kind).toBe('none');
  });
});

describe('buildQuestionPoll', () => {
  it('puts title, question and id in the poll name when it fits', () => {
    const poll = buildQuestionPoll('appr-1', 'CLI: wirings-create', 'Wire A to B?', APPROVAL_OPTIONS)!;
    expect(poll.preamble).toBeUndefined();
    expect(poll.name).toBe('CLI: wirings-create\n\nWire A to B?\n\nID: appr-1');
    expect(poll.values).toEqual(['Approve', 'Reject', 'Reject with reason…']);
  });

  it('moves a long question into a preamble message', () => {
    const poll = buildQuestionPoll('appr-1', 'Title', 'x'.repeat(400), APPROVAL_OPTIONS)!;
    expect(poll.preamble).toContain('ID: appr-1');
    expect(poll.name).toBe('Title');
  });

  it('refuses options a poll cannot carry', () => {
    expect(buildQuestionPoll('q', 'T', 'Q', normalizeOptions(['a', 'a']))).toBeNull();
    expect(buildQuestionPoll('q', 'T', 'Q', normalizeOptions(['only']))).toBeNull();
    expect(buildQuestionPoll('q', 'T', 'Q', normalizeOptions([...Array(13).keys()].map(String)))).toBeNull();
  });
});

/** Encrypt a vote the way a WhatsApp client does (inverse of Baileys' decryptPollVote). */
function encryptVote(label: string, pollMsgId: string, secret: Buffer, creatorJid: string, voterJid: string) {
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: [crypto.createHash('sha256').update(label).digest()],
  }).finish();
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(creatorJid),
    Buffer.from(voterJid),
    Buffer.from('Poll Vote'),
    Buffer.from([1]),
  ]);
  const key0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
  const key = crypto.createHmac('sha256', key0).update(sign).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${pollMsgId}\u0000${voterJid}`));
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { encPayload: enc, encIv: iv };
}

describe('poll vote decryption', () => {
  const secret = crypto.randomBytes(32);

  it('decrypts with the matching JID pair among candidates and maps the option', () => {
    const vote = encryptVote('Reject', 'POLL1', secret, '111@lid', '222@lid');
    const selected = decryptPollSelection(
      vote,
      'POLL1',
      secret,
      ['999:5@s.whatsapp.net', '111:5@lid'],
      ['222@lid', '972500000000@s.whatsapp.net'],
    );
    expect(selected).not.toBeNull();
    expect(matchPollSelection(APPROVAL_OPTIONS, selected!)?.value).toBe('reject');
  });

  it('returns null when no JID pair matches', () => {
    const vote = encryptVote('Approve', 'POLL1', secret, 'a@s.whatsapp.net', 'b@s.whatsapp.net');
    expect(decryptPollSelection(vote, 'POLL1', secret, ['x@s.whatsapp.net'], ['y@s.whatsapp.net'])).toBeNull();
  });

  it('treats an empty selection as a retracted vote', () => {
    expect(matchPollSelection(APPROVAL_OPTIONS, [])).toBeUndefined();
  });
});
