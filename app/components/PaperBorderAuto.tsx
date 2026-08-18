"use client";

import { useEffect } from "react";
import { applyPaperBorder, pickPaperBorderId } from "@/lib/paperBorder";

/** Containers whose rendered size changes (form height, expandable log,
 *  responsive re-layout of the Who Am I columns, etc.) get the closest-
 *  matching border PNG via ResizeObserver. The hard-coded background-image
 *  each of these has in globals.css is just the no-JS fallback — this
 *  runtime pass overrides it with the best-fitting asset for the actual
 *  size, so strokes never look stretched. */
const AUTO_SELECTORS = [
  ".panel-form",
  ".avatar-creator",
  ".state-screen",
  ".game-placeholder",
  ".game-picker-card",
  ".who-am-i-topbar",
  ".who-am-i-modal",
  ".who-am-i-sidebar",
  ".who-am-i-chat-panel",
  ".who-am-i-player-log",
].join(", ");

export function PaperBorderAuto() {
  useEffect(() => {
    const observers = new Map<Element, ResizeObserver>();

    function bind(el: HTMLElement) {
      if (observers.has(el)) return;

      const update = () => {
        const { width, height } = el.getBoundingClientRect();
        applyPaperBorder(el, pickPaperBorderId(width, height));
      };

      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      observers.set(el, ro);
    }

    function unbind(el: HTMLElement) {
      const ro = observers.get(el);
      if (ro) {
        ro.disconnect();
        observers.delete(el);
      }
    }

    function scan() {
      document.querySelectorAll<HTMLElement>(AUTO_SELECTORS).forEach(bind);
    }

    scan();

    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      for (const [el, ro] of observers) {
        ro.disconnect();
        unbind(el as HTMLElement);
      }
      observers.clear();
    };
  }, []);

  return null;
}
