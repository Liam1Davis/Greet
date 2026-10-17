/**
 * Book: page stacking + 3D page-turn animation.
 *
 * Pages are absolutely positioned `.page` elements inside the `.book` container.
 * Pages before the current index are rotated -180° around their left edge
 * (`.is-turned`) and hidden by `backface-visibility`. Turning forwards rotates the
 * current page away; turning backwards rotates the previous page back in.
 *
 * Exposed on window.LeavingCard.Book.
 */
(function (LC) {
"use strict";

class Book {
  /**
   * @param {HTMLElement} el   the .book container
   * @param {{ onChange?: (index:number, total:number) => void }} [opts]
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.onChange = opts.onChange || (() => {});
    this.index = 0;
    this.pages = [];
    this.animating = false;
    this._bindInput();
  }

  /** Replace the page set (after re-render). Keeps the current index if possible. */
  setPages(pages, index = this.index) {
    this.pages = pages;
    this.index = Math.max(0, Math.min(index, pages.length - 1));
    this._applyState(false);
    this.onChange(this.index, this.pages.length);
  }

  get total() {
    return this.pages.length;
  }

  next() {
    this.goTo(this.index + 1);
  }

  prev() {
    this.goTo(this.index - 1);
  }

  goTo(target) {
    if (this.animating) return;
    if (target < 0 || target >= this.pages.length || target === this.index) return;

    const forward = target > this.index;
    const turning = forward ? this.pages[this.index] : this.pages[target];

    this.animating = true;
    turning.classList.add("is-turning");

    const finish = () => {
      turning.classList.remove("is-turning");
      turning.removeEventListener("transitionend", onEnd);
      clearTimeout(fallback);
      this.animating = false;
      this._applyState(true);
      this.onChange(this.index, this.pages.length);
    };
    const onEnd = (e) => {
      if (e.target === turning && e.propertyName === "transform") finish();
    };
    turning.addEventListener("transitionend", onEnd);
    // Safety net in case transitionend never fires (e.g. reduced motion, tab hidden).
    const fallback = setTimeout(finish, this._turnDurationMs() + 100);

    this.index = target;
    this._applyState(true);
  }

  _turnDurationMs() {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--turn-duration").trim();
    if (v.endsWith("ms")) return parseFloat(v);
    if (v.endsWith("s")) return parseFloat(v) * 1000;
    return 900;
  }

  /** Apply turned state + z-indexes for the current index. */
  _applyState(animated) {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      if (!animated) page.style.transition = "none";
      page.classList.toggle("is-turned", i < this.index);
      // Pages before current: later ones on top. Pages from current onwards: earlier ones on top.
      page.style.zIndex = i < this.index ? String(i + 1) : String(total - i + 1);
      page.setAttribute("aria-hidden", i === this.index ? "false" : "true");
      if (!animated) {
        // force reflow then restore transition
        void page.offsetWidth;
        page.style.transition = "";
      }
    });
  }

  /** Keyboard + swipe input. Buttons are wired by app.js. */
  _bindInput() {
    document.addEventListener("keydown", (e) => {
      // Don't hijack arrows while typing in a dialog/form.
      if (document.querySelector("dialog[open]")) return;
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        this.next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        this.prev();
      } else if (e.key === "Home") {
        this.goTo(0);
      } else if (e.key === "End") {
        this.goTo(this.pages.length - 1);
      }
    });

    let startX = 0;
    let startY = 0;
    let tracking = false;
    this.el.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        tracking = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      },
      { passive: true },
    );
    this.el.addEventListener(
      "touchend",
      (e) => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) this.next();
          else this.prev();
        }
      },
      { passive: true },
    );
  }
}

LC.Book = Book;
})(window.LeavingCard = window.LeavingCard || {});
