import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { audioTools } from '../audio/audio-tools';

@Component({
  selector: 'app-youtube',
  imports: [DecimalPipe, FormsModule, RouterLink],
  templateUrl: './youtube.html',
  styleUrl: '../audio/audio.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Youtube {
  private readonly destroyRef = inject(DestroyRef);
  private controller?: AbortController;
  protected readonly tools = audioTools;
  protected readonly bitrates = [
    8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320,
  ];
  protected readonly url = signal('');
  protected readonly bitrate = signal(192);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly result = signal<{ url: string; name: string; size: number } | null>(null);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.controller?.abort();
      this.clearResult();
    });
  }

  protected clearResult(): void {
    const result = this.result();
    if (result) URL.revokeObjectURL(result.url);
    this.result.set(null);
    this.error.set('');
  }

  protected cancel(): void {
    this.controller?.abort();
  }

  protected async download(): Promise<void> {
    if (this.busy()) return;
    this.clearResult();
    this.busy.set(true);
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 250_000);
    const bitrate = this.bitrate();
    try {
      const response = await fetch('/api/youtube/audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: this.url().trim(), bitrate }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        const retry = response.headers.get('Retry-After');
        throw new Error(
          (problem?.error ||
            'Download unavailable. Check that the audio API is running and try again.') +
            (retry && /^\d+$/.test(retry) ? ` Retry in ${retry} seconds.` : ''),
        );
      }
      if (!response.headers.get('Content-Type')?.includes('audio/mpeg')) {
        throw new Error('The audio API is unavailable. Please try again later.');
      }
      const blob = await response.blob();
      if (this.destroyRef.destroyed) return;
      if (!blob.size) throw new Error('The provider returned an empty audio file.');
      this.result.set({
        url: URL.createObjectURL(blob),
        name: `youtube-${bitrate}kbps.mp3`,
        size: blob.size,
      });
    } catch (error) {
      if (!this.destroyRef.destroyed)
        this.error.set(
          controller.signal.aborted
            ? 'Download cancelled or timed out. You can try again.'
            : error instanceof Error
              ? error.message
              : 'Unable to download audio. Please try again.',
        );
    } finally {
      clearTimeout(timeout);
      if (!this.destroyRef.destroyed) this.busy.set(false);
      this.controller = undefined;
    }
  }
}
