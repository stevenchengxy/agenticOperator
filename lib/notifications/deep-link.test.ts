import { describe, expect, it } from 'vitest';
import { notificationHref } from './deep-link';

describe('notificationHref', () => {
  it('links Inngest runs to the monitor row with a focus target', () => {
    expect(notificationHref('run', '01KXN21AVFGYBV14N8F1KW5TVG')).toBe(
      '/monitor?run=01KXN21AVFGYBV14N8F1KW5TVG&focus=run%3A01KXN21AVFGYBV14N8F1KW5TVG',
    );
  });

  it('links event instances to their canonical detail page', () => {
    expect(notificationHref('event', 'evt-row-1')).toBe(
      '/events/instances/evt-row-1?focus=event%3Aevt-row-1',
    );
  });

  it('links infra alerts to the exact health card', () => {
    expect(notificationHref('infra', 'inngest')).toBe(
      '/monitor?infra=inngest&focus=infra%3Ainngest',
    );
  });
});

