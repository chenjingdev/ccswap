import { LIMIT_PATTERNS } from "../core/constants.js";

const MAX_BUFFER = 12000;

export class LimitDetector {
  private buffer = "";
  private _matchedText: string | null = null;

  get matched(): boolean {
    return this._matchedText !== null;
  }

  get matchedText(): string | null {
    return this._matchedText;
  }

  feed(chunk: string): void {
    if (this.matched || !chunk) return;
    this.buffer = (this.buffer + chunk).slice(-MAX_BUFFER);
    for (const pattern of LIMIT_PATTERNS) {
      if (pattern.test(this.buffer)) {
        this._matchedText = this.buffer;
        return;
      }
    }
  }

  reset(): void {
    this.buffer = "";
    this._matchedText = null;
  }
}
