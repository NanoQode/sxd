import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type DbExecutor } from '@simplexd/db';
import {
  TemplateRenderError,
  renderEmail,
  renderTemplate,
  type TemplateVariables,
} from '@simplexd/integrations/templates';
import { EMAIL_FOOTER, type PipelineEnv } from './env';
import type { NotificationChannel } from './types';

export type TemplateRow = typeof schema.templates.$inferSelect;

export interface LoadedTemplate {
  row: TemplateRow;
  /** True when a draft was used (development only); rendered output is labelled. */
  draft: boolean;
}

/**
 * Picks the template version to send: the highest approved version for the
 * key/channel/locale, falling back to the `en` locale. Outside production a
 * draft is acceptable when no approved version exists, and the output is
 * labelled so a draft can never masquerade as a released message.
 */
export async function loadTemplate(
  tx: DbExecutor,
  input: { key: string; channel: NotificationChannel; locale?: string | null },
  env: PipelineEnv,
): Promise<LoadedTemplate | null> {
  const locales = [...new Set([input.locale ?? 'en', 'en'])];
  const statuses: TemplateRow['status'][] = env.production ? ['approved'] : ['approved', 'draft'];
  const rows = await tx
    .select()
    .from(schema.templates)
    .where(
      and(
        eq(schema.templates.key, input.key),
        eq(schema.templates.channel, input.channel),
        inArray(schema.templates.locale, locales),
        inArray(schema.templates.status, statuses),
      ),
    )
    .orderBy(desc(schema.templates.version));
  for (const locale of locales) {
    const approved = rows.find((r) => r.locale === locale && r.status === 'approved');
    if (approved) return { row: approved, draft: false };
  }
  if (env.production) return null;
  for (const locale of locales) {
    const draft = rows.find((r) => r.locale === locale && r.status === 'draft');
    if (draft) return { row: draft, draft: true };
  }
  return null;
}

export interface RenderedEmailMessage {
  channel: 'email';
  subject: string;
  text: string;
  html: string;
}

export interface RenderedSmsMessage {
  channel: 'sms';
  body: string;
}

export interface RenderedInAppMessage {
  channel: 'in_app';
  title: string;
  body: string | null;
}

export type RenderedMessage = RenderedEmailMessage | RenderedSmsMessage | RenderedInAppMessage;

export type RenderOutcome =
  | { ok: true; message: RenderedMessage }
  | { ok: false; reason: string; missing?: string[] };

const DRAFT_LABEL = '[DRAFT TEMPLATE] ';

/** Strict render: a missing variable is a failure, never a blank message. */
export function renderForChannel(
  template: LoadedTemplate,
  variables: TemplateVariables,
  env: PipelineEnv,
): RenderOutcome {
  const source = {
    subject: template.row.subject,
    bodyText: template.row.bodyText,
    bodyHtml: template.row.bodyHtml,
  };
  try {
    switch (template.row.channel) {
      case 'email': {
        const email = renderEmail(source, variables, {
          brandName: env.brandName,
          appUrl: env.appUrl,
          footerNote: EMAIL_FOOTER,
        });
        return {
          ok: true,
          message: {
            channel: 'email',
            subject: template.draft ? `${DRAFT_LABEL}${email.subject}` : email.subject,
            text: template.draft ? `${DRAFT_LABEL}${email.text}` : email.text,
            html: email.html,
          },
        };
      }
      case 'sms': {
        const rendered = renderTemplate(source, variables);
        const body = rendered.text.trim();
        if (!body) return { ok: false, reason: 'rendered_empty' };
        return {
          ok: true,
          message: { channel: 'sms', body: template.draft ? `[DRAFT] ${body}` : body },
        };
      }
      case 'in_app': {
        const rendered = renderTemplate(source, variables);
        const title = (rendered.subject ?? rendered.text.split('\n')[0] ?? '').trim();
        if (!title) return { ok: false, reason: 'rendered_empty' };
        return {
          ok: true,
          message: {
            channel: 'in_app',
            title: template.draft ? `${DRAFT_LABEL}${title}` : title,
            body: rendered.subject ? rendered.text.trim() || null : null,
          },
        };
      }
    }
  } catch (err) {
    if (err instanceof TemplateRenderError) {
      return {
        ok: false,
        reason: `missing_variables: ${err.missing.join(', ')}`,
        missing: err.missing,
      };
    }
    return { ok: false, reason: `render_error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
  return { ok: false, reason: 'unsupported_channel' };
}
