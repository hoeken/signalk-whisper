/**
 * signalk-whisper configuration: JSON schema, defaults, and the pure
 * settings → ContainerConfig mapping consumed by signalk-container-helper.
 */

import type { ContainerConfig } from "signalk-container-helper";

export const PLUGIN_ID = "signalk-whisper";
export const PLUGIN_NAME = "Whisper STT (Wyoming)";
export const SERVICE_TYPE = "asr";
/** Unprefixed container name; runs as `sk-whisper` on the host runtime. */
export const CONTAINER_NAME = "whisper";
export const IMAGE = "rhasspy/wyoming-whisper";
/** Pinned, tested upstream release; `imageTag: "auto"` resolves to this. */
export const PINNED_TAG = "3.5.0";
/**
 * Container-side Wyoming port. The image bakes `--uri tcp://0.0.0.0:10300`
 * into its entrypoint, so the container ALWAYS listens on 10300 internally.
 */
export const WYOMING_PORT = 10300;
export const NOTIFICATION_PATH = "notifications.voice.whisper";
/** First-start model download sizes surfaced in plugin status / README. */
export const DOWNLOAD_HINT = "tiny-int8 ≈ 43 MB, base-int8 ≈ 80 MB";

/**
 * Models accepted by the `--model` flag. NEVER "auto": with the 3.5.0 image
 * `--model auto --language en` silently switches to a ~0.6B-parameter
 * sherpa/Parakeet backend and downloads hundreds of MB — a disaster on a
 * boat server. int8 models are the recommended choice.
 */
export const WHISPER_MODELS = [
  "tiny-int8",
  "base-int8",
  "small-int8",
  "medium-int8",
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium.en",
  "turbo",
] as const;

export type WhisperModel = (typeof WHISPER_MODELS)[number];

/**
 * Default `--initial-prompt`: nautical vocabulary that biases Whisper toward
 * sailing terms. The cheapest accuracy win available — user-editable.
 */
export const NAUTICAL_PROMPT =
  "Genoa, jib, mainsail, spinnaker, windlass, gybe, tack, halyard, winch, " +
  "anchor chain, rode, bilge, galley, helm, autopilot, waypoint, knots, " +
  "port, starboard, bow, stern, leeward, windward, reef, furl, " +
  "log position, anchor alarm, engine, throttle.";

export interface AdvancedSettings {
  bind: "127.0.0.1" | "0.0.0.0";
  memoryLimit: string;
  restartPolicy: "no" | "unless-stopped" | "always";
}

export interface WhisperSettings {
  imageTag: string;
  model: WhisperModel;
  language: string;
  initialPrompt: string;
  port: number;
  advanced: AdvancedSettings;
}

export function defaultSettings(): WhisperSettings {
  return {
    imageTag: "auto",
    model: "tiny-int8",
    language: "en",
    initialPrompt: NAUTICAL_PROMPT,
    port: WYOMING_PORT,
    advanced: {
      bind: "127.0.0.1",
      memoryLimit: "1g",
      restartPolicy: "unless-stopped",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge raw plugin config over the defaults. Signal K does NOT seed schema
 * defaults into saved configurations, and hand-edited config files can hold
 * anything — every field is validated and falls back to its default.
 * Guarantees `model` is never "auto" (see WHISPER_MODELS).
 */
export function applyDefaults(raw: unknown): WhisperSettings {
  const defaults = defaultSettings();
  if (!isRecord(raw)) return defaults;
  const adv = isRecord(raw.advanced) ? raw.advanced : {};

  const model =
    typeof raw.model === "string" &&
    (WHISPER_MODELS as readonly string[]).includes(raw.model)
      ? (raw.model as WhisperModel)
      : defaults.model;
  const language =
    typeof raw.language === "string" && raw.language.trim() !== ""
      ? raw.language.trim()
      : defaults.language;
  // Empty string is meaningful (disables --initial-prompt entirely).
  const initialPrompt =
    typeof raw.initialPrompt === "string"
      ? raw.initialPrompt
      : defaults.initialPrompt;
  const imageTag =
    typeof raw.imageTag === "string" && raw.imageTag.trim() !== ""
      ? raw.imageTag.trim()
      : defaults.imageTag;
  const port =
    typeof raw.port === "number" &&
    Number.isInteger(raw.port) &&
    raw.port > 0 &&
    raw.port <= 65535
      ? raw.port
      : defaults.port;
  const bind = adv.bind === "0.0.0.0" ? "0.0.0.0" : defaults.advanced.bind;
  const memoryLimit =
    typeof adv.memoryLimit === "string" && adv.memoryLimit.trim() !== ""
      ? adv.memoryLimit.trim()
      : defaults.advanced.memoryLimit;
  const restartPolicy =
    adv.restartPolicy === "no" ||
    adv.restartPolicy === "always" ||
    adv.restartPolicy === "unless-stopped"
      ? adv.restartPolicy
      : defaults.advanced.restartPolicy;

  return {
    imageTag,
    model,
    language,
    initialPrompt,
    port,
    advanced: { bind, memoryLimit, restartPolicy },
  };
}

/** Maps the user-facing tag to the tag actually run: "auto" → pinned. */
export function resolveTag(requested: string): string {
  return requested === "auto" ? PINNED_TAG : requested;
}

/** True for plain numeric semver tags like "3.5.0" (update-check filter). */
export function isSemverTag(tag: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(tag);
}

/**
 * Pure, deterministic settings → ContainerConfig mapping. Called on every
 * start/update; the `command` array is always present and stable so
 * signalk-container's drift detection never recreate-loops.
 *
 * Networking: by default the Wyoming port is declared via
 * `signalkAccessiblePorts` (published on host loopback on bare metal; wired
 * to the right network on containerized Signal K). `bind: "0.0.0.0"`
 * switches to an explicit all-interfaces port publish (for sharing the
 * service with e.g. Home Assistant) — the two mechanisms must never be
 * combined on the same port.
 */
export function buildContainerConfig(
  settings: WhisperSettings,
  tag: string,
): ContainerConfig {
  const prompt = settings.initialPrompt.trim();
  const command = [
    "--model",
    settings.model,
    "--language",
    settings.language,
    ...(prompt === "" ? [] : ["--initial-prompt", prompt]),
  ];
  const config: ContainerConfig = {
    image: IMAGE,
    tag,
    command,
    // Model downloads land in /data; mounting the plugin's Signal K data
    // dir there makes them survive container recreation (offline-first).
    signalkDataMount: "/data",
    restart: settings.advanced.restartPolicy,
    resources: {
      memory: settings.advanced.memoryLimit,
      memorySwap: settings.advanced.memoryLimit,
    },
  };
  if (settings.advanced.bind === "0.0.0.0") {
    config.ports = { [String(WYOMING_PORT)]: `0.0.0.0:${settings.port}` };
  } else {
    config.signalkAccessiblePorts = [WYOMING_PORT];
  }
  return config;
}

export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    model: {
      type: "string",
      title: "Whisper model",
      enum: [...WHISPER_MODELS],
      default: "tiny-int8",
      description:
        "Speech-recognition model. The int8 models are recommended: " +
        "tiny-int8 fits a Pi 4, base-int8 is noticeably more accurate on a " +
        "Pi 5 / x86 box. Larger models are slower and use much more RAM — " +
        "use the signalk-wyoming webapp's Test screen latency display to " +
        "guide upgrades. Changing the model downloads it on first use " +
        "(tiny-int8 ≈ 43 MB, base-int8 ≈ 80 MB).",
    },
    language: {
      type: "string",
      title: "Language",
      default: "en",
      description:
        "Spoken language code (e.g. en, de, fr). 'auto' enables per-utterance " +
        "language detection but costs both speed and accuracy on the small " +
        "models — set it explicitly if you can.",
    },
    initialPrompt: {
      type: "string",
      title: "Initial prompt (vocabulary hint)",
      default: NAUTICAL_PROMPT,
      description:
        "Text passed to Whisper as --initial-prompt to bias recognition " +
        "toward your vocabulary. Ships with a nautical word list — add your " +
        "vessel name, local port names, and boat-specific gear. Leave empty " +
        "to disable.",
    },
    imageTag: {
      type: "string",
      title: "Image tag",
      default: "auto",
      description:
        `Docker image tag for ${IMAGE}. 'auto' runs the pinned, tested ` +
        `release (${PINNED_TAG}) and follows this plugin's updates. Set an ` +
        "explicit tag only if you need to pin a different upstream version.",
    },
    port: {
      type: "number",
      title: "Host port",
      default: WYOMING_PORT,
      description:
        "Host TCP port for the Wyoming service — only used with 'Bind " +
        "address' 0.0.0.0, where the service is published on exactly this " +
        "port. With the default loopback networking this setting is " +
        "ignored: signalk-container assigns the host port automatically " +
        "(normally 10300, the next free port if that is taken).",
    },
    advanced: {
      type: "object",
      title: "Advanced",
      properties: {
        bind: {
          type: "string",
          title: "Bind address",
          enum: ["127.0.0.1", "0.0.0.0"],
          default: "127.0.0.1",
          description:
            "127.0.0.1 (default) keeps whisper reachable only from this " +
            "machine — the signalk-wyoming orchestrator is its only " +
            "intended consumer. 0.0.0.0 publishes it on all interfaces so " +
            "other systems (e.g. Home Assistant) can share it. Wyoming has " +
            "no authentication: only expose it on trusted networks (see the " +
            "README security notes).",
        },
        memoryLimit: {
          type: "string",
          title: "Memory limit",
          default: "1g",
          description:
            "Hard container memory cap (docker syntax, e.g. 1g, 1536m). " +
            "Swap is capped to the same value. Keeps a misbehaving model " +
            "from taking down the boat server.",
        },
        restartPolicy: {
          type: "string",
          title: "Restart policy",
          enum: ["no", "unless-stopped", "always"],
          default: "unless-stopped",
          description: "Container runtime restart policy.",
        },
      },
    },
  },
} as const;

export const UI_SCHEMA = {
  initialPrompt: {
    "ui:widget": "textarea",
  },
} as const;
