/**
 * Windowed list with measured, variable row heights: only the rows in view (plus overscan) exist in
 * the DOM, so a 32,000-message preview scrolls like a 30-message one.
 */
export class VirtualList {
  private heights: Float64Array;
  private offsets: Float64Array;
  private readonly spacer: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private rendered = new Map<number, HTMLElement>();
  private frame = 0;

  constructor(
    private readonly viewport: HTMLElement,
    private count: number,
    private readonly renderRow: (index: number) => HTMLElement,
    private readonly estimate = 64,
    private readonly overscan = 8,
  ) {
    this.heights = new Float64Array(count).fill(estimate);
    this.offsets = new Float64Array(count + 1);
    this.spacer = document.createElement('div');
    this.spacer.className = 'cc-vl__spacer';
    this.layer = document.createElement('div');
    this.layer.className = 'cc-vl__layer';
    viewport.replaceChildren(this.spacer, this.layer);
    this.recompute(0);
    viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(viewport);
    this.schedule();
  }

  /** Replace the data set (e.g. after edits); keeps the scroll position when possible. */
  reset(count: number): void {
    this.count = count;
    this.heights = new Float64Array(count).fill(this.estimate);
    this.offsets = new Float64Array(count + 1);
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.recompute(0);
    this.schedule();
  }

  /** Re-render the rows currently on screen (e.g. after a rename). */
  refresh(): void {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.schedule();
  }

  scrollToIndex(index: number): void {
    const i = Math.max(0, Math.min(this.count - 1, index));
    this.viewport.scrollTop = this.offsets[i] ?? 0;
    this.schedule();
  }

  private recompute(from: number): void {
    for (let i = from; i < this.count; i++) this.offsets[i + 1] = (this.offsets[i] ?? 0) + (this.heights[i] ?? 0);
    this.spacer.style.height = `${this.offsets[this.count] ?? 0}px`;
  }

  private indexAt(y: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.offsets[mid + 1] ?? 0) <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (this.count === 0) {
      for (const el of this.rendered.values()) el.remove();
      this.rendered.clear();
      return;
    }
    const top = this.viewport.scrollTop;
    const bottom = top + this.viewport.clientHeight;
    const first = Math.max(0, this.indexAt(top) - this.overscan);
    const last = Math.min(this.count - 1, this.indexAt(bottom) + this.overscan);

    for (const [i, el] of this.rendered) {
      if (i < first || i > last) {
        el.remove();
        this.rendered.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.rendered.has(i)) continue;
      const el = this.renderRow(i);
      el.classList.add('cc-vl__row');
      this.layer.append(el);
      this.rendered.set(i, el);
    }
    // Measure, then position. A changed height shifts every later offset.
    let changedFrom = -1;
    for (let i = first; i <= last; i++) {
      const el = this.rendered.get(i);
      if (!el) continue;
      const h = el.offsetHeight;
      if (h > 0 && Math.abs(h - (this.heights[i] ?? 0)) > 0.5) {
        this.heights[i] = h;
        if (changedFrom < 0) changedFrom = i;
      }
    }
    if (changedFrom >= 0) this.recompute(changedFrom);
    for (let i = first; i <= last; i++) {
      const el = this.rendered.get(i);
      if (el) el.style.transform = `translateY(${this.offsets[i] ?? 0}px)`;
    }
  }
}
