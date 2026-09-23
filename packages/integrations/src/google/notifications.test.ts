import { describe, expect, it } from 'vitest';
import {
  channelNeedsRenewal,
  createChannelToken,
  hashChannelToken,
  parsePushNotification,
  pushNotificationAction,
  validatePushNotification,
  verifyChannelToken,
} from './notifications';

const token = createChannelToken();
const headers = {
  'X-Goog-Channel-ID': 'chan-1',
  'X-Goog-Channel-Token': token,
  'X-Goog-Resource-ID': 'res-1',
  'X-Goog-Resource-State': 'exists',
  'X-Goog-Message-Number': '7',
  'X-Goog-Resource-URI': 'https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json',
};

describe('push notifications', () => {
  it('parses headers case-insensitively from records and Headers objects', () => {
    const fromRecord = parsePushNotification(headers);
    expect(fromRecord).toMatchObject({
      ok: true,
      notification: { channelId: 'chan-1', resourceId: 'res-1', resourceState: 'exists', messageNumber: 7 },
    });
    const fromHeaders = parsePushNotification(new Headers(headers));
    expect(fromHeaders).toEqual(fromRecord);
  });

  it('rejects missing or unexpected headers', () => {
    expect(parsePushNotification({ ...headers, 'X-Goog-Channel-ID': undefined })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Channel-ID'),
    });
    expect(parsePushNotification({ ...headers, 'X-Goog-Resource-State': 'deleted' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Resource-State'),
    });
  });

  it('verifies the channel token against the stored hash in constant time', () => {
    const stored = hashChannelToken(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyChannelToken({ channelToken: token }, stored)).toBe(true);
    expect(verifyChannelToken({ channelToken: `${token}x` }, stored)).toBe(false);
    expect(verifyChannelToken({ channelToken: token }, hashChannelToken('other'))).toBe(false);
    expect(verifyChannelToken({ channelToken: null }, stored)).toBe(false);
    expect(verifyChannelToken({ channelToken: token }, null)).toBe(false);
  });

  it('maps resource states to actions', () => {
    expect(pushNotificationAction({ resourceState: 'sync' })).toBe('acknowledge');
    expect(pushNotificationAction({ resourceState: 'exists' })).toBe('fetch_changes');
    expect(pushNotificationAction({ resourceState: 'not_exists' })).toBe('fetch_changes');
  });

  it('validates end to end without trusting any payload', async () => {
    const stored = hashChannelToken(token);
    const ok = await validatePushNotification(headers, async (id) => (id === 'chan-1' ? stored : null));
    expect(ok).toMatchObject({ ok: true, action: 'fetch_changes', respondWithStatus: 200 });

    const unknown = await validatePushNotification(headers, () => null);
    expect(unknown).toMatchObject({ ok: false, respondWithStatus: 404, channelId: 'chan-1' });

    const forged = await validatePushNotification(
      { ...headers, 'X-Goog-Channel-Token': 'guess' },
      () => stored,
    );
    expect(forged).toMatchObject({ ok: false, respondWithStatus: 403 });

    const malformed = await validatePushNotification({}, () => stored);
    expect(malformed).toMatchObject({ ok: false, respondWithStatus: 400 });
  });

  it('flags channels that need renewal', () => {
    const now = new Date('2026-09-23T00:00:00Z');
    expect(channelNeedsRenewal(null, now)).toBe(true);
    expect(channelNeedsRenewal(new Date('2026-09-23T12:00:00Z'), now)).toBe(true);
    expect(channelNeedsRenewal(new Date('2026-09-26T00:00:00Z'), now)).toBe(false);
  });
});
