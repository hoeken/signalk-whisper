/**
 * Custom plugin-config panel for the Signal K Admin UI, built on the shared
 * signalk-container-helper/ui building blocks. Replaces the JSON-schema
 * auto-form (which remains the fallback on servers without panel support):
 * live container status card, image update check/apply, a Docker Hub
 * version dropdown fed by /api/versions, and the model/language/prompt and
 * advanced settings with inline heavy-model and 0.0.0.0-bind warnings.
 *
 * Loaded as a webpack Module Federation remote; `react` resolves to the
 * Admin UI's shared singleton. The defaults, the model list, and the
 * nautical prompt mirror ../config.ts — the panel bundle cannot import the
 * Node-only server code.
 */

import React, { useState } from "react";
import {
  panelStyles as S,
  stateColors,
  SectionTitle,
  StatusCard,
  FieldRow,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";

const BASE = "/plugins/signalk-whisper";
const IMAGE = "rhasspy/wyoming-whisper";
const DEFAULT_PORT = 10300;

/** Mirrors WHISPER_MODELS in ../config.ts — never "auto" (backend switch). */
const MODELS = [
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
];

/** Mirrors NAUTICAL_PROMPT in ../config.ts. */
const NAUTICAL_PROMPT =
  "Genoa, jib, mainsail, spinnaker, windlass, gybe, tack, halyard, winch, " +
  "anchor chain, rode, bilge, galley, helm, autopilot, waypoint, knots, " +
  "port, starboard, bow, stern, leeward, windward, reef, furl, " +
  "log position, anchor alarm, engine, throttle.";

/** Mirrors defaultSettings in ../config.ts. */
const DEFAULTS = {
  model: "tiny-int8",
  language: "en",
  imageTag: "auto",
  bind: "127.0.0.1",
  memoryLimit: "1g",
  restartPolicy: "unless-stopped",
};

/** Per-model guidance from the README's model table. */
function modelHint(model) {
  if (model === "tiny-int8") {
    return { text: "fits a Pi 4; ≈ 43 MB download on first use", warn: false };
  }
  if (model === "base-int8") {
    return {
      text: "recommended on a Pi 5 / x86 box; ≈ 80 MB download on first use",
      warn: false,
    };
  }
  if (model.endsWith("-int8")) {
    return {
      text: "hundreds of MB download, > 1 GB RAM — raise the memory limit",
      warn: true,
    };
  }
  return {
    text: "float model — slower and heavier than int8 at the same size",
    warn: true,
  };
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};
  const adv = cfg.advanced || {};

  const [model, setModel] = useState(
    MODELS.includes(cfg.model) ? cfg.model : DEFAULTS.model,
  );
  const [language, setLanguage] = useState(cfg.language || DEFAULTS.language);
  // Empty string is meaningful (disables --initial-prompt), so no || here.
  const [initialPrompt, setInitialPrompt] = useState(
    typeof cfg.initialPrompt === "string" ? cfg.initialPrompt : NAUTICAL_PROMPT,
  );
  const [imageTag, setImageTag] = useState(cfg.imageTag || DEFAULTS.imageTag);
  const [port, setPort] = useState(String(cfg.port ?? DEFAULT_PORT));
  const [bind, setBind] = useState(
    adv.bind === "0.0.0.0" ? "0.0.0.0" : DEFAULTS.bind,
  );
  const [memoryLimit, setMemoryLimit] = useState(
    adv.memoryLimit || DEFAULTS.memoryLimit,
  );
  const [restartPolicy, setRestartPolicy] = useState(
    adv.restartPolicy || DEFAULTS.restartPolicy,
  );
  const [saved, setSaved] = useState("");

  const { status, loading, refresh } = useStatusPoll(`${BASE}/api/status`, {
    fallback: { status: "not_running" },
  });
  const versions = useVersions(`${BASE}/api/versions`);

  // /api/status answers 503 { error } while the plugin is disabled, so a
  // missing status field means "not running", not a broken poll.
  const st =
    status && typeof status.status === "string" ? status.status : "not_running";
  const state = st === "ready" ? "ok" : st === "starting" ? "warn" : "error";
  const meta = loading
    ? "Checking..."
    : st === "ready"
      ? `${IMAGE}:${status.tag} at ${status.uri}`
      : st === "starting"
        ? "Starting — a first start downloads the model (tiny-int8 ≈ 43 MB, base-int8 ≈ 80 MB)"
        : st === "error"
          ? `Not answering${status && status.uri ? ` at ${status.uri}` : ""}`
          : "Not running";

  const hint = modelHint(model);

  const doSave = () => {
    const portNumber = Number(port);
    save({
      ...cfg,
      model,
      language,
      initialPrompt,
      imageTag,
      port:
        port !== "" && Number.isFinite(portNumber) ? portNumber : DEFAULT_PORT,
      advanced: { bind, memoryLimit, restartPolicy },
    });
    setSaved("Saved. Signal K restarts the plugin with the new configuration.");
  };

  return (
    <div style={S.root}>
      <SectionTitle>Whisper status</SectionTitle>
      <StatusCard
        icon="W"
        iconBackground={st === "ready" ? "#7c3aed" : undefined}
        title="Whisper STT (Wyoming)"
        meta={meta}
        state={state}
        stateTitle={st}
      />

      {/* Check/apply against the routes registerUpdateRoutes mounts; hidden
          while the plugin is disabled (they answer 503 then anyway). */}
      {st !== "not_running" && st !== "stopped" && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={imageTag}
          onApplied={() => void refresh()}
        />
      )}

      <SectionTitle>Settings</SectionTitle>
      <FieldRow
        label="Model"
        hint={hint.text}
        hintColor={hint.warn ? stateColors.warn : undefined}
      >
        <select
          style={S.select}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </FieldRow>
      <FieldRow
        label="Language"
        hint={
          language.trim() === "auto"
            ? "per-utterance detection costs speed and accuracy — set a code if you can"
            : "spoken language code, e.g. en, de, fr"
        }
        hintColor={language.trim() === "auto" ? stateColors.warn : undefined}
      >
        <input
          style={{ ...S.input, width: 90 }}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          placeholder={DEFAULTS.language}
        />
      </FieldRow>
      <FieldRow
        label="Initial prompt"
        hint="vocabulary bias — add your vessel name, local ports, boat gear; empty disables"
      />
      <textarea
        style={{ ...S.textarea, marginBottom: 10 }}
        rows={4}
        value={initialPrompt}
        onChange={(e) => setInitialPrompt(e.target.value)}
        placeholder="Words Whisper should expect to hear"
      />
      <FieldRow label="Image version">
        <VersionSelect
          value={imageTag}
          onChange={setImageTag}
          versions={versions.versions}
          floatingOptions={[
            { tag: "auto", label: "auto (pinned release, recommended)" },
          ]}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={versions.refresh}
        />
      </FieldRow>
      <FieldRow label="Port" hint="only used with bind address 0.0.0.0">
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </FieldRow>

      <CollapsibleSection title="Advanced">
        <FieldRow
          label="Bind address"
          hint={
            bind === "0.0.0.0"
              ? "LAN-reachable — Wyoming has no authentication, firewall accordingly"
              : "only Signal K can reach the service"
          }
          hintColor={bind === "0.0.0.0" ? stateColors.warn : undefined}
        >
          <select
            style={S.select}
            value={bind}
            onChange={(e) => setBind(e.target.value)}
          >
            <option value="127.0.0.1">127.0.0.1 (recommended)</option>
            <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
          </select>
        </FieldRow>
        <FieldRow label="Memory limit" hint='hard cap, e.g. "1g" or "1536m"'>
          <input
            style={{ ...S.input, width: 90 }}
            value={memoryLimit}
            onChange={(e) => setMemoryLimit(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Restart policy">
          <select
            style={S.select}
            value={restartPolicy}
            onChange={(e) => setRestartPolicy(e.target.value)}
          >
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option>
            <option value="no">no</option>
          </select>
        </FieldRow>
      </CollapsibleSection>

      <div style={{ marginTop: 24 }}>
        <Button onClick={doSave}>Save Configuration</Button>
      </div>
      <ActionStatus message={saved} />
    </div>
  );
}
