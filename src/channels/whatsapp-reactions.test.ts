import { describe, expect, it } from 'vitest';

import { buildReactionKey, resolveReactionEmoji, stripAgentNamespace } from './whatsapp.js';

describe('stripAgentNamespace', () => {
  it("removes the router's per-agent suffix", () => {
    expect(stripAgentNamespace('3B374294CACF119ED74B:ag-1790197813957-c5aqbv')).toBe('3B374294CACF119ED74B');
  });

  it('leaves a bare WhatsApp id alone', () => {
    expect(stripAgentNamespace('3EB0F76EEDFA110DC9E0E2')).toBe('3EB0F76EEDFA110DC9E0E2');
  });
});

describe('resolveReactionEmoji', () => {
  it('passes a literal emoji through unchanged', () => {
    expect(resolveReactionEmoji('👍')).toBe('👍');
    expect(resolveReactionEmoji('❤️')).toBe('❤️');
  });

  it('resolves well-known names to the emoji WhatsApp needs', () => {
    expect(resolveReactionEmoji('thumbs_up')).toBe('👍');
    expect(resolveReactionEmoji('heart')).toBe('❤️');
    expect(resolveReactionEmoji('check')).toBe('✅');
    expect(resolveReactionEmoji('eyes')).toBe('👀');
  });

  it('resolves Slack-style aliases and colon-wrapped names', () => {
    expect(resolveReactionEmoji('+1')).toBe('👍');
    expect(resolveReactionEmoji('white_check_mark')).toBe('✅');
    expect(resolveReactionEmoji(':tada:')).toBe('🎉');
  });

  it('rejects names it cannot resolve rather than sending text as a reaction', () => {
    expect(resolveReactionEmoji('not_an_emoji')).toBeUndefined();
    expect(resolveReactionEmoji('   ')).toBeUndefined();
  });
});

describe('buildReactionKey', () => {
  const DM = '972500000000@s.whatsapp.net';
  const GROUP = '120363000000000000@g.us';

  it('keeps the group participant from the inbound key', () => {
    const key = buildReactionKey(
      GROUP,
      'MSG1',
      { remoteJid: GROUP, id: 'MSG1', fromMe: false, participant: '12345@lid' },
      false,
    );
    expect(key).toEqual({ remoteJid: GROUP, id: 'MSG1', fromMe: false, participant: '12345@lid' });
  });

  it('reacts to a DM message with the key as received', () => {
    const key = buildReactionKey(DM, 'MSG2', { remoteJid: '999@lid', id: 'MSG2', fromMe: false }, false);
    expect(key).toEqual({ remoteJid: '999@lid', id: 'MSG2', fromMe: false });
  });

  it('falls back to a DM-shaped key for a message not in the cache', () => {
    expect(buildReactionKey(DM, 'MSG3', undefined, false)).toEqual({ remoteJid: DM, id: 'MSG3', fromMe: false });
  });

  it("marks the bot's own messages fromMe", () => {
    expect(buildReactionKey(DM, 'MSG4', undefined, true)).toEqual({ remoteJid: DM, id: 'MSG4', fromMe: true });
  });
});
