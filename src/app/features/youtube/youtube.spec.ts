import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Youtube } from './youtube';

describe('YouTube downloader', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn().mockReturnValue('blob:youtube');
        static override revokeObjectURL = vi.fn();
      },
    );
    await TestBed.configureTestingModule({
      imports: [Youtube],
      providers: [provideRouter([])],
    }).compileComponents();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const fixture = TestBed.createComponent(Youtube);
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('#youtube-url')!;
    input.value = 'https://youtu.be/jNQXAC9IVRw';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, element, input };
  }

  it('sends the selected bitrate, displays MP3, and clears stale downloads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { fixture, element, input } = await setup();
    const select = element.querySelector<HTMLSelectElement>('select')!;
    expect(select.options).toHaveLength(18);
    select.value = select.options[17].value;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url: input.value, bitrate: 320 });
    expect(element.querySelector('a.download')?.getAttribute('download')).toBe(
      'youtube-320kbps.mp3',
    );
    input.value = 'https://youtu.be/abcdefghijk';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('a.download')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:youtube');
  });

  it('surfaces provider rate limits without showing a download', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Free limit reached.' }), {
            status: 429,
            headers: { 'Retry-After': '60' },
          }),
        ),
    );
    const { fixture, element } = await setup();
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Free limit reached. Retry in 60 seconds.',
    );
    expect(element.querySelector('a.download')).toBeNull();
  });
});
