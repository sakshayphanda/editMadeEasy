import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AudioTool, audioTools } from './audio-tools';
import { AudioService } from './audio.service';
import { formatAudioTime, parseAudioTime } from './audio-time';

interface AudioResult {
  url: string;
  name: string;
  size: number;
}

@Component({
  selector: 'app-audio',
  imports: [DecimalPipe, FormsModule, RouterLink],
  providers: [AudioService],
  templateUrl: './audio.html',
  styleUrl: './audio.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Audio {
  private readonly audio = inject(AudioService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly tool = inject(ActivatedRoute).snapshot.data['tool'] as AudioTool;
  protected readonly tools = audioTools;
  protected readonly file = signal<File | null>(null);
  protected readonly buffer = signal<AudioBuffer | null>(null);
  protected readonly sourceUrl = signal('');
  protected readonly result = signal<AudioResult | null>(null);
  protected readonly allowLargerDownload = signal(false);
  protected readonly busy = signal<'loading' | 'processing' | null>(null);
  protected readonly error = signal('');
  protected readonly bitrate = signal(96);
  protected readonly targetSizeMb = signal<number | null>(null);
  protected readonly volume = signal(150);
  protected readonly noiseThreshold = signal(-40);
  protected readonly start = signal(0);
  protected readonly end = signal(0);
  protected readonly startTime = signal('00:00:00');
  protected readonly endTime = signal('00:00:00');
  protected readonly formatTime = formatAudioTime;
  protected readonly duration = computed(() => this.buffer()?.duration ?? 0);
  protected readonly validRange = computed(
    () =>
      Number.isFinite(this.start()) &&
      Number.isFinite(this.end()) &&
      this.start() >= 0 &&
      this.end() <= this.duration() &&
      this.end() > this.start(),
  );

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.revoke(this.sourceUrl());
      this.clearResult();
    });
  }

  protected async loadFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy()) return;
    this.clearResult();
    this.revoke(this.sourceUrl());
    this.sourceUrl.set('');
    this.file.set(null);
    this.buffer.set(null);
    this.error.set('');
    this.busy.set('loading');
    try {
      const buffer = await this.audio.decode(file);
      if (this.destroyRef.destroyed) return;
      this.buffer.set(buffer);
      this.file.set(file);
      this.start.set(0);
      this.end.set(buffer.duration);
      this.startTime.set(formatAudioTime(0));
      this.endTime.set(formatAudioTime(buffer.duration));
      this.sourceUrl.set(URL.createObjectURL(file));
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(this.message(error));
    } finally {
      if (!this.destroyRef.destroyed) this.busy.set(null);
    }
  }

  protected clearResult(): void {
    this.revoke(this.result()?.url);
    this.result.set(null);
    this.allowLargerDownload.set(false);
  }

  protected updateTime(value: string, boundary: 'start' | 'end'): void {
    const text = boundary === 'start' ? this.startTime : this.endTime;
    const seconds = boundary === 'start' ? this.start : this.end;
    text.set(value);
    seconds.set(parseAudioTime(value));
    this.clearResult();
  }

  protected async process(): Promise<void> {
    const buffer = this.buffer();
    const file = this.file();
    if (!buffer || !file || this.busy()) return;
    this.clearResult();
    this.error.set('');
    if (this.tool.id === 'trimmer' && !this.validRange()) {
      this.error.set('Start must be before end, and both times must be within the audio.');
      return;
    }
    this.busy.set('processing');
    try {
      // The encoder can produce silent stereo audio at 64 kbps.
      const minimumVolumeRate = buffer.numberOfChannels === 2 ? 96 : 64;
      const volumeRates = [192, 128, 96, 64].filter((rate) => rate >= minimumVolumeRate);
      const targetBytes =
        this.tool.id === 'compressor' && this.targetSizeMb() !== null
          ? Number(this.targetSizeMb()) * 1_000_000
          : null;
      const targetRates = volumeRates.filter(
        (rate) =>
          rate === minimumVolumeRate ||
          (rate * 1000 * (buffer.duration + 0.1)) / 8 <= (targetBytes ?? 0),
      );
      const rates =
        targetBytes !== null
          ? targetRates
          : this.tool.id === 'volume'
            ? volumeRates.filter(
                (rate) =>
                  rate === minimumVolumeRate ||
                  (rate * 1000 * (buffer.duration + 0.1)) / 8 <= file.size,
              )
            : [this.tool.id === 'compressor' ? Number(this.bitrate()) : 192];
      let blob: Blob | undefined;
      for (const bitrate of rates) {
        blob = await this.audio.encode(buffer, {
          bitrate,
          gain: this.tool.id === 'volume' ? this.volume() / 100 : 1,
          start: this.tool.id === 'trimmer' ? this.start() : 0,
          end: this.tool.id === 'trimmer' ? this.end() : buffer.duration,
          ...(this.tool.id === 'denoise' ? { noiseThreshold: Number(this.noiseThreshold()) } : {}),
        });
        if (this.destroyRef.destroyed) return;
        if (targetBytes !== null) {
          if (blob.size <= targetBytes) break;
        } else if (this.tool.id !== 'volume' || blob.size <= file.size) break;
      }
      if (!blob) throw new Error('Unable to process the audio. Please try again.');
      if (targetBytes !== null && blob.size > targetBytes) {
        throw new Error(
          'This audio cannot fit within the selected size at the supported bitrates. Choose a larger limit or trim the audio first.',
        );
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'audio';
      this.result.set({
        url: URL.createObjectURL(blob),
        name: `${name}-${this.tool.id}.mp3`,
        size: blob.size,
      });
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(this.message(error));
    } finally {
      if (!this.destroyRef.destroyed) this.busy.set(null);
    }
  }

  private revoke(url?: string): void {
    if (url) URL.revokeObjectURL(url);
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  }
}
