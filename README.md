# Esper

Local-first AI dictation app for macOS — a fork of [Amical](https://github.com/amicalhq/amical).

Esper is an open source AI-powered dictation app that runs entirely on your machine. Powered by [Whisper](https://github.com/openai/whisper) (whisper.cpp, Metal-accelerated) for speech-to-text, it gives you AI dictation with complete privacy: works offline, no cloud required, no usage fees.

## Changes from upstream Amical

- **Tap-to-toggle dictation**: a quick tap of the dictation key (default: fn) starts recording and keeps listening until the next tap. Holding the key still works as classic push-to-talk (release to transcribe). Upstream required a double-tap to enter hands-free mode and discarded quick taps.
- **Streamlined onboarding**: the flow starts at the discovery survey; the use-case survey screen was removed.
- **Rebranded** as Esper.

## Development

```bash
git submodule update --init --recursive   # whisper.cpp
pnpm install
cd apps/desktop
pnpm start          # dev run
pnpm package        # build app bundle (use SKIP_CODESIGNING=true for local builds)
```

Local builds are unsigned; after copying the app bundle to `/Applications`, re-sign it ad-hoc so macOS permission prompts work:

```bash
codesign --force --deep --sign - /Applications/Esper.app
```

## Tech Stack

- 🎤 [Whisper](https://github.com/openai/whisper) / [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- 🧑‍💻 [TypeScript](https://www.typescriptlang.org/)
- 🖥️ [Electron](https://electronjs.org/)
- 🎨 [TailwindCSS](https://tailwindcss.com/) + [Shadcn](https://ui.shadcn.com/)
- 🧘‍♂️ [Zod](https://zod.dev/)
- 🌀 [Turborepo](https://turbo.build/)

## Credits & License

Esper is a fork of [Amical](https://github.com/amicalhq/amical) by Naomi Chopra and Haritabh Singh. Huge thanks to the upstream authors and contributors.

Released under the [MIT License](./LICENSE). The original Amical copyright notice is retained as the license requires; Esper-specific modifications are (c) i4RP under the same license. Bundled third-party components keep their own licenses — notably [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (MIT) and the Whisper models (MIT, OpenAI).

"Amical" is the upstream project's name; this fork is distributed as "Esper" to avoid confusion with the official Amical releases.
