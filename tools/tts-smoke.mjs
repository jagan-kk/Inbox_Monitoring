import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(process.cwd(), 'data', 'tts-test.mp3');
const tts = new MsEdgeTTS();
await tts.setMetadata('en-US-AriaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

const chunks = [];
const { audioStream } = await tts.toStream(
  "Hi Jagan, this is Ricky. You just got an important email from Dana Reed about the Q4 contract renewal. That is all. Talk soon."
);

await new Promise((resolve, reject) => {
  audioStream.on('data', (c) => chunks.push(c));
  audioStream.on('end', resolve);
  audioStream.on('close', resolve);
  audioStream.on('error', reject);
});

const buffer = Buffer.concat(chunks);
fs.writeFileSync(out, buffer);
console.log('bytes:', buffer.length, '->', out);
