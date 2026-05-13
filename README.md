# TTS Persist (Server Plugin) for SillyTavern

This is the **Backend Server Plugin** component for the TTS Persist extension. 

It handles saving generated TTS audio files directly to your SillyTavern `data` folder, merging chunked audio (WAV/MP3 manipulation), and managing background task queues so you don't have to wait for audio to generate before continuing your chat.

⚠️ **CRITICAL REQUIREMENT:** This Server plugin does nothing on its own. You must also install the UI Extension in SillyTavern.

**UI Extension Link:** [https://github.com/DBMePls/sillytavern-tts-persist-ui](https://github.com/DBMePls/sillytavern-tts-persist-ui)

## Features
- **Persistent Storage:** Audio files are saved to `SillyTavern/data/tts-persist/`, meaning you can replay them on any device or after a page refresh.
- **Background Queue:** Audio generates in the background while you continue to chat.
- **Dynamic Merging:** Automatically merges audio chunks into a single file for WAV and MP3 formats.
- **Swipe Support:** Saves audio for different message swipes.
- **Automatic Updates:** If installed via `git clone`, SillyTavern will automatically check for updates on startup.

## Installation 

1. Open your terminal or command prompt.
2. Navigate to your base SillyTavern installation folder.
3. Go into the `plugins` directory:
   ```bash
   cd plugins
   ```
4. Clone this repository:
   ```bash
   git clone https://github.com/DBMePls/sillytavern-tts-persist-server
   ```
5. Open SillyTavern's `config.yaml` file (located in your main SillyTavern folder).
6. Ensure `enableServerPlugins` is set to `true`:
   ```yaml
   enableServerPlugins: true
   ```
   *(Optional: Ensure `enableServerPluginsAutoUpdate: true` is also set so this plugin stays updated automatically!)*
7. **Restart your SillyTavern server.** 

## Verification
Upon starting your SillyTavern server, look for the following lines in the terminal logs to confirm it is working:
```text
[TTS Persist] Booting plugin...
[TTS Persist] Backend API Mounted. Ready to accept connections.
```