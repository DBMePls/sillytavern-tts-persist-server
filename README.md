# TTS Persist (FFmpeg Flawless Filter Edition) - v8.2.0

A highly optimized, server-side permanent TTS generation plugin for SillyTavern. 

This plugin intercepts TTS requests, downloads the audio directly to your SillyTavern server, and permanently saves it. It features a background queue, multi-voice segmentation (different voices for quotes, actions, and narration), and a highly efficient streaming architecture.

## ⚠️ PREREQUISITE: FFmpeg is REQUIRED
This plugin uses advanced FFmpeg complex filters to standardize sample rates (fixing Chrome duration bugs), inject true silence between paragraphs, and stitch multiple character voices into a single flawless audio file.

**You MUST have FFmpeg installed on the machine running your SillyTavern server and added to your system PATH.**

### How to install FFmpeg:

* **Windows:** 
  * Open Command Prompt or PowerShell and run: `winget install ffmpeg`
  * *Alternatively:* Download the essential build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), extract it, and add the `bin` folder to your Windows Environment Variables PATH.
* **Linux (Debian/Ubuntu):**
  * Run: `sudo apt update && sudo apt install ffmpeg`
* **macOS:**
  * Run: `brew install ffmpeg`

**To verify installation:** Open a terminal on your server and type `ffmpeg -version`. If it prints version information, you are ready to go.

## 📦 Installation

This extension consists of two parts: a UI (Client) and a Plugin (Server).

1. **Install the Server Plugin:**
   * Place the `sillytavern-tts-persist-server` folder into your SillyTavern plugins directory:
     `SillyTavern/plugins/sillytavern-tts-persist-server/`
2. **Install the UI Extension:**
   * Place the `sillytavern-tts-persist-ui` folder into your SillyTavern third-party extensions directory:
     `SillyTavern/public/extensions/third-party/sillytavern-tts-persist-ui/`
3. **Restart SillyTavern.**

## ⚙️ Features
* **Background Generation:** Close your tab or lose internet connection—the server will continue generating and saving the audio in the background.
* **Smart Segmentation:** Assign distinct voices to `"dialogue"`, `*actions*`, and standard narration. The plugin will shatter the paragraph, generate the separate voices, and FFmpeg will sequence them back together flawlessly.
* **Perfect Seek Timelines:** Converts all incoming TTS API data to standard 24kHz PCM WAVs before encoding them to CBR (Constant Bitrate) MP3/Opus/AAC. This guarantees the Chrome media player calculates the duration perfectly, preventing the "jumping seek bar" bug.
* **Custom Silence Injection:** Need a pause between paragraphs? Set a silence duration in the UI, and FFmpeg will generate a true blank audio track and splice it between your chunks.

## 🐛 Troubleshooting
**"Task Failed: Command failed: ffmpeg..."**
* FFmpeg is not installed, or SillyTavern doesn't have permission to run it. Ensure `ffmpeg` is in your system PATH. Restart your SillyTavern command prompt/terminal after installing FFmpeg.

**"Audio stops playing / UI says Error" during Streaming**
* Check the SillyTavern server console. If the TTS API provider times out or returns an error, the eager stash will abort and clean itself up.

**Multi-Paragraph Quotes aren't using the correct voice**
* If you use "Paragraph Chunking", the text is split by line breaks *before* the regex searches for quotes. If a quote spans across multiple paragraphs, the regex won't detect it. Disable chunking or keep quotes within single paragraphs for perfect multi-voice segmentation.