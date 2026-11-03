export const audioTools = [
  {
    id: 'compressor',
    title: 'Audio compressor',
    description: 'Make audio files smaller with a bitrate that suits your needs.',
    action: 'Compress audio',
  },
  {
    id: 'volume',
    title: 'Audio volume increaser',
    description: 'Give quiet recordings a volume boost.',
    action: 'Increase volume',
  },
  {
    id: 'trimmer',
    title: 'Audio trimmer',
    description: 'Keep the part you need by choosing a start and end time.',
    action: 'Trim audio',
  },
  {
    id: 'converter',
    title: 'Audio to MP3 converter',
    description: 'Convert WAV, M4A, AAC, FLAC, OGG, and other browser-supported audio to MP3.',
    action: 'Convert to MP3',
  },
  {
    id: 'denoise',
    title: 'Audio denoise',
    description: 'Reduce steady background hiss, including noise beneath speech or music.',
    action: 'Denoise audio',
  },
  {
    id: 'youtube',
    title: 'YouTube audio downloader',
    description: 'Download YouTube audio as MP3 with bitrates from 8 to 320 kbps.',
    action: 'Download audio',
  },
] as const;

export type AudioTool = (typeof audioTools)[number];
