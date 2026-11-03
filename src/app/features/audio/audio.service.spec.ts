import { AudioService } from './audio.service';

describe('AudioService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects empty and oversized files before attempting decode', async () => {
    const service = new AudioService();
    await expect(service.decode(new File([], 'empty.mp3'))).rejects.toThrow('non-empty');
    const oversized = { size: 100 * 1024 * 1024 + 1 } as File;
    await expect(service.decode(oversized)).rejects.toThrow('100 MB');
  });

  it.each([
    [75, 3601],
    [100, 5400],
  ])('accepts %i MB audio lasting %i seconds', async (megabytes, duration) => {
    const buffer = { duration, numberOfChannels: 2 } as AudioBuffer;
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = vi.fn().mockResolvedValue(buffer);
      },
    );
    const file = {
      size: megabytes * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(1),
    } as File;
    await expect(new AudioService().decode(file)).resolves.toBe(buffer);
  });

  it('reports unsupported or corrupt audio', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = vi.fn().mockRejectedValue(new Error('Invalid data'));
      },
    );
    await expect(new AudioService().decode(new File(['bad'], 'bad.mp3'))).rejects.toThrow(
      'could not be read',
    );
  });

  it('rejects long audio and multichannel audio', async () => {
    const decode = vi.fn();
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decode;
      },
    );
    const file = { size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as File;
    decode.mockResolvedValue({ duration: 5400.001, numberOfChannels: 2 });
    await expect(new AudioService().decode(file)).rejects.toThrow('1 hour 30 minutes');
    decode.mockResolvedValue({ duration: 10, numberOfChannels: 6 });
    await expect(new AudioService().decode(file)).rejects.toThrow('mono or stereo');
  });

  it('terminates the worker when a pending job is cancelled', async () => {
    const terminate = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        postMessage = vi.fn();
        terminate = terminate;
      },
    );
    const buffer = {
      numberOfChannels: 1,
      sampleRate: 44100,
      getChannelData: () => new Float32Array(44100),
    } as unknown as AudioBuffer;
    const service = new AudioService();
    const result = service.encode(buffer, { bitrate: 96, gain: 1, start: 0, end: 1 });
    service.ngOnDestroy();
    await expect(result).rejects.toThrow('cancelled');
    expect(terminate).toHaveBeenCalledOnce();
  });
});
