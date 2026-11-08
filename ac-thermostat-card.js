/* Wrap the native thermostat card; override color + label for AC sub-modes.
 * Pattern borrowed from heating_pulse_controller_v2/www/thermostat-card.js:
 * never touch the real hass state sent to the native card/entity — only
 * override presentation (CSS vars + a render-time label/stateObj patch).
 */

// CN105 fan speed values, in the order we want them displayed, with the
// plain-number labels the owner asked for (no "Middle" vs "Medium" confusion).
const FAN_MODE_ORDER = ["auto", "quiet", "low", "medium", "middle", "high"];
const FAN_MODE_LABELS = { auto: "Auto", quiet: "1", low: "2", medium: "3", middle: "4", high: "5" };

// CN105 reports vane positions as arrow glyphs; show friendlier labels while
// keeping the real glyph as the service-call value.
const VANE_LABELS = {
  AUTO: "Auto",
  "↑↑": "1 - Up",
  "↑": "2",
  "—": "3",
  "↓": "4",
  "↓↓": "5 - Down",
  SWING: "Swing",
};

// Same icon HA's native climate-swing-modes feature uses (mdi:arrow-up-down),
// grabbed from the live rendered feature rather than guessed.
const VANE_ICON_PATH =
  "M6 14H9L5 18L1 14H4C4 11.3 5.7 6.6 11 6.1V8.1C7.6 8.6 6 11.9 6 14M20 14C20 11.3 18.3 6.6 13 6.1V8.1C16.4 8.7 18 11.9 18 14H15L19 18L23 14H20Z";

const COLORS = {
  orange: "var(--deep-orange-color, #ff6f22)",
  teal: "var(--teal-color, #2dd4bf)",
  green: "var(--green-color, #4caf50)",
  grey: "var(--grey-color, #9e9e9e)",
  ice: "var(--light-blue-color, #4fc3f7)",
};

// Resolve the color + label this card should present, given the real climate
// state plus the two CN105 sub-mode text sensors. Returns null label when the
// native label is already correct and should be left alone.
export function resolveAcPresentation(state, subModeState, autoSubModeState) {
  if (!state || ["unavailable", "unknown"].includes(state.state)) {
    return { color: COLORS.grey, label: null, glow: false };
  }
  const subMode = subModeState?.state;
  const autoSubMode = autoSubModeState?.state;

  // Defrost overrides everything else: the unit is reverse-cycling, not
  // delivering heat, regardless of what mode/hvac_action currently claims.
  if (subMode === "DEFROST") {
    return { color: COLORS.ice, label: "Defrost", glow: true };
  }

  if (state.state === "auto") {
    switch (autoSubMode) {
      case "AUTO_HEAT":
        return { color: COLORS.orange, label: "Heating", glow: true };
      case "AUTO_COOL":
        return { color: COLORS.teal, label: "Cooling", glow: true };
      case "AUTO_LEADER":
        return { color: COLORS.grey, label: "Auto (Leader)", glow: false };
      case "AUTO_ACTIVE":
        return { color: COLORS.grey, label: "Auto (Active)", glow: false };
      default: // AUTO_OFF, AUTO_IDLE, AUTO_INACTIVE
        return { color: COLORS.grey, label: "Idle", glow: false };
    }
  }

  // Transitional heat sub-phases: real heat isn't flowing yet, so no glow,
  // but tell the truth about which phase it's in rather than saying "Heating".
  if (subMode === "WARMUP") return { color: COLORS.grey, label: "Warmup", glow: false };
  if (subMode === "PREHEAT") return { color: COLORS.grey, label: "Preheat", glow: false };
  if (subMode === "STANDBY") return { color: COLORS.grey, label: "Standby", glow: false };

  const action = state.attributes.hvac_action;
  if (action === "heating") return { color: COLORS.orange, label: null, glow: true };
  if (action === "cooling") return { color: COLORS.teal, label: null, glow: true };
  if (action === "drying") return { color: COLORS.teal, label: null, glow: true };
  if (action === "fan") return { color: COLORS.green, label: null, glow: true };
  return { color: COLORS.grey, label: null, glow: false }; // idle / off
}

await customElements.whenDefined("home-assistant");

export class AcThermostatCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._generation = 0;
  }

  setConfig(config) {
    if (!config.entity || !config.entity.startsWith("climate.")) {
      throw new Error("A climate entity is required");
    }
    this._config = { ...config };
    const generation = ++this._generation;
    this._ready = this._create(generation);
  }

  async _create(generation) {
    try {
      const helpers = await window.loadCardHelpers();
      const card = helpers.createCardElement({
        type: "thermostat",
        entity: this._config.entity,
        features: this._config.features ?? [
          { type: "climate-fan-modes", style: "dropdown" },
          { type: "climate-hvac-modes" },
        ],
      });
      if (generation !== this._generation) return;
      this._card = card;
      this.shadowRoot.replaceChildren(card);
      if (this._hass) this.hass = this._hass;
    } catch (error) {
      if (generation !== this._generation) return;
      this.shadowRoot.textContent = "Unable to load thermostat: " + error.message;
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._card) return;
    this._card.hass = hass;

    const state = hass.states[this._config.entity];
    const subModeState = this._config.sub_mode_entity ? hass.states[this._config.sub_mode_entity] : null;
    const autoSubModeState = this._config.auto_sub_mode_entity ? hass.states[this._config.auto_sub_mode_entity] : null;
    const presentation = resolveAcPresentation(state, subModeState, autoSubModeState);
    this._presentation = presentation;

    // Recolor whichever mode button is actually active; leave the others at
    // native defaults so off/fan/dry/cool keep their normal HA coloring
    // except where we deliberately want teal for cool+dry and green for fan.
    const modeColorOverrides = {
      cool: COLORS.teal,
      dry: COLORS.teal,
      fan_only: COLORS.green,
    };
    for (const [mode, color] of Object.entries(modeColorOverrides)) {
      this._card.style.setProperty(`--state-climate-${mode}-color`, color);
    }
    // heat/auto follow the resolved presentation color (dynamic for auto,
    // always orange-when-heating for heat — matches native default anyway).
    this._card.style.setProperty("--state-climate-heat-color", presentation.color);
    this._card.style.setProperty("--state-climate-auto-color", presentation.color);

    const generation = (this._presentationGeneration = (this._presentationGeneration || 0) + 1);
    this._presentationReady = this._patchLabelAndGlow(presentation, generation);
    this._fanOrderReady = this._patchFanModeOrder(generation);
    if (this._config.vertical_vane_entity) this._vaneRowReady = this._mountVaneRow(generation);
  }

  // Native climate swing_mode on this platform only has 2 real states
  // (off/vertical) — the actual 7-position vane control lives on a separate
  // select entity. Mount a real ha-control-select-menu (the same component
  // HA's own climate-fan-modes feature uses) as a light-DOM child of ha-card,
  // so it renders inside the same card body via ha-card's catch-all <slot>,
  // instead of a second bordered card. Built once, then kept in sync.
  async _mountVaneRow(generation) {
    const card = this._card;
    await card.updateComplete;
    if (card !== this._card || generation !== this._presentationGeneration) return;
    const haCard = card.shadowRoot?.querySelector("ha-card");
    if (!haCard) return;

    const entity = this._config.vertical_vane_entity;
    const vaneState = this._hass.states[entity];
    if (!vaneState) return;

    if (!this._vaneMenu) {
      this._vaneMenu = document.createElement("ha-control-select-menu");
      this._vaneMenu.setAttribute("show-arrow", "");
      this._vaneMenu.setAttribute("hide-label", "");
      const icon = document.createElement("ha-svg-icon");
      icon.setAttribute("slot", "icon");
      icon.path = VANE_ICON_PATH;
      this._vaneMenu.appendChild(icon);
      this._vaneMenu.addEventListener("value-changed", (ev) => {
        this._hass.callService("select", "select_option", { entity_id: entity, option: ev.detail.value });
      });
      this._vaneMenu.style.width = "100%";
      const wrapper = document.createElement("div");
      // ha-card is flex column/align-items:center, so a plain light-DOM child
      // shrinks to content width like ours did — stretch it like the native
      // hui-card-features wrapper implicitly gets from its own host CSS.
      wrapper.style.cssText = "padding: 0 12px 12px; align-self: stretch; box-sizing: border-box;";
      wrapper.appendChild(this._vaneMenu);
      haCard.appendChild(wrapper);
    }

    this._vaneMenu.hass = this._hass;
    this._vaneMenu.options = vaneState.attributes.options.map((o) => ({ label: VANE_LABELS[o] ?? o, value: o }));
    this._vaneMenu.value = vaneState.state;
    this._vaneMenu.disabled = ["unavailable", "unknown"].includes(vaneState.state);
  }

  // The native fan-modes feature always redraws its options list from
  // stateObj.attributes.fan_modes, in ESPHome's internal enum order, on every
  // hass update — so re-apply our order/labels after each render rather than
  // once. `value` stays the real ESPHome fan_mode string (what the click
  // handler sends to climate.set_fan_mode); only display order/label change.
  async _patchFanModeOrder(generation) {
    const card = this._card;
    await card.updateComplete;
    if (card !== this._card || generation !== this._presentationGeneration) return;
    // Real DOM path: hui-thermostat-card -> #shadow ha-card -> (light DOM)
    // hui-card-features -> #shadow hui-card-feature (one per feature) ->
    // #shadow hui-climate-fan-modes-card-feature -> #shadow ha-control-select-menu.
    const featuresWrapper = card.shadowRoot?.querySelector("ha-card")?.querySelector("hui-card-features");
    if (!featuresWrapper) return;
    await featuresWrapper.updateComplete;
    if (card !== this._card || generation !== this._presentationGeneration) return;
    let feature = null;
    for (const wrapper of featuresWrapper.shadowRoot?.querySelectorAll("hui-card-feature") ?? []) {
      const candidate = wrapper.shadowRoot?.querySelector("hui-climate-fan-modes-card-feature");
      if (candidate) {
        feature = candidate;
        break;
      }
    }
    if (!feature) return;
    await feature.updateComplete;
    if (card !== this._card || generation !== this._presentationGeneration) return;
    const menu = feature.shadowRoot?.querySelector("ha-control-select-menu");
    if (!menu || !Array.isArray(menu.options)) return;
    const reordered = FAN_MODE_ORDER.filter((v) => menu.options.some((o) => o.value === v)).map((v) => ({
      label: FAN_MODE_LABELS[v],
      value: v,
    }));
    const unchanged =
      reordered.length === menu.options.length &&
      reordered.every((o, i) => o.value === menu.options[i].value && o.label === menu.options[i].label);
    if (!unchanged) menu.options = reordered;
  }

  async _patchLabelAndGlow(presentation, generation) {
    const card = this._card;
    await card.updateComplete;
    if (card !== this._card || generation !== this._presentationGeneration) return;
    const control = card.shadowRoot?.querySelector("ha-state-control-climate-temperature");
    if (!control) return;
    await control.updateComplete;
    if (card !== this._card || generation !== this._presentationGeneration) return;

    // Surgical override of the native render, scoped to this control
    // instance only. Mirrors heating-pulse-controller-v2's pattern: fake the
    // rendered stateObj for the duration of one render() call so the arc
    // doesn't glow full-intensity during transitional sub-modes, without
    // touching the real stateObj the rest of the card/services see.
    if (!control._acOriginalRender && typeof control.render === "function") {
      control._acOriginalRender = control.render;
      control.render = function () {
        if (!this._acOverride) return this._acOriginalRender();
        const state = this.stateObj;
        const descriptor = Object.getOwnPropertyDescriptor(this, "stateObj");
        Object.defineProperty(this, "stateObj", {
          configurable: true,
          value: {
            ...state,
            attributes: {
              ...state.attributes,
              hvac_action: this._acOverride.glow ? state.attributes.hvac_action : "idle",
            },
          },
        });
        try {
          return this._acOriginalRender();
        } finally {
          if (descriptor) Object.defineProperty(this, "stateObj", descriptor);
          else delete this.stateObj;
        }
      };
    }
    if (!control._acOriginalRenderLabel && typeof control._renderLabel === "function") {
      control._acOriginalRenderLabel = control._renderLabel;
      control._renderLabel = function () {
        if (!this._acOverride?.label) return this._acOriginalRenderLabel();
        const label = document.createElement("p");
        label.className = "label";
        label.textContent = this._acOverride.label;
        return label;
      };
    }

    // Only engage the override machinery when there's something to override;
    // otherwise defer entirely to native rendering (plain heating/cooling/idle).
    const needsOverride = presentation.label !== null || !presentation.glow;
    control._acOverride = needsOverride ? presentation : null;
    control.requestUpdate();
  }

  getCardSize() {
    return this._card?.getCardSize?.() ?? 5;
  }
  getGridOptions() {
    return this._card?.getGridOptions?.() ?? { columns: 6, rows: 4 };
  }
  static getStubConfig(hass) {
    const entity = Object.values(hass.states).find(
      (s) => s.entity_id.startsWith("climate.") && "hvac_action" in s.attributes
    )?.entity_id;
    return { entity };
  }
}

if (!customElements.get("ac-thermostat-card")) {
  customElements.define("ac-thermostat-card", AcThermostatCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "ac-thermostat-card",
    name: "AC Thermostat (CN105 sub-mode aware)",
    description: "Native thermostat card, recolored/relabeled for defrost, warmup, preheat, standby and auto sub-modes",
  });
}
