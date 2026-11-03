import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { Audio } from './audio';
import { audioTools } from './audio-tools';
import { AudioService } from './audio.service';

describe('Audio time inputs', () => {
  const buffer = { duration: 3732.924 } as AudioBuffer;
  const service = {
    decode: vi.fn().mockResolvedValue(buffer),
    encode: vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' })),
  };

  beforeEach(async () => {
    service.encode.mockReset().mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' }));
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn().mockReturnValue('blob:audio');
        static override revokeObjectURL = vi.fn();
      },
    );
    await TestBed.configureTestingModule({
      imports: [Audio],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { data: { tool: audioTools[2] } } } },
      ],
    })
      .overrideComponent(Audio, {
        set: { providers: [{ provide: AudioService, useValue: service }] },
      })
      .compileComponents();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function editor(file = new File(['audio'], 'sample.mp3')) {
    const fixture = TestBed.createComponent(Audio);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const upload = element.querySelector<HTMLInputElement>('#audio-file')!;
    Object.defineProperty(upload, 'files', { value: [file] });
    upload.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, element };
  }

  it('formats the duration and inputs while preserving the exact initial endpoint', async () => {
    const { fixture, element } = await editor();
    expect(element.querySelector('.source p')?.textContent).toContain('01:02:12');
    expect(element.querySelector<HTMLInputElement>('#start')?.value).toBe('00:00:00');
    expect(element.querySelector<HTMLInputElement>('#end')?.value).toBe('01:02:12');
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(service.encode).toHaveBeenCalledWith(
      buffer,
      expect.objectContaining({ start: 0, end: 3732.924 }),
    );
  });

  it('converts entered times to seconds for processing', async () => {
    const { fixture, element } = await editor();
    for (const [id, value] of [
      ['start', '00:01:30'],
      ['end', '01:00:00'],
    ]) {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.textContent).toContain('Selected: 00:58:30');
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(service.encode).toHaveBeenCalledWith(
      buffer,
      expect.objectContaining({ start: 90, end: 3600 }),
    );
  });

  it('denoises the full file with the selected threshold and clears stale results', async () => {
    TestBed.inject(ActivatedRoute).snapshot.data['tool'] = audioTools.find(
      (tool) => tool.id === 'denoise',
    );
    const { fixture, element } = await editor();
    const form = element.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.encode).toHaveBeenLastCalledWith(buffer, {
      bitrate: 192,
      gain: 1,
      start: 0,
      end: buffer.duration,
      noiseThreshold: -40,
    });
    expect(element.querySelector('a.download')?.getAttribute('download')).toBe(
      'sample-denoise.mp3',
    );
    const threshold = element.querySelector<HTMLInputElement>('#noise-threshold')!;
    threshold.value = '-30';
    threshold.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('a.download')).toBeNull();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(service.encode).toHaveBeenLastCalledWith(
      buffer,
      expect.objectContaining({ noiseThreshold: -30 }),
    );
  });

  it('selects a volume bitrate that fits the source size and preserves the boost', async () => {
    TestBed.inject(ActivatedRoute).snapshot.data['tool'] = audioTools.find(
      (tool) => tool.id === 'volume',
    );
    service.decode.mockResolvedValueOnce({ duration: 1 } as AudioBuffer);
    service.encode.mockResolvedValueOnce(new Blob([new Uint8Array(12000)]));
    const { fixture, element } = await editor(new File([new Uint8Array(14000)], 'quiet.mp3'));
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.encode).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ bitrate: 96, gain: 1.5, start: 0, end: 1 }),
    );
    expect(element.querySelector('a.download')).not.toBeNull();
  });

  it('retries a lower volume bitrate when the actual MP3 exceeds the original size', async () => {
    TestBed.inject(ActivatedRoute).snapshot.data['tool'] = audioTools.find(
      (tool) => tool.id === 'volume',
    );
    service.decode.mockResolvedValueOnce({ duration: 1 } as AudioBuffer);
    service.encode
      .mockResolvedValueOnce(new Blob([new Uint8Array(31000)]))
      .mockResolvedValueOnce(new Blob([new Uint8Array(20000)]));
    const { fixture, element } = await editor(new File([new Uint8Array(30000)], 'quiet.mp3'));
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.encode.mock.calls.map((call) => call[1].bitrate)).toEqual([192, 128]);
    expect(element.querySelector('a.download')).not.toBeNull();
  });

  it('avoids silent 64 kbps stereo output and requires fresh permission for the larger download', async () => {
    TestBed.inject(ActivatedRoute).snapshot.data['tool'] = audioTools.find(
      (tool) => tool.id === 'volume',
    );
    service.decode.mockResolvedValueOnce({ duration: 1, numberOfChannels: 2 } as AudioBuffer);
    service.encode.mockResolvedValueOnce(new Blob([new Uint8Array(2000)]));
    const { fixture, element } = await editor(new File([new Uint8Array(1000)], 'quiet.mp3'));
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.encode).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ bitrate: 96 }),
    );
    expect(element.querySelector('a.download')).toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector('.result')?.textContent).toContain('Output size:');
    expect(element.querySelector('.result')?.textContent).toContain('Original size:');
    expect(element.querySelector('.result')?.textContent).toMatch(
      /increased by\s+1,000\s+bytes\s+\(100%\)/,
    );
    expect(element.querySelector('.result audio')).not.toBeNull();
    const permission = element.querySelector<HTMLInputElement>('#allow-larger-download')!;
    permission.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('a.download')).not.toBeNull();
    permission.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('a.download')).toBeNull();
    permission.click();
    await fixture.whenStable();
    service.encode.mockResolvedValueOnce(new Blob([new Uint8Array(2000)]));
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector<HTMLInputElement>('#allow-larger-download')?.checked).toBe(false);
    expect(element.querySelector('a.download')).toBeNull();
  });

  async function compressor() {
    TestBed.inject(ActivatedRoute).snapshot.data['tool'] = audioTools.find(
      (tool) => tool.id === 'compressor',
    );
    service.decode.mockResolvedValueOnce({ duration: 180, numberOfChannels: 2 } as AudioBuffer);
    const context = await editor(new File([new Uint8Array(5_000_000)], 'sample.mp3'));
    const select = context.element.querySelector<HTMLSelectElement>('#target-size')!;
    select.selectedIndex = Array.from(select.options).findIndex(
      (option) => option.textContent?.trim() === '4 MB',
    );
    select.dispatchEvent(new Event('change'));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    return context;
  }

  it('retries an oversized encoding and accepts a result exactly at the 4 MB limit', async () => {
    service.encode
      .mockResolvedValueOnce(new Blob([new Uint8Array(4_000_001)]))
      .mockResolvedValueOnce(new Blob([new Uint8Array(4_000_000)]));
    const { fixture, element } = await compressor();
    expect(element.querySelector('#bitrate')).toBeNull();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.encode.mock.calls.map((call) => call[1].bitrate)).toEqual([128, 96]);
    expect(element.querySelector('a.download')).not.toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();

    const select = element.querySelector<HTMLSelectElement>('#target-size')!;
    select.selectedIndex = 0;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('.result')).toBeNull();
    expect(element.querySelector('#bitrate')).not.toBeNull();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(service.encode).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ bitrate: 96 }),
    );
  });

  it('rejects output above the limit even at the minimum safe stereo bitrate', async () => {
    service.encode.mockResolvedValue(new Blob([new Uint8Array(4_000_001)]));
    const { fixture, element } = await compressor();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.encode.mock.calls.map((call) => call[1].bitrate)).toEqual([128, 96]);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('cannot fit');
    expect(element.querySelector('.result')).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it.each(['00:60:00', '00:00', '', '02:00:00'])(
    'disables trimming for invalid time %j',
    async (value) => {
      const { fixture, element } = await editor();
      const input = element.querySelector<HTMLInputElement>('#start')!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        true,
      );
    },
  );
});
