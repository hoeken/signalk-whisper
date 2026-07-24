# v0.1.0

Initial release: Whisper speech-to-text (Wyoming protocol) for Signal K. Runs the `rhasspy/wyoming-whisper` image in a container managed through signalk-container — the STT building block of the signalk-wyoming voice-assistant family, also usable as a standalone Wyoming STT server (e.g. for Home Assistant).

- Managed container lifecycle via signalk-container: pinned, tested upstream release (3.5.0) with `imageTag: auto` following plugin updates, 1 GB memory cap by default, and admin API endpoints to check/apply image updates.
- Model selection (`tiny-int8` default through `medium-int8`, float and `.en` variants, `turbo`) with explicit `--model` always passed — no silent `auto` backend switches; models download once into the plugin's data directory and survive container recreation.
- Explicit language setting (default `en`) and a user-editable initial prompt shipped with a nautical word list to bias recognition toward sailing vocabulary.
- Readiness gate on a real Wyoming `describe` answer (10-minute first-start deadline for model downloads), then periodic health checks every 30 s; three consecutive failures raise the `notifications.voice.whisper` alarm and recovery clears it automatically.
- Advertises itself on the shared `wyoming-service` discovery channel (`{ plugin, type: "asr", uri, status }`) so the signalk-wyoming orchestrator picks it up automatically; debounced status emissions.
- Secure by default: binds to `127.0.0.1` (Wyoming has no authentication); opt-in `0.0.0.0` bind for sharing on a trusted network.
- Requires Signal K server 2.x on Node 24+ and the signalk-container plugin with a working podman or docker runtime.
