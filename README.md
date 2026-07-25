# signalk-whisper

> **Status: ALPHA.** This SignalK Wyoming system is 100% vibecoded slop. I
> don't have the right hardware yet to test it, so I'm putting it out there
> for people to test in the meantime. It _should_ work. File issues for
> anything that doesn't.

## What is this?

Whisper speech-to-text for [Signal K](https://signalk.org) — it gives your
boat server "ears". The plugin runs the
[Whisper](https://github.com/rhasspy/wyoming-faster-whisper) speech
recognizer as a background service and takes care of everything around it:
starting it in a container (via the
[signalk-container](https://www.npmjs.com/package/signalk-container)
plugin), downloading the speech model, checking that it stays healthy, and
telling the rest of the voice stack where to find it. You never have to
touch docker or podman yourself.

It is the speech-to-text (STT) building block of the
[signalk-wyoming voice-assistant family](https://github.com/hoeken/signalk-wyoming)
— install it together with the `signalk-wyoming` orchestrator to get voice
commands on your boat. Because it speaks the standard
[Wyoming protocol](https://github.com/rhasspy/wyoming), it also works as a
standalone speech-to-text server for other software such as Home Assistant.

## Requirements

- Signal K server ≥ 2.x on **Node 24+**
- The **signalk-container** plugin with a working podman or docker runtime
- RAM for the model: the default `tiny-int8` uses roughly **400–500 MB
  resident** (`base-int8` ≈ 700 MB). The container is capped at 1 GB by
  default so a misbehaving model cannot starve the boat server. The full
  voice stack with whisper is comfortable on a Pi 4/5 with 4 GB. (A
  TTS-only voice install does not need this plugin at all.)

## Install

Install **signalk-whisper** from the Signal K App Store (or `npm install
signalk-whisper` in your server directory), enable it in Plugin Config, and
enable the signalk-container plugin if you have not already.

## Configuration

The plugin ships a graphical configuration panel (Server → Plugin Config →
Whisper STT) with a live container status card, a one-click image update
check/apply, a version dropdown fed by Docker Hub, and all the settings
below — with inline warnings if you pick a heavyweight model or open the
service to the network. On servers without custom-panel support you get a
plain settings form with the same options.

| Setting                  | Default            | Notes                                                                                                                                                                                                                         |
| ------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                  | `tiny-int8`        | One of `tiny-int8`, `base-int8`, `small-int8`, `medium-int8`, `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium.en`, `turbo`. int8 models are recommended (smaller + faster on CPU). See "Choosing a model". |
| `language`               | `en`               | Explicit language code. `auto` enables per-utterance detection but costs speed **and** accuracy on the small models — set it explicitly if you can.                                                                           |
| `initialPrompt`          | nautical word list | A list of words that biases recognition toward your vocabulary — the cheapest accuracy win available. See "The initial prompt". Empty disables it.                                                                            |
| `imageTag`               | `auto`             | `auto` runs the pinned, tested upstream release (**3.5.0**) and follows plugin updates. Set an explicit tag to pin something else.                                                                                            |
| `port`                   | `10300`            | Host TCP port — only used with `bind: 0.0.0.0`, where the service is published on exactly this port. With the default loopback networking the setting is ignored and a host port is assigned automatically.                   |
| `advanced.bind`          | `127.0.0.1`        | `127.0.0.1` keeps whisper local to the boat server (recommended — the orchestrator is its only intended consumer). `0.0.0.0` publishes it on all interfaces, e.g. to share it with Home Assistant. See Security.              |
| `advanced.memoryLimit`   | `1g`               | Hard container memory cap (swap capped to the same value).                                                                                                                                                                    |
| `advanced.restartPolicy` | `unless-stopped`   | Container runtime restart policy.                                                                                                                                                                                             |

### Choosing a model

Bigger models transcribe more accurately but need more RAM and take longer
per utterance.

| Model                                   | Download       | Resident RAM | When                                                                         |
| --------------------------------------- | -------------- | ------------ | ---------------------------------------------------------------------------- |
| `tiny-int8`                             | ≈ 43 MB        | ≈ 400–500 MB | Default. Fine for short commands on a Pi 4.                                  |
| `base-int8`                             | ≈ 80 MB        | ≈ 700 MB     | Recommended on a Pi 5 / x86 box — noticeably better accuracy.                |
| `small-int8` / `medium-int8`            | hundreds of MB | > 1 GB       | Only with plenty of RAM/CPU; raise `memoryLimit`.                            |
| `tiny`–`small.en`, `medium.en`, `turbo` | larger (float) | more         | The `.en` variants are English-only and slightly more accurate at each size. |

Transcription latency is the practical constraint: the signalk-wyoming
webapp's **Test screen** shows a per-transcription latency figure — use it
to decide whether your hardware can afford a bigger model.

(A model setting of `auto` is deliberately **not** offered: with this
service it can silently switch to a much larger non-Whisper backend and
download hundreds of MB.)

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

## First start & offline use

On first start (and after a model change) the container downloads the model
into this plugin's Signal K data directory — the download survives
container recreation and image updates, so it only happens once per model.
The plugin status shows _"starting — first start downloads the model
(tiny-int8 ≈ 43 MB, base-int8 ≈ 80 MB)"_ until the service answers; up to
10 minutes are allowed for slow connections.

**Do the first start (and any model change) while you have internet** — at
sea with no connectivity a never-downloaded model cannot load, and the
plugin will report the failure rather than sit silent.

## Using it from other software

Once ready, the service is a plain Wyoming STT server at
`tcp://<host>:<port>` (normally `tcp://127.0.0.1:10300`):

- **signalk-wyoming** discovers it automatically — nothing to configure.
- **Home Assistant** (or any other Wyoming client) can use it as an STT
  provider: set `advanced.bind` to `0.0.0.0` and point HA's Wyoming
  integration at `tcp://<boat-ip>:10300`.

## HTTP API

| Endpoint                                         | Access                 | Purpose                                                                                        |
| ------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /plugins/signalk-whisper/api/status`        | any authenticated user | Current state: `{ status, uri, tag, containerState, lastHealth, info }`                        |
| `GET /plugins/signalk-whisper/api/versions`      | any authenticated user | Available image versions from Docker Hub (feeds the config panel; works while plugin disabled) |
| `GET /plugins/signalk-whisper/api/update/check`  | admin                  | Check whether a newer image is available                                                       |
| `POST /plugins/signalk-whisper/api/update/apply` | admin                  | Pull and switch to the newer image                                                             |

## Health & notifications

The plugin checks the service every 30 seconds. If it stops answering,
after three consecutive failures (about 90 seconds) it raises the Signal K
notification **`notifications.voice.whisper`** with `state: "alarm"` and
shows an error in Plugin Config. When the service answers again everything
clears back to normal automatically — no action needed.

The alarm is visual-only by design: plugins that read notifications aloud
won't try to _speak_ the voice stack's own failure.

## Security

Wyoming has **no authentication**. Anyone who can reach the port can feed
audio to (and read transcripts from) the service. The default
`bind: 127.0.0.1` keeps it unreachable from the network — only the Signal K
host (and its containers) can use it. Only switch to `0.0.0.0` on a trusted
network, and prefer a firewall rule or VLAN that restricts the port to the
machines that need it (see the signalk-wyoming documentation for a
marina-wifi hardening recipe).

## Development

See [DEVELOPERS.md](DEVELOPERS.md) for the code layout, build/test
commands, architecture notes, and the service-discovery contract.

## License

Apache-2.0 © hoeken. The upstream Whisper service is
[rhasspy/wyoming-faster-whisper](https://github.com/rhasspy/wyoming-faster-whisper)
(MIT).
