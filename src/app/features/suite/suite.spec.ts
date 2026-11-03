import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { Suite } from './suite';
import { suiteTools } from './tools';

describe('Suite workspace', () => {
  const request = vi.fn();
  beforeEach(async () => {
    request.mockReset().mockImplementation(async (url: string) =>
      url.endsWith('/capabilities')
        ? new Response(
            JSON.stringify(
              Object.fromEntries(
                suiteTools.map((tool) => [
                  `${tool.group}/${tool.id}`,
                  { available: true, reason: '' },
                ]),
              ),
            ),
          )
        : new Response(new Blob(['processed'], { type: 'audio/mpeg' }), {
            headers: {
              'Content-Disposition': 'attachment; filename="audio-editor.mp3"',
              'Content-Type': 'audio/mpeg',
            },
          }),
    );
    vi.stubGlobal('fetch', request);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await TestBed.configureTestingModule({
      imports: [Suite],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              data: { tool: suiteTools.find((t) => t.group === 'audio' && t.id === 'editor') },
            },
          },
        },
      ],
    }).compileComponents();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function editor(group = 'audio', id = 'editor') {
    TestBed.inject(ActivatedRoute).snapshot.data['tool'] = suiteTools.find(
      (t) => t.group === group && t.id === id,
    );
    const fixture = TestBed.createComponent(Suite);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).textContent).not.toContain(
        'Checking tool availability',
      );
    });
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }
  async function upload(context: Awaited<ReturnType<typeof editor>>, files: File[]) {
    const input = context.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change'));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
  }
  it('submits settings and clears the previous download when settings change', async () => {
    const context = await editor();
    await upload(context, [new File([new Uint8Array(100)], 'sample.wav')]);
    context.element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    expect(request).toHaveBeenLastCalledWith(
      '/api/tools/audio/editor',
      expect.objectContaining({ method: 'POST' }),
    );
    const data = request.mock.calls.at(-1)![1].body as FormData;
    expect(JSON.parse(data.get('settings') as string)).toMatchObject({
      format: 'mp3',
      speed: 1,
      pitch: 0,
    });
    expect(context.element.querySelector('a.download')?.getAttribute('download')).toBe(
      'audio-editor.mp3',
    );
    const volume = context.element.querySelector<HTMLInputElement>('#volume')!;
    volume.value = '50';
    volume.dispatchEvent(new Event('input'));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    expect(context.element.querySelector('a.download')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    context.element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await context.fixture.whenStable();
    const updated = request.mock.calls.at(-1)![1].body as FormData;
    expect(JSON.parse(updated.get('settings') as string).volume).toBe(50);
  });
  it('requires fresh confirmation before a larger audio download', async () => {
    const context = await editor();
    await upload(context, [new File(['a'], 'tiny.wav')]);
    context.element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    expect(context.element.querySelector('a.download')).toBeNull();
    context.element.querySelector<HTMLInputElement>('.confirm-larger input')!.click();
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    expect(context.element.querySelector('a.download')).not.toBeNull();
    context.element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    expect(context.element.querySelector('a.download')).toBeNull();
  });

  it('keeps the visible file order in join requests', async () => {
    const context = await editor('audio', 'joiner');
    await upload(context, [new File(['a'], 'first.wav'), new File(['b'], 'second.wav')]);
    context.element.querySelector<HTMLButtonElement>('[aria-label="Move second.wav up"]')!.click();
    context.fixture.detectChanges();
    context.element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await context.fixture.whenStable();
    const data = request.mock.calls.at(-1)![1].body as FormData;
    expect(data.getAll('files').map((f) => (f as File).name)).toEqual(['second.wav', 'first.wav']);
  });
  it('explains missing dependencies and prevents submitting an unavailable tool', async () => {
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          'audio/editor': { available: false, reason: 'Install processing dependencies.' },
        }),
      ),
    );
    const { element } = await editor();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Install processing dependencies.',
    );
    expect(element.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true);
  });
  it('rejects empty files before sending them', async () => {
    const context = await editor();
    await upload(context, [new File([], 'empty.wav')]);
    expect(context.element.querySelector('[role="alert"]')?.textContent).toContain('non-empty');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('shows processing errors without a stale download', async () => {
    const context = await editor();
    await upload(context, [new File([new Uint8Array(100)], 'sample.wav')]);
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'End must be after start.' }), { status: 422 }),
    );
    context.element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await context.fixture.whenStable();
    context.fixture.detectChanges();
    expect(context.element.querySelector('[role="alert"]')?.textContent).toContain(
      'End must be after start.',
    );
    expect(context.element.querySelector('a.download')).toBeNull();
  });
  it('offers browser recording without calling the processing server', async () => {
    const { element } = await editor('audio', 'recorder');
    expect(element.textContent).toContain('Start recording');
    expect(request).not.toHaveBeenCalled();
  });
});
