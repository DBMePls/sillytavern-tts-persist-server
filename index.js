/**
 * TTS Persist — Server Plugin (FFmpeg Flawless Filter Edition)
 * Optimized with Eager Temp Stash
 */

console.log('[TTS Persist] Booting plugin...');

import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const AUDIO_ROOT = path.join(process.cwd(), 'data', 'tts-persist');
const TEMP_ROOT = path.join(AUDIO_ROOT, '_temp');

function safe(str) {
  return String(str ?? 'unknown').replace(/[/\\:*?"<>|\s]/g, '_').substring(0, 128);
}

function chatDir(char, chat) {
  const d = path.join(AUDIO_ROOT, safe(char), safe(chat));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

const FORMAT_EXT = { mp3: 'mp3', opus: 'opus', aac: 'aac', flac: 'flac', wav: 'wav', pcm: 'wav' };

function audioFile(dir, key, format) {
  const ext = FORMAT_EXT[format] || 'mp3';
  return path.join(dir, safe(key) + '.' + ext);
}

function findAudioFile(dir, key) {
  const base = safe(key);
  for (const ext of Object.values(FORMAT_EXT)) {
    const f = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '_manifest.json'), 'utf8')); }
  catch { return {}; }
}

function writeManifest(dir, m) {
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(m, null, 2));
}

// ── ABORTABLE BACKGROUND TASK QUEUE ──────────────────────────────────────────

let taskQueue = [];
let isProcessing = false;
let isPaused = false;
let isNuking = false; 
let currentTask = null;
let activeAbortController = null;

async function processQueue() {
    if (isProcessing || isPaused) return;
    isProcessing = true;

    if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

    while (taskQueue.length > 0) {
        if (isPaused) break;
        currentTask = taskQueue.shift(); 
        activeAbortController = new AbortController();
        const taskId = Date.now() + '_' + Math.floor(Math.random() * 1000);
        const taskTempDir = path.join(TEMP_ROOT, taskId);
        
        try {
            const dir = chatDir(currentTask.charName, currentTask.chatId);
            if (findAudioFile(dir, currentTask.audioKey)) {
                currentTask = null;
                continue;
            }

            fs.mkdirSync(taskTempDir, { recursive: true });

            const headers = { 'Content-Type': 'application/json' };
            if (currentTask.ttsApiKey && currentTask.ttsApiKey !== 'sk-none') {
                headers['Authorization'] = `Bearer ${currentTask.ttsApiKey}`;
            }

            const isLocalHost = currentTask.ttsUrl.includes('127.0.0.1') || currentTask.ttsUrl.includes('localhost') || currentTask.ttsUrl.includes('192.168.') || currentTask.ttsUrl.startsWith('/');
            if (isLocalHost) {
                if (currentTask.reqCsrfToken) headers['X-CSRF-Token'] = currentTask.reqCsrfToken;
                if (currentTask.reqCookie) headers['Cookie'] = currentTask.reqCookie;
            }

            const inputPayload = currentTask.ttsBody.input;
            const chunks = Array.isArray(inputPayload) ? inputPayload : [{ text: inputPayload, voice: currentTask.ttsBody.voice }];
            
            let chunkFiles = [];
            let chunkIndex = 0;

            // 1. Download chunks & Standardize them to identical WAVs
            for (const chunk of chunks) {
                const textToSpeak = chunk.text ? chunk.text.trim() : '';
                if (!textToSpeak) continue;
                
                const chunkBody = { ...currentTask.ttsBody, input: textToSpeak };
                if (chunk.voice) chunkBody.voice = chunk.voice;

                const ttsRes = await fetch(currentTask.ttsUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(chunkBody),
                    signal: activeAbortController.signal
                });

                if (!ttsRes.ok) throw new Error(`API Error ${ttsRes.status}: ${await ttsRes.text()}`);
                
                const arrayBuf = await ttsRes.arrayBuffer();
                const rawFilePath = path.join(taskTempDir, `raw_${chunkIndex}.bin`);
                fs.writeFileSync(rawFilePath, Buffer.from(arrayBuf));

                const wavFilePath = path.join(taskTempDir, `chunk_${chunkIndex}.wav`);
                await execAsync(`ffmpeg -y -i "${rawFilePath}" -ar 24000 -ac 1 -c:a pcm_s16le "${wavFilePath}"`);
                
                chunkFiles.push(wavFilePath);
                chunkIndex++;
            }

            if (chunkFiles.length === 0) throw new Error("No text left to synthesize after filtering.");

            // 2. Generate identical standard PCM silence
            const silenceSeconds = parseFloat(currentTask.chunkSilenceSeconds) || 0;
            const silenceFile = path.join(taskTempDir, `silence.wav`);
            if (silenceSeconds > 0 && chunkFiles.length > 1) {
                await execAsync(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${silenceSeconds} -c:a pcm_s16le "${silenceFile}"`);
            }

            // 3. Build Flawless Filter Complex String
            let ffmpegInputs = '';
            let filterStreams = '';
            let inputCount = 0;
            for (let i = 0; i < chunkFiles.length; i++) {
                ffmpegInputs += `-i "${chunkFiles[i]}" `;
                filterStreams += `[${inputCount}:a]`;
                inputCount++;
                if (silenceSeconds > 0 && i < chunkFiles.length - 1) {
                    ffmpegInputs += `-i "${silenceFile}" `;
                    filterStreams += `[${inputCount}:a]`;
                    inputCount++;
                }
            }

            // 4. Run FFmpeg to sequence timeline and encode to CBR
            const finalFormat = FORMAT_EXT[currentTask.format] || 'mp3';
            const finalOutPath = path.join(taskTempDir, `final_out.${finalFormat}`);
            
            let encodeArgs = finalFormat === 'wav' ? '-c:a pcm_s16le' : '-c:a libmp3lame -b:a 64k';
            if (finalFormat === 'opus') encodeArgs = '-c:a libopus -b:a 48k -vbr off';
            if (finalFormat === 'aac') encodeArgs = '-c:a aac -b:a 64k';
            if (finalFormat === 'flac') encodeArgs = '-c:a flac';
            
            await execAsync(`ffmpeg -y ${ffmpegInputs} -filter_complex "${filterStreams}concat=n=${inputCount}:v=0:a=1[outa]" -map "[outa]" -ar 24000 -ac 1 ${encodeArgs} "${finalOutPath}"`);

            // 5. Move finished file to permanent storage
            const finalDest = audioFile(dir, currentTask.audioKey, currentTask.format);
            fs.copyFileSync(finalOutPath, finalDest);

            const manifest = readManifest(dir);
            manifest[currentTask.audioKey] = currentTask.textHash;
            writeManifest(dir, manifest);

            console.log(`[TTS Persist] ✓ Generated & Merged (FFmpeg): ${currentTask.audioKey}`);

        } catch (err) {
            if (err.name === 'AbortError') {
                if (isNuking) console.log(`[TTS Persist] 🛑 Task Destroyed (Queue Cleared).`);
                else {
                    console.log(`[TTS Persist] ⏸ Task Aborted & Re-queued: ${currentTask.audioKey}`);
                    taskQueue.unshift(currentTask); 
                }
            } else {
                console.error(`[TTS Persist] ✕ Task Failed (${currentTask.audioKey}):`, err.message);
            }
        } finally {
            if (fs.existsSync(taskTempDir)) fs.rmSync(taskTempDir, { recursive: true, force: true });
            activeAbortController = null;
            currentTask = null;
        }
    }
    isProcessing = false;
    isNuking = false; 
}

export async function init(router) {
  try {
      if (!fs.existsSync(AUDIO_ROOT)) fs.mkdirSync(AUDIO_ROOT, { recursive: true });
      if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });
      console.log('[TTS Persist] Backend API Mounted. Ready to accept connections.');
  } catch (err) {
      console.error('[TTS Persist] FAILED TO INITIALIZE!', err);
      return Promise.reject(err);
  }

  router.post('/generate-eager', async (req, res) => {
      try {
          const { ttsUrl, ttsApiKey, ttsBody, eagerJobId, chunkIndex } = req.body;
          const headers = { 'Content-Type': 'application/json' };
          if (ttsApiKey && ttsApiKey !== 'sk-none') headers['Authorization'] = `Bearer ${ttsApiKey}`;

          const isLocalHost = ttsUrl.includes('127.0.0.1') || ttsUrl.includes('localhost') || ttsUrl.includes('192.168.') || ttsUrl.startsWith('/');
          if (isLocalHost) {
              if (req.headers['x-csrf-token'] || req.headers['csrf-token']) headers['X-CSRF-Token'] = req.headers['x-csrf-token'] || req.headers['csrf-token'];
              if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
          }

          const fetchRes = await fetch(ttsUrl, { method: 'POST', headers, body: JSON.stringify(ttsBody) });
          if (!fetchRes.ok) return res.status(fetchRes.status).send(await fetchRes.text());

          const buffer = await fetchRes.arrayBuffer();
          
          // EAGER TEMP STASHING: Save file to server instantly so client doesn't have to upload it later
          if (eagerJobId !== undefined && chunkIndex !== undefined) {
              const taskTempDir = path.join(TEMP_ROOT, 'eager_' + safe(eagerJobId));
              // Wipe directory on first chunk to prevent overlap from previous runs
              if (chunkIndex === 0 && fs.existsSync(taskTempDir)) {
                  fs.rmSync(taskTempDir, { recursive: true, force: true });
              }
              if (!fs.existsSync(taskTempDir)) fs.mkdirSync(taskTempDir, { recursive: true });
              
              const rawFilePath = path.join(taskTempDir, `raw_${chunkIndex}.bin`);
              fs.writeFileSync(rawFilePath, Buffer.from(buffer));
          }

          res.set('Content-Type', fetchRes.headers.get('content-type') || 'audio/mpeg');
          res.send(Buffer.from(buffer));
      } catch(e) {
          res.status(500).send(e.message);
      }
  });

  router.post('/queue/add', async (req, res) => {
    const task = req.body;
    if (!task.ttsUrl || !task.audioKey) return res.status(400).json({ error: 'Missing parameters.' });
    task.reqCsrfToken = req.headers['x-csrf-token'] || req.headers['csrf-token'] || '';
    task.reqCookie = req.headers.cookie || '';
    taskQueue = taskQueue.filter(t => t.audioKey !== task.audioKey);

    if (task.priority) {
        if (activeAbortController) {
            activeAbortController.abort(); 
            activeAbortController = null;
            await new Promise(r => setTimeout(r, 50));
        }
        taskQueue.unshift(task); 
    } else taskQueue.push(task); 
    
    processQueue(); 
    return res.json({ success: true, queueLength: taskQueue.length });
  });

  router.post('/queue/pause', (req, res) => { isPaused = true; if (activeAbortController) activeAbortController.abort(); res.json({ success: true }); });
  router.post('/queue/resume', (req, res) => { isPaused = false; processQueue(); res.json({ success: true }); });
  router.get('/queue/status', (req, res) => { res.json({ active: currentTask ? currentTask.audioKey : null, pending: taskQueue.map(t => t.audioKey) }); });
  
  router.post('/queue/clear', (req, res) => { 
      isNuking = true; taskQueue = []; 
      if (activeAbortController) activeAbortController.abort(); 
      
      // Cleanup any abandoned eager temp folders on the server
      if (fs.existsSync(TEMP_ROOT)) {
          fs.readdirSync(TEMP_ROOT).forEach(folder => {
              if (folder.startsWith('eager_')) {
                  try { fs.rmSync(path.join(TEMP_ROOT, folder), { recursive: true, force: true }); } catch (e) {}
              }
          });
      }
      res.json({ success: true }); 
  });

  router.post('/save', async (req, res) => {
      const { audioKey, textHash, charName, chatId, format, chunkSilenceSeconds } = req.body;
      if (!audioKey || !charName || !chatId) return res.status(400).json({ error: 'Missing required parameters' });

      // Look for the folder where /generate-eager stashed the files
      const tempDir = path.join(TEMP_ROOT, 'eager_' + safe(audioKey));
      
      try {
          if (!fs.existsSync(tempDir)) throw new Error("Temp chunks not found on server");
          
          // Sort numerically to ensure raw_10 comes after raw_2
          const rawFiles = fs.readdirSync(tempDir)
              .filter(f => f.startsWith('raw_') && f.endsWith('.bin'))
              .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
              
          if (rawFiles.length === 0) throw new Error("No raw audio files found in stash");

          const chunkFiles = [];
          
          for (let i = 0; i < rawFiles.length; i++) {
              const rawPath = path.join(tempDir, rawFiles[i]);
              const wavPath = path.join(tempDir, `chunk_${i}.wav`);
              await execAsync(`ffmpeg -y -i "${rawPath}" -ar 24000 -ac 1 -c:a pcm_s16le "${wavPath}"`);
              chunkFiles.push(wavPath);
          }

          const silenceSecs = parseFloat(chunkSilenceSeconds) || 0;
          const silenceFile = path.join(tempDir, `silence.wav`);
          if (silenceSecs > 0 && chunkFiles.length > 1) {
              await execAsync(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${silenceSecs} -c:a pcm_s16le "${silenceFile}"`);
          }

          let ffmpegInputs = '';
          let filterStreams = '';
          let inputCount = 0;
          for (let i = 0; i < chunkFiles.length; i++) {
              ffmpegInputs += `-i "${chunkFiles[i]}" `;
              filterStreams += `[${inputCount}:a]`;
              inputCount++;
              if (silenceSecs > 0 && i < chunkFiles.length - 1) {
                  ffmpegInputs += `-i "${silenceFile}" `;
                  filterStreams += `[${inputCount}:a]`;
                  inputCount++;
              }
          }

          const finalFormat = FORMAT_EXT[format] || 'mp3';
          const fixedPath = path.join(tempDir, `fixed.${finalFormat}`);
          
          let encodeArgs = finalFormat === 'wav' ? '-c:a pcm_s16le' : '-c:a libmp3lame -b:a 64k';
          if (finalFormat === 'opus') encodeArgs = '-c:a libopus -b:a 48k -vbr off';
          if (finalFormat === 'aac') encodeArgs = '-c:a aac -b:a 64k';
          if (finalFormat === 'flac') encodeArgs = '-c:a flac';

          await execAsync(`ffmpeg -y ${ffmpegInputs} -filter_complex "${filterStreams}concat=n=${inputCount}:v=0:a=1[outa]" -map "[outa]" -ar 24000 -ac 1 ${encodeArgs} "${fixedPath}"`);

          const dir = chatDir(charName, chatId);
          const finalDest = audioFile(dir, audioKey, format);
          fs.copyFileSync(fixedPath, finalDest);

          const manifest = readManifest(dir);
          manifest[audioKey] = textHash;
          writeManifest(dir, manifest);

          console.log(`[TTS Persist] ✓ Saved & Merged (Eager mode finished): ${audioKey}`);
          res.json({ success: true });
      } catch (err) {
          console.error(`[TTS Persist] ✕ FFmpeg Save Failed (${audioKey}):`, err.message);
          res.status(500).json({ error: err.message });
      } finally {
          if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      }
  });

  router.get('/audio/:char/:chat/:key', (req, res) => {
    const dir  = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
    const file = findAudioFile(dir, req.params.key);
    if (!file) return res.status(404).json({ error: 'Not found' });

    const total = fs.statSync(file).size;
    const range = req.headers.range;
    const ext   = path.extname(file).slice(1).toLowerCase();
    const MIME  = { mp3:'audio/mpeg', opus:'audio/ogg; codecs=opus', aac:'audio/aac', flac:'audio/flac', wav:'audio/wav', pcm:'audio/L16' };

    res.setHeader('Content-Type',  MIME[ext] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (range) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start  = parseInt(s, 10);
      const end    = e ? parseInt(e, 10) : total - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      fs.createReadStream(file).pipe(res);
    }
  });

  router.get('/check/:char/:chat/:key', (req, res) => {
    const dir = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
    const file = findAudioFile(dir, req.params.key);
    const exists = !!file;
    const manifest = exists ? readManifest(dir) : {};
    res.json({ exists, textHash: exists ? (manifest[req.params.key] ?? null) : null });
  });

  router.delete('/audio/:char/:chat/:key', (req, res) => {
    const dir = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
    const file = findAudioFile(dir, req.params.key);
    if (file) fs.unlinkSync(file);
    const manifest = readManifest(dir);
    delete manifest[req.params.key];
    writeManifest(dir, manifest);
    taskQueue = taskQueue.filter(t => t.audioKey !== req.params.key);
    res.json({ success: true });
  });

  router.delete('/slot/:char/:chat/:dateKey', (req, res) => {
    const dir = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
    if (fs.existsSync(dir)) {
      const manifest = readManifest(dir);
      fs.readdirSync(dir).filter(f => f.startsWith(safe(req.params.dateKey) + '_s') && f.match(/\.(mp3|wav|opus|flac|aac)$/)).forEach(f => {
          fs.unlinkSync(path.join(dir, f));
          delete manifest[f.replace(/\.\w+$/, '')];
      });
      writeManifest(dir, manifest);
    }
    res.json({ success: true });
  });

  router.delete('/chat/:char/:chat', (req, res) => {
    const dir = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    isNuking = true; taskQueue = []; 
    if (activeAbortController) activeAbortController.abort();
    res.json({ success: true });
  });

  router.delete('/chat-all/:chat', (req, res) => {
    const targetChat = safe(req.params.chat);
    if (fs.existsSync(AUDIO_ROOT)) {
      const chars = fs.readdirSync(AUDIO_ROOT);
      for (const char of chars) {
        const charDir = path.join(AUDIO_ROOT, char);
        if (fs.statSync(charDir).isDirectory()) {
          const chatDir = path.join(charDir, targetChat);
          if (fs.existsSync(chatDir)) fs.rmSync(chatDir, { recursive: true, force: true });
        }
      }
    }
    isNuking = true; taskQueue = []; 
    if (activeAbortController) activeAbortController.abort();
    res.json({ success: true });
  });

  return Promise.resolve();
}

export async function exit() {
  console.log('[TTS Persist] Unloaded.');
  return Promise.resolve();
}

export const info = { id: 'tts-persist', name: 'TTS Persist', description: 'Server-side FFmpeg persistent TTS.' };