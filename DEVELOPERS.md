# Developing signalk-whisper

Technical reference for contributors and for developers integrating with
the plugin. User-facing documentation lives in [README.md](README.md).

## Code layout

| Path               | Contents                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`     | Plugin entry point: schema, start/stop, HTTP routes (`registerWithRouter`), admin guard for the update endpoints |
| `src/config.ts`    | Settings schema, validation, and derivation of the container spec from settings                                  |
| `src/service.ts`   | Container lifecycle, readiness gate, health-check loop, and `wyoming-service` discovery emission                 |
| `src/wyoming.ts`   | Embedded Wyoming `describe` client (~140 lines) — raw TCP, JSONL header framing                                  |
| `src/configpanel/` | React source for the Admin UI configuration panel (built into `public/`)                                         |
| `test/`            | Vitest suites + fixtures                                                                                         |
| `public/`          | Built config-panel bundle (webpack output, shipped in the npm package via `files`)                               |

## Commands

```sh
npm install
npm run build                 # tsc → dist/, then webpack → public/ (config panel)
npm test                      # typecheck (tsconfig.test.json) + vitest
npm run test:watch            # vitest watch mode
npm run ci-lint               # eslint + prettier --check
npm run format                # prettier + eslint --fix
```

## Testing

Tests run against the scriptable `MockWyomingServer` from the
[signalk-wyoming](https://github.com/hoeken/signalk-wyoming) package's
`signalk-wyoming/mock` export and a fake `signalk-container` manager — no
docker/podman or network access needed.

`signalk-wyoming` is a **devDependency only**. Production code has no
runtime dependency on the orchestrator package: the Wyoming `describe`
handshake is the embedded client in `src/wyoming.ts`.

## Architecture notes

### Readiness gate

The signalk-container-helper's HTTP `readiness` option is deliberately
omitted — it is HTTP-only and a Wyoming TCP port can never satisfy it.
Readiness is our own loop: the plugin repeatedly attempts a Wyoming
`describe` handshake until the service answers, with a
`gateDeadlineMs = 600_000` (10 min) deadline to allow the first-start model
download. Because the helper may move the published host port on container
recreation (loopback networking auto-assigns ports), the URI is re-resolved
after updates.

### Health loop

After the gate passes, a `describe` ping runs every
`healthIntervalMs = 30_000`. Three consecutive failures →
`notifications.voice.whisper` at `state: "alarm"` (method `["visual"]`
only — deliberately not `sound`, so notification-to-speech bridges don't
speak the voice stack's own failure), a plugin error status, and an `error`
announcement on the discovery channel. A successful ping resets the failure
counter and clears everything back to `ready`/`normal`.

### Service discovery (`wyoming-service`)

On every status change the plugin emits a family-spec §3.1 announcement on
the shared `wyoming-service` PropertyValues channel:

```json
{
  "plugin": "signalk-whisper",
  "type": "asr",
  "uri": "tcp://127.0.0.1:10300",
  "status": "ready"
}
```

Emission discipline (see `StatusEmitter` in `src/service.ts`):

- **Debounce:** minimum 500 ms between emissions (`minIntervalMs`); flaps
  inside the window collapse to the latest value.
- **Flap suppression:** more than `flapLimit = 10` transitions within the
  window is logged as pathological churn instead of emitted.
- **Cap safety:** `emitPropertyValue` is wrapped in try/catch. The
  server-wide PropertyValues cap throws for every emitter once reached, so
  on failure the emitter disables itself for the rest of the run rather
  than spamming errors.

### Config panel build

The panel is a webpack **Module Federation remote** built by
`webpack.config.cjs` (`.cjs` because the package is ESM) into `public/`,
following the Signal K `signalk-plugin-configurator` convention.

Gotcha: because this package has `"type": "module"`, the Signal K server
injects the panel as `<script type="module">` and the Admin UI expects an
**ESM federation container** (`import()` + get/init exports). A classic
`var`-library remote loads silently into module scope and the panel dies
with "Module is not available" — hence `experiments.outputModule: true` and
`library: { type: "module" }` in the webpack config. The CommonJS reference
plugins (signalk-grafana/-questdb) do **not** need this.

The panel's version dropdown is fed by the readonly
`GET /plugins/signalk-whisper/api/versions` route, which is registered
outside the enabled-guard so it works while the plugin is disabled, and
serves the last-cached Docker Hub tag list when offline.

## Releasing

```sh
npm run release    # tags v<package.json version> and pushes the tag
```

`prepublishOnly` runs `build` + `test`, so a broken tree cannot be
published. `imageTag: auto` maps to the pinned upstream release constant —
bump it deliberately and test against the new image before releasing.
