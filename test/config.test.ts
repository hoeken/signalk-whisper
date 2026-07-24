import { describe, expect, it } from "vitest";
import {
  applyDefaults,
  buildContainerConfig,
  CONFIG_SCHEMA,
  defaultSettings,
  NAUTICAL_PROMPT,
  PINNED_TAG,
  resolveTag,
  WHISPER_MODELS,
  WYOMING_PORT,
} from "../src/config.js";

describe("applyDefaults", () => {
  it("returns full defaults for an empty/absent config", () => {
    const expected = {
      imageTag: "auto",
      model: "tiny-int8",
      language: "en",
      initialPrompt: NAUTICAL_PROMPT,
      port: 10300,
      advanced: {
        bind: "127.0.0.1",
        memoryLimit: "1g",
        restartPolicy: "unless-stopped",
      },
    };
    expect(applyDefaults({})).toEqual(expected);
    expect(applyDefaults(undefined)).toEqual(expected);
    expect(applyDefaults(null)).toEqual(expected);
  });

  it("merges partial config including nested advanced fields", () => {
    const settings = applyDefaults({
      model: "base-int8",
      language: "de",
      advanced: { bind: "0.0.0.0" },
    });
    expect(settings.model).toBe("base-int8");
    expect(settings.language).toBe("de");
    expect(settings.advanced.bind).toBe("0.0.0.0");
    // untouched fields keep their defaults
    expect(settings.initialPrompt).toBe(NAUTICAL_PROMPT);
    expect(settings.advanced.memoryLimit).toBe("1g");
    expect(settings.advanced.restartPolicy).toBe("unless-stopped");
  });

  it("never accepts model 'auto' (sherpa/parakeet download trap)", () => {
    expect(applyDefaults({ model: "auto" }).model).toBe("tiny-int8");
    expect((WHISPER_MODELS as readonly string[]).includes("auto")).toBe(false);
  });

  it("falls back to defaults on malformed values", () => {
    const settings = applyDefaults({
      model: "gigantic-v9",
      language: "",
      port: "10300",
      imageTag: 42,
      advanced: { bind: "10.0.0.1", restartPolicy: "sometimes" },
    });
    expect(settings).toEqual(defaultSettings());
  });

  it("keeps an explicitly empty initialPrompt (disables the flag)", () => {
    expect(applyDefaults({ initialPrompt: "" }).initialPrompt).toBe("");
  });
});

describe("config schema", () => {
  it("declares defaults matching defaultSettings()", () => {
    const defaults = defaultSettings();
    const props = CONFIG_SCHEMA.properties;
    expect(props.model.default).toBe(defaults.model);
    expect(props.language.default).toBe(defaults.language);
    expect(props.initialPrompt.default).toBe(defaults.initialPrompt);
    expect(props.imageTag.default).toBe(defaults.imageTag);
    expect(props.port.default).toBe(defaults.port);
    const adv = props.advanced.properties;
    expect(adv.bind.default).toBe(defaults.advanced.bind);
    expect(adv.memoryLimit.default).toBe(defaults.advanced.memoryLimit);
    expect(adv.restartPolicy.default).toBe(defaults.advanced.restartPolicy);
  });

  it("offers only the vetted model enum (no 'auto')", () => {
    expect(CONFIG_SCHEMA.properties.model.enum).toEqual([...WHISPER_MODELS]);
  });
});

describe("resolveTag", () => {
  it("maps auto to the pinned release and passes explicit tags through", () => {
    expect(resolveTag("auto")).toBe(PINNED_TAG);
    expect(resolveTag("3.4.1")).toBe("3.4.1");
    expect(resolveTag("latest")).toBe("latest");
  });
});

describe("buildContainerConfig", () => {
  it("builds the whisper command with model, language, and prompt", () => {
    const config = buildContainerConfig(defaultSettings(), PINNED_TAG);
    expect(config.image).toBe("rhasspy/wyoming-whisper");
    expect(config.tag).toBe(PINNED_TAG);
    expect(config.command).toEqual([
      "--model",
      "tiny-int8",
      "--language",
      "en",
      "--initial-prompt",
      NAUTICAL_PROMPT,
    ]);
  });

  it("omits --initial-prompt when the prompt is empty", () => {
    const settings = applyDefaults({ initialPrompt: "   " });
    const config = buildContainerConfig(settings, PINNED_TAG);
    expect(config.command).toEqual([
      "--model",
      "tiny-int8",
      "--language",
      "en",
    ]);
  });

  it("uses loopback networking via signalkAccessiblePorts by default", () => {
    const config = buildContainerConfig(defaultSettings(), PINNED_TAG);
    expect(config.signalkAccessiblePorts).toEqual([WYOMING_PORT]);
    expect(config.ports).toBeUndefined();
  });

  it("publishes an explicit all-interfaces port with bind 0.0.0.0", () => {
    const settings = applyDefaults({
      port: 10310,
      advanced: { bind: "0.0.0.0" },
    });
    const config = buildContainerConfig(settings, PINNED_TAG);
    expect(config.ports).toEqual({ "10300": "0.0.0.0:10310" });
    // never combined with signalkAccessiblePorts on the same port
    expect(config.signalkAccessiblePorts).toBeUndefined();
  });

  it("caps memory and swap together and mounts /data", () => {
    const settings = applyDefaults({ advanced: { memoryLimit: "1536m" } });
    const config = buildContainerConfig(settings, PINNED_TAG);
    expect(config.resources).toEqual({
      memory: "1536m",
      memorySwap: "1536m",
    });
    expect(config.signalkDataMount).toBe("/data");
    expect(config.restart).toBe("unless-stopped");
  });

  it("is pure: two calls with the same inputs are deep-equal", () => {
    const settings = applyDefaults({ model: "base-int8" });
    expect(buildContainerConfig(settings, "3.5.0")).toEqual(
      buildContainerConfig(settings, "3.5.0"),
    );
  });
});
