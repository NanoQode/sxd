import { describe, expect, it } from 'vitest';
import {
  extractVariables,
  previewTemplate,
  renderEmail,
  renderTemplate,
  TemplateRenderError,
  templateVariables,
  textFromHtml,
  textToHtml,
  wrapHtmlLayout,
} from './render';

const booking = {
  subject: 'Your SimplexD consultation is confirmed',
  bodyText:
    'Hello {{name}},\n\nYour {{kind}} is confirmed for {{startsAtCustomer}}.\n\nManage or reschedule: {{manageUrl}}',
  bodyHtml: '<p>Hello {{name}},</p><p>Your {{ kind }} is confirmed for {{startsAtCustomer}}.</p>',
};

describe('template rendering', () => {
  it('substitutes variables verbatim in text and escaped in html', () => {
    const rendered = renderTemplate(booking, {
      name: '<Ada & Co>',
      kind: 'consultation',
      startsAtCustomer: 'Tue 23 Sep, 10:00',
      manageUrl: 'https://app.simplexd.co/m/abc?x=1&y=2',
    });
    expect(rendered.subject).toBe('Your SimplexD consultation is confirmed');
    expect(rendered.text).toContain('Hello <Ada & Co>,');
    expect(rendered.text).toContain('https://app.simplexd.co/m/abc?x=1&y=2');
    expect(rendered.html).toContain('Hello &lt;Ada &amp; Co&gt;,');
    expect(rendered.html).toContain('Your consultation is confirmed');
    expect(rendered.variables).toEqual(['name', 'kind', 'startsAtCustomer', 'manageUrl']);
    expect(
      renderTemplate({ bodyText: 'Invoice {{n}} for {{amount}}' }, { n: 12, amount: '₦5,000' })
        .text,
    ).toBe('Invoice 12 for ₦5,000');
  });

  it('throws listing every missing variable', () => {
    expect(() => renderTemplate(booking, { name: 'Ada' })).toThrow(TemplateRenderError);
    try {
      renderTemplate(booking, { name: 'Ada' });
    } catch (err) {
      expect((err as TemplateRenderError).missing).toEqual([
        'kind',
        'startsAtCustomer',
        'manageUrl',
      ]);
      expect((err as Error).message).toBe(
        'missing template variables: kind, startsAtCustomer, manageUrl',
      );
    }
  });

  it('extracts placeholder names', () => {
    expect(extractVariables('{{a}} {{ b }} {{a}} {{c.d}}')).toEqual(['a', 'b', 'c.d']);
    expect(
      templateVariables({
        subject: 'Invoice {{invoiceNumber}} is due',
        bodyText: '{{name}} {{invoiceNumber}}',
      }),
    ).toEqual(['invoiceNumber', 'name']);
  });

  it('wraps content in an accessible, image-free layout', () => {
    const html = wrapHtmlLayout({
      title: 'Decision required <now>',
      bodyHtml: '<p>Please respond.</p>',
      brandName: 'SimplexD',
      appUrl: 'https://app.simplexd.co',
      footerNote: 'You received this because you have a SimplexD account.',
      preheader: 'A decision is waiting',
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Decision required &lt;now&gt;</title>');
    expect(html).toContain('<h1');
    expect(html).toContain('Decision required &lt;now&gt;</h1>');
    expect(html).toContain('You received this because you have a SimplexD account.');
    expect(html).toContain('<a href="https://app.simplexd.co"');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('A decision is waiting');
    expect(html).not.toMatch(/<img|<script/);
  });

  it('derives plain text from html and html from text', () => {
    expect(
      textFromHtml(
        '<html><head><title>x</title><style>p{}</style></head><body><p>Hello <b>Ada</b>,</p><p>Pay here: <a href="https://x.test/pay?a=1&amp;b=2">Pay now</a></p><ul><li>One</li><li>Two</li></ul></body></html>',
      ),
    ).toBe('Hello Ada,\n\nPay here: Pay now (https://x.test/pay?a=1&b=2)\n\n- One\n- Two');
    const html = textToHtml('Sign in: https://app.test/x?a=1&b=2.\nThanks & bye\n\nSimplexD');
    expect(html).toContain(
      '<a href="https://app.test/x?a=1&amp;b=2" style="color:#1f4d3f;">https://app.test/x?a=1&amp;b=2</a>.',
    );
    expect(html).toContain('Thanks &amp; bye');
    expect(html).toContain('<br>');
    expect(html.match(/<p /g)).toHaveLength(2);
  });

  it('previews with placeholders for missing samples and composes full emails', () => {
    const preview = previewTemplate(booking, { name: 'Ada' });
    expect(preview.missing).toEqual(['kind', 'startsAtCustomer', 'manageUrl']);
    expect(preview.text).toContain('Your [kind] is confirmed for [startsAtCustomer].');

    const email = renderEmail(
      {
        subject: 'Invoice {{invoiceNumber}} is due',
        bodyText: 'Hello {{name}},\n\nView and pay securely: {{invoiceUrl}}',
      },
      { invoiceNumber: 'INV-001', name: 'Ada', invoiceUrl: 'https://app.simplexd.co/invoices/1' },
      {
        brandName: 'SimplexD',
        appUrl: 'https://app.simplexd.co',
        footerNote: 'Questions? Reply to this email.',
      },
    );
    expect(email.subject).toBe('Invoice INV-001 is due');
    expect(email.text).toContain('Hello Ada,');
    expect(email.html).toContain('<title>Invoice INV-001 is due</title>');
    expect(email.html).toContain('<a href="https://app.simplexd.co/invoices/1"');
    expect(email.html).toContain('Questions? Reply to this email.');
  });
});
