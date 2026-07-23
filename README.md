# signalk-whisper

> **Status: pre-release placeholder.** This package reserves the name — nothing is functional yet. The design is under community review at **[hoeken/signalk-wyoming](https://github.com/hoeken/signalk-wyoming)** — read the spec there and leave feedback.

[Wyoming](https://github.com/rhasspy/wyoming) [Whisper](https://github.com/rhasspy/wyoming-faster-whisper) speech-to-text service for [Signal K](https://signalk.org), running as a managed container. Part of the **signalk-wyoming** offline voice assistant family, but fully standalone: any Wyoming client (including Home Assistant) can use it.

| Plugin | Role |
|--------|------|
| [signalk-wyoming](https://github.com/hoeken/signalk-wyoming) | Orchestrator — spec and discussion live here |
| **signalk-whisper** | Speech-to-text |
| [signalk-piper](https://github.com/hoeken/signalk-piper) | Text-to-speech |
| [signalk-openwakeword](https://github.com/hoeken/signalk-openwakeword) | Wake word detection |

## License

Apache-2.0
