# Sur Guru

Mobile-first singing practice MVP with browser pitch detection and an optional ElevenLabs guru voice.

## Local development

```bash
cp .env.example .env
python3 server.py
```

Open `http://localhost:8123`. Microphone access requires `localhost` or HTTPS.

Without an ElevenLabs key, the app uses the browser's Hindi speech synthesis. With a key, `/api/speak` returns ElevenLabs audio without exposing the key to the browser.

## Coolify

Create a Docker application with the build context set to this directory. Add these environment variables as secrets:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_MODEL_ID` (optional, defaults to `eleven_multilingual_v2`)
- `PORT` (optional, defaults to `8123`)

Point your domain to the Coolify server and enable HTTPS before testing microphone access. Keep the API key server-side and use only one of your ElevenLabs keys for this app so usage can be monitored and rotated independently.
