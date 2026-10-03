import { describe, expect, it } from 'vitest';

import { attentionText, BODY_MAX, TITLE_MAX } from '../lib/attention.js';

describe('attentionText', () => {
  it('passes a title and body through, trimmed', () => {
    expect(attentionText({ title: '  Offline  ', body: ' For an hour ' })).toEqual({
      title: 'Offline',
      body: 'For an hour',
    });
  });

  it('cuts long text to the limits', () => {
    const notice = attentionText({ title: 'x'.repeat(500), body: 'y'.repeat(900) });
    expect(notice?.title).toHaveLength(TITLE_MAX);
    expect(notice?.body).toHaveLength(BODY_MAX);
  });

  it('allows an empty body but not an empty title', () => {
    expect(attentionText({ title: 'Offline', body: '' })).toEqual({ title: 'Offline', body: '' });
    expect(attentionText({ title: '   ', body: 'x' })).toBeNull();
  });

  it('refuses anything that is not two strings', () => {
    expect(attentionText(null)).toBeNull();
    expect(attentionText(undefined)).toBeNull();
    expect(attentionText('Offline')).toBeNull();
    expect(attentionText({ title: 'Offline' })).toBeNull();
    expect(attentionText({ body: 'x' })).toBeNull();
    expect(attentionText({ title: 42, body: 'x' })).toBeNull();
    expect(attentionText({ title: 'Offline', body: { text: 'x' } })).toBeNull();
  });
});
