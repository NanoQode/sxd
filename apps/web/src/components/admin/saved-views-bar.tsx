'use client';

import { Bookmark, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, Field, Input } from '@simplexd/ui';
import { useSavedViews } from '@/lib/admin/saved-views';

/**
 * Saved table views: the current filters (URL query) can be named and reopened
 * later. Stored per browser; the link itself is what you share with a
 * colleague.
 */
export function SavedViewsBar({ tableKey }: { tableKey: string }) {
  const { views, activeName, currentQuery, save, remove, apply, clear } = useSavedViews(tableKey);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Saved views">
      <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
        <Bookmark aria-hidden="true" className="h-3.5 w-3.5" /> Views
      </span>
      <Button
        variant={activeName || currentQuery ? 'ghost' : 'secondary'}
        size="sm"
        onClick={clear}
      >
        All
      </Button>
      {views.map((v) => (
        <span key={v.name} className="inline-flex items-center">
          <Button
            variant={activeName === v.name ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={activeName === v.name}
            onClick={() => apply(v)}
          >
            {v.name}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 px-1"
            aria-label={`Delete saved view ${v.name}`}
            onClick={() => remove(v.name)}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </span>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!currentQuery}
        title={currentQuery ? undefined : 'Apply a filter first, then save it as a view'}
      >
        Save current filters
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Save view"
          description="Names the current filters so you can reopen them from this bar."
        >
          <Field label="View name" required>
            {({ id }) => (
              <Input
                id={id}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="e.g. Overdue P1 requests"
              />
            )}
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name.trim()}
              onClick={() => {
                save(name);
                setName('');
                setOpen(false);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
