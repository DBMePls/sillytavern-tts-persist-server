/**
 * TTS Persist \u2014 Server Plugin
 */

console.log('[TTS Persist] Booting plugin...');

import path from 'path';
import fs from 'fs';

// Use process.cwd() to guarantee we hit the SillyTavern root directory securely
const AUDIO_ROOT = path.join(process.cwd(), 'data', 'tts-persist');

function safe(str) {
  return String(str ?? 'unknown').replace(/[/\\:*?"<>|\s]/g, '_').substring(0, 128);
}

function chatDir(char, chat) {
  const d = path.join(AUDIO_ROOT, safe(char), safe(chat));
  if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
  }
  return d;
}

const FORMAT_EXT = { mp3: 'mp3', opus: 'opus', aac: 'aac', flac: 'flac', wav: 'wav', pcm: 'pcm' };

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

// Erase MP3 ID3 & Xing headers so concatenated files have perfect duration in Chrome natively
function cleanMp3Buffer(buffer) {
    let offset = 0;
    // Strip ID3v2
    if (buffer.length > 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
        const size = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
        offset = 10 + size;
    }
    let data = offset > 0 ? buffer.subarray(offset) : buffer;
    
    // Strip ID3v1
    if (data.length >= 128) {
        const end = data.length - 128;
        if (data[end] === 0x54 && data[end+1] === 0x41 && data[end+2] === 0x47) { // "TAG"
            data = data.subarray(0, end);
        }
    }
    
    // Wipe Xing/Info tags
    const scanLimit = Math.min(data.length, 8192);
    for (let i = 0; i < scanLimit - 4; i++) {
        if (
            (data[i] === 0x58 && data[i+1] === 0x69 && data[i+2] === 0x6E && data[i+3] === 0x67) || // "Xing"
            (data[i] === 0x49 && data[i+1] === 0x6E && data[i+2] === 0x66 && data[i+3] === 0x6F)    // "Info"
        ) {
            data[i] = 0; data[i+1] = 0; data[i+2] = 0; data[i+3] = 0;
            break;
        }
    }
    return data;
}

function createWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
    const pcmDataSize = pcmBuffer.length;
    const blockAlign = numChannels * (bitDepth / 8);
    const byteRate = sampleRate * blockAlign;
    const wavBuffer = Buffer.alloc(44 + pcmDataSize);

    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(36 + pcmDataSize, 4);
    wavBuffer.write('WAVE', 8);
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16); 
    wavBuffer.writeUInt16LE(1, 20);  
    wavBuffer.writeUInt16LE(numChannels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitDepth, 34);
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(pcmDataSize, 40);

    pcmBuffer.copy(wavBuffer, 44);
    return wavBuffer;
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '_manifest.json'), 'utf8')); }
  catch { return {}; }
}

function writeManifest(dir, m) {
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(m, null, 2));
}

// \u2500\u2500 ABORTABLE BACKGROUND TASK QUEUE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

let taskQueue = [];
let isProcessing = false;
let isPaused = false;
let isNuking = false; 
let currentTask = null;
let activeAbortController = null;

async function processQueue() {
    if (isProcessing || isPaused) return;
    isProcessing = true;

    while (taskQueue.length > 0) {
        if (isPaused) break;
        currentTask = taskQueue.shift(); 
        activeAbortController = new AbortController();
        
        try {
            const dir = chatDir(currentTask.charName, currentTask.chatId);
            
            if (findAudioFile(dir, currentTask.audioKey)) {
                currentTask = null;
                continue;
            }

            const headers = { 'Content-Type': 'application/json' };
            if (currentTask.ttsApiKey && currentTask.ttsApiKey !== 'sk-none') {
                headers['Authorization'] = `Bearer ${currentTask.ttsApiKey}`;
            }

            // INJECT AUTH: LAN IP CSRF Forwarding
            const isLocalHost = currentTask.ttsUrl.includes('127.0.0.1') || 
                                currentTask.ttsUrl.includes('localhost') || 
                                currentTask.ttsUrl.includes('192.168.') || 
                                currentTask.ttsUrl.startsWith('/');
                                
            if (isLocalHost) {
                if (currentTask.reqCsrfToken) headers['X-CSRF-Token'] = currentTask.reqCsrfToken;
                if (currentTask.reqCookie) headers['Cookie'] = currentTask.reqCookie;
            }

            const inputPayload = currentTask.ttsBody.input;
            const chunks = Array.isArray(inputPayload) ? inputPayload : [{ text: inputPayload, voice: currentTask.ttsBody.voice }];
            
            const audioBuffers = [];

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
                audioBuffers.push(Buffer.from(arrayBuf));
            }

            if (audioBuffers.length === 0) throw new Error("No text left to synthesize after filtering empty chunks.");

            let mergedBuf;
            let finalFormat = currentTask.format;
            const silenceSeconds = parseFloat(currentTask.chunkSilenceSeconds) || 0;

            if (finalFormat === 'wav' || finalFormat === 'pcm') {
                let totalPcmSize = 0;
                const pcmBuffers = [];
                let sampleRate = 24000;

                for (let i = 0; i < audioBuffers.length; i++) {
                    const buf = audioBuffers[i];
                    
                    if (finalFormat === 'wav' && buf.length > 44) {
                        if (i === 0) {
                            sampleRate = buf.readUInt32LE(24);
                        }
                        const pcm = buf.subarray(44);
                        pcmBuffers.push(pcm);
                        totalPcmSize += pcm.length;
                    } else {
                        pcmBuffers.push(buf);
                        totalPcmSize += buf.length;
                    }

                    if (silenceSeconds > 0 && i < audioBuffers.length - 1) {
                        const silenceBytes = Math.floor(sampleRate * 2 * silenceSeconds);
                        const silenceBuf = Buffer.alloc(silenceBytes); 
                        pcmBuffers.push(silenceBuf);
                        totalPcmSize += silenceBytes;
                    }
                }

                const mergedPcm = Buffer.concat(pcmBuffers, totalPcmSize);
                mergedBuf = createWavBuffer(mergedPcm, sampleRate, 1, 16);
                finalFormat = 'wav';
            } else if (finalFormat === 'mp3') {
                const cleanBuffers = audioBuffers.map(b => cleanMp3Buffer(b));
                mergedBuf = Buffer.concat(cleanBuffers);
            } else {
                mergedBuf = Buffer.concat(audioBuffers);
            }

            const file = audioFile(dir, currentTask.audioKey, finalFormat);
            fs.writeFileSync(file, mergedBuf);

            const manifest = readManifest(dir);
            manifest[currentTask.audioKey] = currentTask.textHash;
            writeManifest(dir, manifest);

            console.log(`[TTS Persist] \u2713 Generated & Merged (Background): ${currentTask.audioKey}`);
        } catch (err) {
            if (err.name === 'AbortError') {
                if (isNuking) {
                    console.log(`[TTS Persist] \U0001f6d1 Task Destroyed (Queue Cleared).`);
                } else {
                    console.log(`[TTS Persist] \u23f8 Task Aborted & Re-queued: ${currentTask.audioKey}`);
                    taskQueue.unshift(currentTask); 
                }
            } else {
                console.error(`[TTS Persist] \u2715 Task Failed (${currentTask.audioKey}):`, err.message);
            }
        } finally {
            activeAbortController = null;
            currentTask = null;
        }
    }
    isProcessing = false;
    isNuking = false; 
}

// \u2500\u2500 Plugin Initialization \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function init(router) {
  try {
      if (!fs.existsSync(AUDIO_ROOT)) {
          fs.mkdirSync(AUDIO_ROOT, { recursive: true });
      }
      console.log('[TTS Persist] Backend API Mounted. Ready to accept connections.');
  } catch (err) {
      console.error('[TTS Persist] FAILED TO INITIALIZE: Could not create data directory!', err);
      return Promise.reject(err);
  }

  // --- DIRECT PROXY FOR EAGER GENERATION TO FIX API KEY STRIPPING ---
  router.post('/generate-eager', async (req, res) => {
      try {
          const { ttsUrl, ttsApiKey, ttsBody } = req.body;
          const headers = { 'Content-Type': 'application/json' };
          if (ttsApiKey && ttsApiKey !== 'sk-none') {
              headers['Authorization'] = `Bearer ${ttsApiKey}`;
          }

          const isLocalHost = ttsUrl.includes('127.0.0.1') || 
                              ttsUrl.includes('localhost') || 
                              ttsUrl.includes('192.168.') || 
                              ttsUrl.startsWith('/');
                              
          if (isLocalHost) {
              if (req.headers['x-csrf-token'] || req.headers['csrf-token']) {
                  headers['X-CSRF-Token'] = req.headers['x-csrf-token'] || req.headers['csrf-token'];
              }
              if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
          }

          const fetchRes = await fetch(ttsUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(ttsBody)
          });

          if (!fetchRes.ok) {
              const errText = await fetchRes.text();
              console.error(`[TTS Persist] Eager Proxy Error ${fetchRes.status}:`, errText);
              return res.status(fetchRes.status).send(errText);
          }

          const buffer = await fetchRes.arrayBuffer();
          res.set('Content-Type', fetchRes.headers.get('content-type') || 'audio/mpeg');
          res.send(Buffer.from(buffer));
      } catch(e) {
          console.error(`[TTS Persist] Eager Proxy Exception:`, e);
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
    } else {
        taskQueue.push(task); 
    }
    
    processQueue(); 
    return res.json({ success: true, queueLength: taskQueue.length });
  });

  router.post('/queue/pause', (req, res) => {
      isPaused = true;
      if (activeAbortController) activeAbortController.abort();
      res.json({ success: true });
  });

  router.post('/queue/resume', (req, res) => {
      isPaused = false;
      processQueue();
      res.json({ success: true });
  });

  router.get('/queue/status', (req, res) => {
      res.json({
          active: currentTask ? currentTask.audioKey : null,
          pending: taskQueue.map(t => t.audioKey)
      });
  });

  router.post('/queue/clear', (req, res) => {
      isNuking = true; 
      taskQueue = [];
      if (activeAbortController) activeAbortController.abort();
      res.json({ success: true });
  });

  router.post('/save', (req, res) => {
      const { audioKey, textHash, charName, chatId, audioData, format } = req.body;
      if (!audioKey || !charName || !chatId || !audioData) return res.status(400).json({ error: 'Missing required parameters' });

      try {
          const dir = chatDir(charName, chatId);
          const file = audioFile(dir, audioKey, format || 'wav');
          const buf = Buffer.from(audioData, 'base64');
          fs.writeFileSync(file, buf);

          const manifest = readManifest(dir);
          manifest[audioKey] = textHash;
          writeManifest(dir, manifest);

          console.log(`[TTS Persist] \u2713 Saved merged audio (Eager): ${audioKey}`);
          res.json({ success: true });
      } catch (err) {
          console.error(`[TTS Persist] \u2715 Save Failed (${audioKey}):`, err.message);
          res.status(500).json({ error: err.message });
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
    const dir      = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
    const file     = findAudioFile(dir, req.params.key);
    const exists   = !!file;
    const manifest = exists ? readManifest(dir) : {};
    res.json({ exists, textHash: exists ? (manifest[req.params.key] ?? null) : null });
  });

  router.delete('/audio/:char/:chat/:key', (req, res) => {
    const dir  = path.join(AUDIO_ROOT, safe(req.params.char), safe(req.params.chat));
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
    isNuking = true;
    taskQueue = []; 
    if (activeAbortController) activeAbortController.abort();
    res.json({ success: true });
  });

  // NEW ENDPOINT: Deletes a specific chat ID across ALL character/persona folders
  router.delete('/chat-all/:chat', (req, res) => {
    const targetChat = safe(req.params.chat);
    if (fs.existsSync(AUDIO_ROOT)) {
      const chars = fs.readdirSync(AUDIO_ROOT);
      for (const char of chars) {
        const charDir = path.join(AUDIO_ROOT, char);
        if (fs.statSync(charDir).isDirectory()) {
          const chatDir = path.join(charDir, targetChat);
          if (fs.existsSync(chatDir)) {
            fs.rmSync(chatDir, { recursive: true, force: true });
          }
        }
      }
    }
    isNuking = true;
    taskQueue = []; 
    if (activeAbortController) activeAbortController.abort();
    res.json({ success: true });
  });

  return Promise.resolve();
}

export async function exit() {
  console.log('[TTS Persist] Unloaded.');
  return Promise.resolve();
}

export const info = { 
  id: 'tts-persist', 
  name: 'TTS Persist', 
  description: 'Server-side persistent TTS with background queue and priority management.' 
};