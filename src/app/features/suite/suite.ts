import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  computed,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SuiteTool, ToolField } from './tools';

interface Output {
  url: string;
  name: string;
  size: number;
  type: string;
}
@Component({
  selector: 'app-suite',
  imports: [FormsModule, RouterLink, DecimalPipe],
  templateUrl: './suite.html',
  styleUrl: './suite.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Suite {
  protected readonly tool = inject(ActivatedRoute).snapshot.data['tool'] as SuiteTool;
  private readonly destroyRef = inject(DestroyRef);
  protected readonly files = signal<File[]>([]);
  protected readonly originalBytes = computed(() =>
    this.files().reduce((total, file) => total + file.size, 0),
  );
  protected readonly source = signal('');
  protected readonly output = signal<Output | null>(null);
  protected readonly allowLargerDownload = signal(false);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly recording = signal(false);
  protected readonly checking = signal(this.tool.mode === 'server');
  protected readonly unavailable = signal('');
  protected readonly format = signal(this.tool.formats[0] ?? 'webm');
  protected readonly settings: Record<string, string | number> = Object.fromEntries(
    this.tool.fields.map((f) => [f.key, f.default]),
  );
  protected readonly waveform = signal<number[]>([]);
  protected readonly duration = signal(0);
  protected readonly sourceMedia = viewChild<ElementRef<HTMLMediaElement>>('sourceMedia');
  protected readonly liveVideo = viewChild<ElementRef<HTMLVideoElement>>('liveVideo');
  private request?: AbortController;
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private audioContext?: AudioContext;
  private revision = 0;

  constructor() {
    if (this.tool.mode === 'server') void this.checkAvailability();
    this.destroyRef.onDestroy(() => {
      this.revision++;
      this.request?.abort();
      this.releaseRecording();
      void this.audioContext?.close();
      URL.revokeObjectURL(this.source());
      this.clearOutput();
    });
  }

  private async checkAvailability(): Promise<void> {
    this.request = new AbortController();
    try {
      const response = await fetch('/api/tools/capabilities', { signal: this.request.signal });
      if (!response.ok) throw new Error();
      const capabilities = (await response.json()) as Record<
        string,
        { available: boolean; reason: string }
      >;
      const status = capabilities[`${this.tool.group}/${this.tool.id}`];
      if (!status?.available)
        this.unavailable.set(status?.reason || 'This tool is unavailable on this server.');
    } catch {
      if (!this.destroyRef.destroyed)
        this.unavailable.set('The processing server is unavailable. Start the app with npm start.');
    } finally {
      if (!this.destroyRef.destroyed) this.checking.set(false);
    }
  }

  protected updateSetting(field: ToolField, value: string | number | null): void {
    this.settings[field.key] =
      field.type === 'number' && value !== '' && value !== null ? Number(value) : (value ?? '');
    this.clearOutput();
  }

  protected clearOutput(): void {
    const output = this.output();
    if (output) URL.revokeObjectURL(output.url);
    this.output.set(null);
    this.allowLargerDownload.set(false);
  }

  protected choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  protected drop(event: DragEvent): void {
    event.preventDefault();
    if (!this.busy()) this.addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  private addFiles(incoming: File[]): void {
    if (!incoming.length || this.busy()) return;
    const files = this.tool.multiple ? [...this.files(), ...incoming] : incoming.slice(0, 1);
    if (
      files.length > 20 ||
      files.some((f) => !f.size) ||
      files.reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024
    ) {
      this.error.set('Choose up to 20 non-empty files, totaling no more than 100 MB.');
      return;
    }
    this.files.set(files);
    this.error.set('');
    this.clearOutput();
    this.updateSource();
  }

  protected move(index: number, delta: number): void {
    const files = [...this.files()];
    [files[index], files[index + delta]] = [files[index + delta], files[index]];
    this.files.set(files);
    this.clearOutput();
    this.updateSource();
  }

  protected remove(index: number): void {
    this.files.update((files) => files.filter((_, i) => i !== index));
    this.clearOutput();
    this.updateSource();
  }

  private updateSource(): void {
    URL.revokeObjectURL(this.source());
    this.source.set(this.files()[0] ? URL.createObjectURL(this.files()[0]) : '');
    this.waveform.set([]);
    this.duration.set(0);
    const revision = ++this.revision;
    if (this.tool.group === 'audio' && this.files()[0])
      void this.loadWaveform(this.files()[0], revision);
  }

  private async loadWaveform(file: File, revision: number): Promise<void> {
    try {
      this.audioContext ??= new AudioContext();
      const buffer = await this.audioContext.decodeAudioData(await file.arrayBuffer());
      if (revision !== this.revision || this.destroyRef.destroyed) return;
      this.duration.set(buffer.duration);
      if ('end' in this.settings)
        this.settings['end'] = Math.min(
          buffer.duration,
          this.tool.id === 'ringtone' ? 40 : buffer.duration,
        );
      const samples = buffer.getChannelData(0);
      const stride = Math.max(1, Math.floor(samples.length / 180));
      const peaks = Array.from({ length: 180 }, (_, i) => {
        let peak = 0;
        for (let j = i * stride; j < Math.min(samples.length, (i + 1) * stride); j++)
          peak = Math.max(peak, Math.abs(samples[j]));
        return Math.max(2, peak * 96);
      });
      this.waveform.set(peaks);
    } catch {
      /* Server decoding can support files the browser cannot preview. */
    }
  }

  protected loadedMetadata(event: Event): void {
    const duration = (event.target as HTMLMediaElement).duration;
    if (Number.isFinite(duration)) {
      this.duration.set(duration);
      if ('end' in this.settings && this.tool.group === 'video')
        this.settings['end'] = Math.min(duration, 5400);
    }
  }

  protected previewSelection(): void {
    const media = this.sourceMedia()?.nativeElement;
    if (!media) return;
    media.currentTime = Number(this.settings['start'] ?? 0);
    void media
      .play()
      .catch(() => this.error.set('Preview is unavailable for this file in your browser.'));
  }

  protected timeUpdate(): void {
    const media = this.sourceMedia()?.nativeElement;
    if (media && 'end' in this.settings && media.currentTime >= Number(this.settings['end']))
      media.pause();
  }

  protected cancel(): void {
    this.request?.abort();
  }

  protected async process(): Promise<void> {
    if (this.busy() || this.unavailable() || this.checking()) return;
    if (!this.files().length && this.tool.id !== 'text-to-speech') {
      this.error.set('Choose a file first.');
      return;
    }
    this.error.set('');
    this.clearOutput();
    this.busy.set(true);
    this.request = new AbortController();
    try {
      const data = new FormData();
      data.set('settings', JSON.stringify({ ...this.settings, format: this.format() }));
      for (const file of this.files()) data.append('files', file);
      const response = await fetch(`/api/tools/${this.tool.group}/${this.tool.id}`, {
        method: 'POST',
        body: data,
        signal: this.request.signal,
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(problem?.error || 'Processing failed. Try another file.');
      }
      const blob = await response.blob();
      if (this.destroyRef.destroyed) return;
      const name =
        /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
        `edited.${this.format()}`;
      this.output.set({ url: URL.createObjectURL(blob), name, size: blob.size, type: blob.type });
    } catch (error) {
      if (!this.destroyRef.destroyed)
        this.error.set(
          error instanceof Error && error.name === 'AbortError'
            ? 'Processing cancelled.'
            : error instanceof Error
              ? error.message
              : 'Processing failed.',
        );
    } finally {
      if (!this.destroyRef.destroyed) this.busy.set(false);
    }
  }

  protected async startRecording(): Promise<void> {
    this.error.set('');
    this.clearOutput();
    this.busy.set(true);
    try {
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined')
        throw new Error('Recording requires a supported browser on HTTPS or localhost.');
      const stream =
        this.tool.mode === 'screen'
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          : await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: this.tool.mode === 'camera',
            });
      if (this.destroyRef.destroyed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const recorder = new MediaRecorder(stream);
      this.recorder = recorder;
      const chunks: Blob[] = [];
      let size = 0;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
        }
        if (size > 100 * 1024 * 1024 && recorder.state === 'recording') recorder.stop();
      };
      recorder.onstop = () => {
        this.releaseRecording();
        if (this.destroyRef.destroyed) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size) {
          this.error.set('The recording was empty. Please try again.');
          return;
        }
        this.output.set({
          url: URL.createObjectURL(blob),
          name: `recording.${recorder.mimeType.includes('mp4') ? 'mp4' : 'webm'}`,
          size: blob.size,
          type: blob.type,
        });
      };
      recorder.onerror = () => {
        this.error.set('Recording failed. Please try again.');
        this.releaseRecording();
      };
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopRecording());
      recorder.start(1000);
      this.recording.set(true);
      const video = this.liveVideo()?.nativeElement;
      if (video) {
        video.srcObject = stream;
        void video.play();
      }
    } catch (error) {
      this.releaseRecording();
      if (!this.destroyRef.destroyed)
        this.error.set(error instanceof Error ? error.message : 'Unable to start recording.');
    } finally {
      if (!this.destroyRef.destroyed) this.busy.set(false);
    }
  }

  protected stopRecording(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  private releaseRecording(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.recording.set(false);
  }
}
