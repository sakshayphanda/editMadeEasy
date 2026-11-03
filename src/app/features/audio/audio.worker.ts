import { AudioJob, AudioReply, encodeAudio } from './audio-processing';

addEventListener('message', ({ data }: MessageEvent<AudioJob>) => {
  let reply: AudioReply;
  try {
    reply = { blob: encodeAudio(data) };
  } catch {
    reply = { error: 'Audio processing failed. Try a shorter file or different settings.' };
  }
  postMessage(reply);
});
