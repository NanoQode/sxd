import { describe, expect, it } from 'vitest';
import { buildIcs, icsFileName } from './ics';

describe('buildIcs', () => {
  it('renders a UTC event with organiser, attendees and the confirmed meeting link', () => {
    const ics = buildIcs({
      uid: 'appt-1@simplexd',
      start: '2026-11-02T08:00:00Z',
      end: '2026-11-02T08:30:00Z',
      summary: 'Consultation: due diligence',
      description: 'Bring your survey plan.',
      organizerEmail: 'bookings@simplexd.test',
      attendeeEmails: ['customer@example.com'],
      url: 'https://meet.google.com/abc-defg-hij',
      sequence: 2,
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('UID:appt-1@simplexd');
    expect(ics).toContain('DTSTART:20261102T080000Z');
    expect(ics).toContain('DTEND:20261102T083000Z');
    expect(ics).toContain('ORGANIZER;CN="SimplexD":MAILTO:bookings@simplexd.test');
    expect(ics).toContain('mailto:customer@example.com');
    expect(ics).toContain('URL:https://meet.google.com/abc-defg-hij');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('STATUS:CONFIRMED');
  });

  it('omits a meeting URL when none is confirmed and supports cancellations', () => {
    const ics = buildIcs({
      uid: 'appt-2@simplexd',
      start: new Date('2026-03-09T13:00:00Z'),
      end: new Date('2026-03-09T13:30:00Z'),
      summary: 'Site visit',
      organizerEmail: 'bookings@simplexd.test',
      attendeeEmails: [],
      status: 'CANCELLED',
      method: 'CANCEL',
      sequence: 3,
    });
    expect(ics).not.toContain('URL:');
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
  });

  it('validates emails and URLs', () => {
    const input = {
      uid: 'x',
      start: '2026-11-02T08:00:00Z',
      end: '2026-11-02T08:30:00Z',
      summary: 'S',
      organizerEmail: 'not-an-email',
      attendeeEmails: [],
    };
    expect(() => buildIcs(input)).toThrow(/organizerEmail/);
    expect(() => buildIcs({ ...input, organizerEmail: 'a@b.co', url: 'javascript:alert(1)' })).toThrow(/http/);
    expect(icsFileName('Consultation: Due diligence!')).toBe('consultation-due-diligence.ics');
  });
});
