import { serializeJsonLd, type JsonLdObject } from './structured-data';

export * from './structured-data';

/** Renders escaped JSON-LD; only accurate data is ever passed in. */
export function JsonLd({ data }: { data: JsonLdObject | JsonLdObject[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
