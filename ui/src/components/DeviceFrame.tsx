/**
 * Screenshots in the chat, shown the way they were taken: in a phone, a tablet or a desktop
 * window, so the owner sees at a glance how a page looks on each. A click opens the picture
 * full size. Pictures that arrive while the page is open fade in.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { StoryMedia } from '../storyTypes';

const FRAME: Record<'phone' | 'tablet' | 'desktop' | 'shot', { box: string; screen: string; aspect: string; label: string }> = {
  phone: { box: 'w-[92px] rounded-[18px] border-[5px] border-hud-bright/80 pt-2 pb-1.5', screen: 'rounded-[6px]', aspect: 'aspect-[390/844]', label: 'Phone' },
  tablet: { box: 'w-[132px] rounded-[14px] border-[6px] border-hud-bright/80 py-1.5', screen: 'rounded-[4px]', aspect: 'aspect-[768/1024]', label: 'Tablet' },
  desktop: { box: 'w-[216px] rounded-lg border border-hud-border', screen: 'rounded-b-md', aspect: 'aspect-[1280/800]', label: 'Desktop' },
  shot: { box: 'w-[168px] rounded-lg border border-hud-border', screen: 'rounded-lg', aspect: 'aspect-[1280/800]', label: 'Screenshot' },
};

function Frame({ media, onOpen }: { media: StoryMedia; onOpen: () => void }) {
  const kind = media.device ?? 'shot';
  const f = FRAME[kind];
  return (
    <button type="button" onClick={onOpen} title={`${f.label}: ${media.caption}. Click to enlarge.`}
      className={clsx('group shrink-0 bg-hud-surface shadow-sm transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-hud-cyan shot-in', f.box)}>
      {kind === 'desktop' && (
        <span aria-hidden className="flex gap-1 px-2 py-1 border-b border-hud-border">
          <span className="h-1.5 w-1.5 rounded-full bg-hud-red/70" /><span className="h-1.5 w-1.5 rounded-full bg-hud-amber/70" /><span className="h-1.5 w-1.5 rounded-full bg-hud-green/70" />
        </span>
      )}
      {kind === 'phone' && <span aria-hidden className="mx-auto mb-1 block h-1 w-6 rounded-full bg-hud-bright/40" />}
      <span className={clsx('block overflow-hidden bg-white', f.aspect, f.screen)}>
        <img src={media.src} alt={`${media.caption} on a ${f.label.toLowerCase()}`} loading="lazy" className="h-full w-full object-cover object-top" />
      </span>
    </button>
  );
}

function Lightbox({ media, onClose }: { media: StoryMedia; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={media.caption} onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 flow-in">
      <figure className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <img src={media.src} alt={media.caption} className={clsx('max-h-[85vh] rounded-lg shadow-2xl', media.device === 'phone' ? 'max-w-[min(420px,95vw)]' : 'max-w-[95vw]')} />
        <figcaption className="mt-2 flex items-center justify-between gap-3 text-sm text-white">
          <span>{media.device ? `${FRAME[media.device].label} · ` : ''}{media.caption}</span>
          <button type="button" onClick={onClose} className="rounded-md bg-white/15 px-2 py-1 hover:bg-white/25">Close</button>
        </figcaption>
      </figure>
    </div>
  );
}

/** A row of pictures. Device shots are grouped by page, phone to desktop. */
export function MediaStrip({ media }: { media: StoryMedia[] }) {
  const [open, setOpen] = useState<StoryMedia | null>(null);
  const byPage = new Map<string, StoryMedia[]>();
  for (const m of media) byPage.set(m.device ? m.caption : '', [...(byPage.get(m.device ? m.caption : '') ?? []), m]);
  return (
    <div className="mt-2 space-y-2">
      {[...byPage.entries()].map(([page, list]) => (
        <div key={page || 'shots'}>
          {page && <div className="mb-1 text-xs text-hud-dim">{page}</div>}
          <div className="flex items-end gap-2 overflow-x-auto pb-1">
            {list.map((m) => <Frame key={m.src} media={m} onOpen={() => setOpen(m)} />)}
          </div>
        </div>
      ))}
      {open && <Lightbox media={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
