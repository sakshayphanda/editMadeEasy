import { Injectable, OnDestroy } from '@angular/core';
import type { AudioJob, AudioReply } from './audio-processing';

@Injectable()
export class AudioService implements OnDestroy {
  private worker?: Worker;
  private rejectJob?: (reason: Error) => void;

  async decode(file: File): Promise<AudioBuffer> {
    if (!file.size || file.size > 100 * 1024 * 1024) {
      throw new Error('Choose a non-empty audio file up to 100 MB.');
    }
    if (typeof OfflineAudioContext === 'undefined') {
      throw new Error('Your browser does not support audio processing. Try a current browser.');
    }
    let buffer: AudioBuffer;
    try {
      const context = new OfflineAudioContext(2, 1, 44100);
      buffer = await context.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error(
        'This file could not be read. Try an MP3, WAV, or another supported audio file.',
      );
    }
    if (buffer.numberOfChannels > 2 || buffer.duration <= 0 || buffer.duration > 5400) {
      throw new Error('Choose mono or stereo audio up to 1 hour 30 minutes long.');
    }
    return buffer;
  }

  encode(buffer: AudioBuffer, settings: Omit<AudioJob, 'channels' | 'sampleRate'>): Promise<Blob> {
    this.cancel();
    return new Promise((resolve, reject) => {
      this.rejectJob = reject;
      try {
        const worker = new Worker(new URL('./audio.worker', import.meta.url), { type: 'module' });
        this.worker = worker;
        worker.onmessage = ({ data }: MessageEvent<AudioReply>) => {
          this.finish();
          if ('error' in data) reject(new Error(data.error));
          else resolve(data.blob);
        };
        worker.onerror = () => {
          this.finish();
          reject(
            new Error('Audio processing is unavailable. Please try again in a current browser.'),
          );
        };
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
          buffer.getChannelData(index).slice(),
        );
        const job: AudioJob = { ...settings, channels, sampleRate: buffer.sampleRate };
        worker.postMessage(
          job,
          channels.map((channel) => channel.buffer),
        );
      } catch {
        this.finish();
        reject(
          new Error('Unable to start audio processing. Try a smaller file or a current browser.'),
        );
      }
    });
  }

  cancel(): void {
    this.rejectJob?.(new Error('Processing cancelled.'));
    this.finish();
  }

  ngOnDestroy(): void {
    this.cancel();
  }

  private finish(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectJob = undefined;
  }
}
