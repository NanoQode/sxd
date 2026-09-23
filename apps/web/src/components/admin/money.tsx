import { formatNairaString } from '@simplexd/ui';

/** Integer-kobo money cell; never renders an invented figure for unknown values. */
export function Money({
  kobo,
  currency = 'NGN',
  compact,
  className,
}: {
  kobo: string | bigint | number | null | undefined;
  currency?: string;
  compact?: boolean;
  className?: string;
}) {
  if (kobo === null || kobo === undefined || kobo === '') {
    return <span className={className ?? 'text-fg-subtle'}>unknown</span>;
  }
  if (typeof kobo === 'string' && !/^-?\d+$/.test(kobo)) {
    return <span className={className ?? 'text-fg-subtle'}>unknown</span>;
  }
  const text = formatNairaString(kobo, { compact, code: currency !== 'NGN' });
  return (
    <span className={className ?? 'tabular-nums'}>
      {currency !== 'NGN' ? text.replace('NGN ', `${currency} `) : text}
    </span>
  );
}
