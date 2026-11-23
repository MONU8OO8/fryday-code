/**
 * Pan and zoom for an SVG drawing: drag the background to move, the wheel or a pinch to zoom
 * around the pointer, and buttons to zoom or fit the whole drawing. The view is the SVG's
 * viewBox, so the drawing stays sharp at every size and fills any screen width.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface View { x: number; y: number; w: number; h: number }

export function usePanZoom(content: { w: number; h: number } | null) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, w: 640, h: 400 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number } | null>(null);

  const limits = useCallback((w: number) => {
    const base = content ? Math.max(content.w, 320) : 640;
    return Math.min(base * 3, Math.max(base * 0.12, w));
  }, [content]);

  /**
   * Show the whole drawing, but never smaller than `minScale` (text stays readable): a drawing
   * bigger than that starts at its top, centred, and the rest is a drag or a zoom away.
   */
  const fit = useCallback((minScale = 0.62) => {
    const el = ref.current;
    if (!content || !el) return;
    const r = el.getBoundingClientRect();
    const aspect = r.width / Math.max(1, r.height);
    let w = content.w;
    let h = content.h;
    if (w / h > aspect) h = w / aspect; else w = h * aspect;
    const maxW = r.width / minScale;
    if (w > maxW) {
      w = maxW;
      h = w / aspect;
      setView({ x: (content.w - w) / 2, y: 0, w, h });
      return;
    }
    setView({ x: (content.w - w) / 2, y: (content.h - h) / 2, w, h });
  }, [content]);

  useEffect(() => {
    fit();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  /** Zoom by `factor` (>1 zooms out) keeping the point at (cx, cy), in screen pixels, where it is. */
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    const fx = cx === undefined ? 0.5 : (cx - r.left) / r.width;
    const fy = cy === undefined ? 0.5 : (cy - r.top) / r.height;
    const w = limits(v.w * factor);
    const h = (v.h / v.w) * w;
    setView({ x: v.x + fx * v.w - fx * w, y: v.y + fy * v.h - fy * h, w, h });
  }, [limits]);

  /** Move the view so the point (px, py), in drawing units, is in the middle. */
  const centreOn = useCallback((px: number, py: number) => {
    const v = viewRef.current;
    setView({ ...v, x: px - v.w / 2, y: py - v.h / 2 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A wheel over the drawing zooms it instead of scrolling the page: a passive listener could not stop that.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Panning starts on the background; a node or a line keeps its own click.
    if (!(e.target as Element).hasAttribute('data-bg') && pointers.current.size === 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const last = pointers.current.get(e.pointerId);
    const el = ref.current;
    if (!last || !el) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (d > 0) zoomAt(pinch.current.d / d, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      pinch.current = { d };
      return;
    }
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    setView({ ...v, x: v.x - ((e.clientX - last.x) / r.width) * v.w, y: v.y - ((e.clientY - last.y) / r.height) * v.h });
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  return {
    ref, view, fit, centreOn,
    zoomIn: () => zoomAt(0.8),
    zoomOut: () => zoomAt(1.25),
    /** The whole drawing, however small. */
    fitAll: () => fit(0.01),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
