/**
 * Height cap for admin dialogs. The shared DialogContent's own `max-h-[90dvh]`
 * is not emitted by the app's Tailwind build, so long forms grew past the
 * viewport with their footer unreachable; this class restores the cap (the
 * dialog body already scrolls).
 */
export const DIALOG_MAX_H = 'max-h-[90vh]';
