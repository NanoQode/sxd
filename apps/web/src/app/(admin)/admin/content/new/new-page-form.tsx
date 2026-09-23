'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CONTENT_FIELD_TEMPLATES, contentKindSchema, type ContentPageDto } from '@simplexd/contracts';
import { Alert, Button, Field, Input, NativeSelect, Textarea, humanize } from '@simplexd/ui';
import { apiFetch, errorMessage } from '@/lib/api/client-fetch';

const schema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and hyphens'),
  kind: contentKindSchema,
  title: z.string().trim().min(1, 'Enter a title').max(160),
  summary: z.string().trim().max(500).optional(),
  bodyMarkdown: z.string().max(200_000),
  fieldsJson: z.string().max(100_000),
  seoTitle: z.string().trim().max(70).optional(),
  seoDescription: z.string().trim().max(160).optional(),
});
type Values = z.infer<typeof schema>;

export function NewPageForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { slug: '', kind: 'page', title: '', summary: '', bodyMarkdown: '', fieldsJson: '', seoTitle: '', seoDescription: '' },
  });
  const kind = form.watch('kind');

  function applyTemplate() {
    const template = CONTENT_FIELD_TEMPLATES[kind];
    form.setValue('fieldsJson', template ? JSON.stringify(template, null, 2) : '');
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    let fields: Record<string, unknown> | undefined;
    if (values.fieldsJson.trim()) {
      try {
        const parsed = JSON.parse(values.fieldsJson) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Fields must be a JSON object');
        fields = parsed as Record<string, unknown>;
      } catch (err) {
        form.setError('fieldsJson', { message: err instanceof Error ? err.message : 'Invalid JSON' });
        return;
      }
    }
    try {
      const created = await apiFetch<ContentPageDto>('/api/v1/admin/content/pages', {
        method: 'POST',
        body: {
          slug: values.slug,
          kind: values.kind,
          title: values.title,
          summary: values.summary || undefined,
          bodyMarkdown: values.bodyMarkdown,
          fields,
          seo: values.seoTitle || values.seoDescription ? { title: values.seoTitle || undefined, description: values.seoDescription || undefined } : undefined,
        },
      });
      router.push(`/admin/content/${created.id}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  const errors = form.formState.errors;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error ? (
        <Alert tone="danger" title="Could not create page">
          {error}
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Slug" required hint="URL segment, e.g. how-it-works." error={errors.slug?.message}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('slug')} />}
        </Field>
        <Field label="Kind" required>
          {({ id }) => (
            <NativeSelect id={id} {...form.register('kind')}>
              {contentKindSchema.options.map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <Field label="Title" required error={errors.title?.message}>
        {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('title')} />}
      </Field>
      <Field label="Summary" hint="Short description used in listings and previews." error={errors.summary?.message}>
        {({ id }) => <Input id={id} maxLength={500} {...form.register('summary')} />}
      </Field>
      <Field label="Body (Markdown)" hint="Scripts, inline event handlers and unknown protocols are stripped when rendered.">
        {({ id }) => <Textarea id={id} rows={12} className="font-mono" {...form.register('bodyMarkdown')} />}
      </Field>
      <Field
        label="Fields (JSON)"
        hint={CONTENT_FIELD_TEMPLATES[kind] ? `Structured data for ${humanize(kind)} pages.` : 'Optional structured data for this kind.'}
        error={errors.fieldsJson?.message}
      >
        {({ id, describedBy, invalid }) => (
          <div className="space-y-2">
            <Textarea id={id} rows={6} className="font-mono" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('fieldsJson')} />
            {CONTENT_FIELD_TEMPLATES[kind] ? (
              <Button type="button" variant="secondary" size="sm" onClick={applyTemplate}>
                Insert {humanize(kind)} template
              </Button>
            ) : null}
          </div>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SEO title" hint="Up to 70 characters." error={errors.seoTitle?.message}>
          {({ id }) => <Input id={id} maxLength={70} {...form.register('seoTitle')} />}
        </Field>
        <Field label="SEO description" hint="Up to 160 characters." error={errors.seoDescription?.message}>
          {({ id }) => <Input id={id} maxLength={160} {...form.register('seoDescription')} />}
        </Field>
      </div>
      <Button type="submit" loading={form.formState.isSubmitting} loadingLabel="Creating">
        Create draft
      </Button>
    </form>
  );
}
