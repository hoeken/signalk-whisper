# signalk-whisper

Whisper speech-to-text for Signal K, speaking the [Wyoming
protocol](https://github.com/rhasspy/wyoming). The plugin runs the
[`rhasspy/wyoming-whisper`](https://hub.docker.com/r/rhasspy/wyoming-whisper)
image in a container managed through
[signalk-container](https://www.npmjs.com/package/signalk-container), waits
until the service actually answers a Wyoming `describe` request, keeps
health-checking it, and advertises it on the shared `wyoming-service`
discovery channel. It is the STT (ASR) building block of the
[signalk-wyoming voice-assistant family](https://github.com/hoeken/signalk-wyoming)
— install it together with the `signalk-wyoming` orchestrator to get voice
commands on your boat — but it works equally well as a standalone Wyoming
STT server for other consumers (e.g. Home Assistant).

## Requirements

- Signal K server ≥ 2.x on **Node 24+**
- The **signalk-container** plugin with a working podman or docker runtime
  (this plugin declares `"signalk": { "requires": ["signalk-container"] }`)
- RAM for the model: the default `tiny-int8` uses roughly **400–500 MB
  resident** (`base-int8` ≈ 700 MB). The container is capped at 1 GB by
  default so a misbehaving model cannot OOM the boat server. A TTS-only
  voice install does not need this plugin at all; the full voice stack with
  whisper is comfortable on a Pi 4/5 with 4 GB.

## Install

Install **signalk-whisper** from the Signal K App Store (or `npm install
signalk-whisper` in your server directory), enable it in Plugin Config, and
enable the signalk-container plugin if you have not already.

## Configuration

| Setting                  | Default            | Notes                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                  | `tiny-int8`        | One of `tiny-int8`, `base-int8`, `small-int8`, `medium-int8`, `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium.en`, `turbo`. int8 models are recommended (smaller + faster on CPU). `auto` is deliberately **not** offered: with this image it can silently switch to a ~0.6 B-parameter sherpa/Parakeet backend and download hundreds of MB. |
| `language`               | `en`               | Explicit language code. `auto` enables per-utterance detection but costs speed **and** accuracy on the small models — set it explicitly if you can.                                                                                                                                                                                                             |
| `initialPrompt`          | nautical word list | Passed as `--initial-prompt` to bias recognition toward your vocabulary — the cheapest accuracy win available. See below. Empty disables it.                                                                                                                                                                                                                    |
| `imageTag`               | `auto`             | `auto` runs the pinned, tested upstream release (**3.5.0**) and follows plugin updates. Set an explicit tag to pin something else.                                                                                                                                                                                                                              |
| `port`                   | `10300`            | Host TCP port — only used with `bind: 0.0.0.0`, where the service is published on exactly this port. With the default loopback networking the setting is ignored: signalk-container assigns the host port automatically (10300, or the next free port if that is taken).                                                                                        |
| `advanced.bind`          | `127.0.0.1`        | `127.0.0.1` keeps whisper local to the boat server (recommended — the orchestrator is its only intended consumer). `0.0.0.0` publishes it on all interfaces, e.g. to share it with Home Assistant. See Security.                                                                                                                                                |
| `advanced.memoryLimit`   | `1g`               | Hard container memory cap (swap capped to the same value).                                                                                                                                                                                                                                                                                                      |
| `advanced.restartPolicy` | `unless-stopped`   | Container runtime restart policy.                                                                                                                                                                                                                                                                                                                               |

### Choosing a model

| Model                                   | Download       | Resident RAM | When                                                                         |
| --------------------------------------- | -------------- | ------------ | ---------------------------------------------------------------------------- |
| `tiny-int8`                             | ≈ 43 MB        | ≈ 400–500 MB | Default. Fine for short commands on a Pi 4.                                  |
| `base-int8`                             | ≈ 80 MB        | ≈ 700 MB     | Recommended on a Pi 5 / x86 box — noticeably better accuracy.                |
| `small-int8` / `medium-int8`            | hundreds of MB | > 1 GB       | Only with plenty of RAM/CPU; raise `memoryLimit`.                            |
| `tiny`–`small.en`, `medium.en`, `turbo` | larger (float) | more         | The `.en` variants are English-only and slightly more accurate at each size. |

Transcription latency is the practical constraint: the signalk-wyoming
webapp's **Test screen** shows a per-transcription latency figure — use it
to decide whether your hardware can afford a bigger model.

### The initial prompt

The shipped default biases Whisper toward sailing vocabulary:

> Genoa, jib, mainsail, spinnaker, windlass, gybe, tack, halyard, winch,
> anchor chain, rode, bilge, galley, helm, autopilot, waypoint, knots, port,
> starboard, bow, stern, leeward, windward, reef, furl, log position, anchor
> alarm, engine, throttle.

Customize it with words Whisper would otherwise mis-hear, for example:

- your **vessel name** ("Wildeling"),
- **local place and port names** ("Port Townsend, Deception Pass, Anacortes"),
- **boat-specific gear** ("watermaker, Hydrovane, staysail, preventer").

## First start & offline behavior

On first start (and after a model change) the container downloads the model
into this plugin's Signal K data directory, mounted at `/data` — the
download survives container recreation and image updates. The plugin status
shows _"starting — first start downloads the model (tiny-int8 ≈ 43 MB,
base-int8 ≈ 80 MB)"_ until the service answers; the readiness deadline is
10 minutes to allow slow connections. **Do the first start (and any model
change) while you have internet** — at sea with no connectivity a
never-downloaded model cannot load, and the plugin will report the failure
rather than sit silent.

## How other software uses it

Once ready, the service is a plain Wyoming STT server at
`tcp://<host>:<port>` (normally `tcp://127.0.0.1:10300`):

- **signalk-wyoming** discovers it automatically: the plugin emits
  `{ plugin: "signalk-whisper", type: "asr", uri, status }` on the
  `wyoming-service` PropertyValues channel on every status change.
- **Home Assistant** (or any other Wyoming client) can use it as an STT
  provider: set `advanced.bind` to `0.0.0.0` and point HA's Wyoming
  integration at `tcp://<boat-ip>:10300`.

Status endpoint (any authenticated user):
`GET /plugins/signalk-whisper/api/status` →
`{ status, uri, tag, containerState, lastHealth, info }`. Admins can check
and apply image updates via `GET /plugins/signalk-whisper/api/update/check`
and `POST /plugins/signalk-whisper/api/update/apply`.

## Health & notifications

After startup the plugin sends a Wyoming `describe` ping every 30 s. Three
consecutive failures raise the Signal K notification
**`notifications.voice.whisper`** with `state: "alarm"` (method `visual`
only — deliberately not `sound`, so notification-to-speech bridges don't
try to _speak_ the voice stack's own failure), set a plugin error, and mark
the service `error` on `wyoming-service`. When the service answers again
everything clears back to `ready`/`normal` automatically. Status flapping
is debounced (≥ 500 ms between emissions) and pathological churn is logged
instead of emitted.

## Security

Wyoming has **no authentication**. Anyone who can reach the port can feed
audio to (and read transcripts from) the service. The default
`bind: 127.0.0.1` keeps it unreachable from the network — only the Signal K
host (and its containers) can use it. Only switch to `0.0.0.0` on a trusted
network, and prefer a firewall rule or VLAN that restricts the port to the
machines that need it (see the signalk-wyoming documentation for a
marina-wifi hardening recipe).

## Development

```sh
npm install --install-links   # copies the local signalk-wyoming devDep
npm run build                 # tsc → dist/
npm test                      # typecheck + vitest (mock Wyoming server, fake container manager)
npm run ci-lint               # eslint + prettier --check
npm run format                # prettier + eslint --fix
```

Tests run against the scriptable `MockWyomingServer` from the
`signalk-wyoming` package's `signalk-wyoming/mock` export and a fake
`signalk-container` manager — no docker/podman or network access needed.
Until `signalk-wyoming` is published to npm, that devDependency is a
`file:../signalk-wyoming` link (install with `npm install --install-links`
next to a checkout of
[hoeken/signalk-wyoming](https://github.com/hoeken/signalk-wyoming)); it
will switch to a semver range at first publish.

Production code has **no** runtime dependency on the orchestrator package:
the Wyoming `describe` handshake is a ~140-line embedded client
(`src/wyoming.ts`).

## License

Apache-2.0 © hoeken. The upstream Whisper service is
[rhasspy/wyoming-faster-whisper](https://github.com/rhasspy/wyoming-faster-whisper)
(MIT).
