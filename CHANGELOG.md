# v0.2.0

Nothing to reconfigure — existing settings carry over unchanged. The plugin
now depends on signalk-container-helper 0.2.1 or later, which is installed
automatically with the update.

- **New graphical configuration panel.** Server → Plugin Config → Whisper
  STT is now a real panel instead of the bare settings form. You can see at
  a glance whether the service and its container are running, check for and
  apply image updates with one click, and pick the service version from a
  dropdown of available releases. The panel warns you inline before you
  pick a model that is heavy for your hardware or open the service to the
  whole network. On servers without custom-panel support you keep the plain
  settings form, which works exactly as before.
- **Pick a version before enabling.** The version dropdown works even while
  the plugin is disabled, so you can choose the image version up front. If
  Docker Hub is unreachable — say, offshore — the panel keeps showing the
  last version list it saw.

# v0.1.0

Initial release: Whisper speech-to-text (Wyoming protocol) for Signal K.
Runs the `rhasspy/wyoming-whisper` service in a container managed through
signalk-container — the speech-to-text building block of the
signalk-wyoming voice-assistant family, also usable as a standalone Wyoming
STT server (e.g. for Home Assistant).

- **Hands-off service management.** The plugin starts a pinned, tested
  release of the service (3.5.0), keeps it running, and caps it at 1 GB of
  memory by default so a misbehaving model cannot starve the boat server.
  With the default `imageTag: auto` you get newly tested releases along
  with plugin updates; admins can also check for and apply image updates on
  demand.
- **Your choice of model.** From the fast `tiny-int8` default up through
  `medium-int8`, plus float and English-only variants. The model you pick
  is exactly what runs — no silent switches to a different backend. Models
  download once into the plugin's data directory and survive container
  restarts and image updates.
- **Tuned for the boat out of the box.** Explicit language setting (default
  `en`) and an editable initial prompt pre-filled with a nautical word
  list, biasing recognition toward sailing vocabulary — add your vessel
  name and local place names for the cheapest accuracy win available.
- **Knows when it is really ready.** The service is not reported ready
  until it actually answers a Wyoming request (the first start allows 10
  minutes for the model download), and it is health-checked every 30
  seconds afterwards. Three consecutive failures raise the
  `notifications.voice.whisper` alarm; recovery clears it automatically.
- **Plugs into the voice stack automatically.** The signalk-wyoming
  orchestrator discovers this plugin on its own — no addresses or ports to
  configure.
- **Secure by default.** The service binds to `127.0.0.1` and is
  unreachable from the network (Wyoming has no authentication); sharing it
  on a trusted network — e.g. with Home Assistant — is an explicit opt-in.
- Requires Signal K server 2.x on Node 24+ and the signalk-container plugin
  with a working podman or docker runtime.
