import {
	ButtonItem,
	PanelSection,
	PanelSectionRow,
	SliderField,
  TextField,
	ToggleField,
	staticClasses,
} from "@decky/ui";
import { callable, definePlugin, executeInTab } from "@decky/api";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FaCropAlt } from "react-icons/fa";
import { DEFAULTS, sanitize, steamScript } from "./bezel";
import type { Settings } from "./bezel";

const getSettings = callable<[], Settings>("get_settings");
const setSettings = callable<[settings: Settings], Settings>("set_settings");

type Snapshot = {
	settings: Settings;
	loading: boolean;
	steamStatus: string;
	mangohudStatus: string;
};
type Subscriber = (state: Snapshot) => void;

class Controller {
	private settings: Settings = { ...DEFAULTS };
	private loading = true;
	private steamStatus = "Loading settings";
	private mangohudStatus = "MangoHud updates are applied when settings are saved";
	private subscribers = new Set<Subscriber>();
	private applyTimer: ReturnType<typeof setTimeout> | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private applyChain: Promise<void> = Promise.resolve();
	private saveChain: Promise<unknown> = Promise.resolve();
	private revision = 0;
	private disposed = false;

	snapshot(): Snapshot {
		return {
			settings: { ...this.settings },
			loading: this.loading,
			steamStatus: this.steamStatus,
			mangohudStatus: this.mangohudStatus,
		};
	}
	private notify(): void {
		const snapshot = this.snapshot();
		for (const subscriber of this.subscribers) subscriber(snapshot);
	}
	subscribe(subscriber: Subscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber(this.snapshot());
		return () => { this.subscribers.delete(subscriber); };
	}
  async start(): Promise<void> {
    try {
      const loaded = await Promise.race([
        getSettings(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Backend settings request timed out after 5 seconds")), 5000);
        })
      ]);

      if (this.disposed) return;
      this.settings = sanitize(loaded);
      this.steamStatus = "Settings loaded";
    } catch (error) {
      if (this.disposed) return;
      this.steamStatus = `Settings error: ${String(error)}`;
    }

    if (this.disposed) return;

    this.loading = false;
    this.notify();
    this.applyNow();
  }
  update(change: Partial<Settings>): void {
    if (this.loading || this.disposed) return;
    const enabledChanged = change.enabled !== undefined
      && change.enabled !== this.settings.enabled;
    this.settings = sanitize({ ...this.settings, ...change });
    this.revision++;
    this.notify();
    if (this.applyTimer !== null) clearTimeout(this.applyTimer);
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.applyTimer = setTimeout(() => this.applyNow(), 40);
    if (enabledChanged) {
      this.saveNow();
    } else {
      this.saveTimer = setTimeout(() => this.saveNow(), 300);
    }
  }
	reset(): void {
		this.update({ ...DEFAULTS });
		this.applyNow();
		this.saveNow();
	}
	private saveNow(): void {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (this.loading) return;
		const copy = { ...this.settings };
		this.saveChain = this.saveChain.catch(() => undefined).then(async () => {
			await setSettings(copy);
			if (!this.disposed) {
        this.mangohudStatus = copy.enabled && copy.mangohud
          ? `Saved: base offset + X${copy.horizontal}, Y${copy.vertical} in presets 1–4`
          : "Saved: MangoHud overrides removed";
				this.notify();
			}
		}).catch((error: unknown) => {
			if (!this.disposed) {
				this.mangohudStatus = `Save / MangoHud error: ${String(error)}`;
				this.notify();
			}
		});
	}
	applyNow(): void {
		if (this.applyTimer !== null) clearTimeout(this.applyTimer);
		this.applyTimer = null;
		this.enqueueApply(this.settings, false);
	}
	private enqueueApply(settings: Settings, cleanup: boolean): void {
		const copy = { ...settings };
		const revision = this.revision;
		this.applyChain = this.applyChain.catch(() => undefined).then(async () => {
			if (!cleanup && (this.disposed || revision !== this.revision)) return;
			const response = await executeInTab("Steam Big Picture Mode", false, steamScript(copy));
			if (this.disposed || cleanup) return;
			this.steamStatus = response.success
				? String(response.result ?? "Applied to Steam UI")
				: `Steam SP window unavailable: ${String(response.result)}`;
			this.notify();
		}).catch((error: unknown) => {
			if (!this.disposed) {
				this.steamStatus = `Steam UI error: ${String(error)}`;
				this.notify();
			}
		});
	}
	stop(): void {
		if (this.disposed) return;
		if (this.applyTimer !== null) clearTimeout(this.applyTimer);
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		// Keep MangoHud offsets persistent, but clean up the injected Steam CSS.
		if (!this.loading) this.saveNow();
		this.disposed = true;
		this.subscribers.clear();
		this.enqueueApply({ ...DEFAULTS, enabled: false }, true);
	}
}

function ScaleInput({ value, disabled, onChange }: {
	value: number;
	disabled: boolean;
	onChange: (value: number) => void;
}): ReactNode {
	const [draft, setDraft] = useState(value.toFixed(3));

	useEffect(() => {
		setDraft(value.toFixed(3));
	}, [value]);

	const commit = (): void => {
		const number = Number(draft);

		if (draft.trim() !== "" && Number.isFinite(number) && number >= 0.1 && number <= 1.1) {
			onChange(Math.round(number * 1000) / 1000);
		} else {
			setDraft(value.toFixed(3));
		}
	};

	return (
		<PanelSectionRow>
			<TextField
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					}
				}}
			/>
		</PanelSectionRow>
	);
}

function Content({ controller }: { controller: Controller }): ReactNode {
	const [state, setState] = useState<Snapshot>(() => controller.snapshot());
	useEffect(() => controller.subscribe(setState), [controller]);
	return (
		<div>
      <PanelSection title="Steam UI Margin Adjustment">
        <PanelSectionRow>
          <ToggleField
            label="Enable adjustments"
            checked={state.settings.enabled}
            disabled={state.loading}
            onChange={(enabled: boolean) => controller.update({ enabled })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="White Background"
            description="Shows a white background to make it easier to line up the display"
            checked={state.settings.whiteBackground}
            disabled={state.loading || !state.settings.enabled}
            onChange={(whiteBackground: boolean) => controller.update({ whiteBackground })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Horizontal"
            description="Horizontal offset in CSS pixels"
            value={state.settings.horizontal}
            min={-160}
            max={160}
            step={1}
            showValue
            editableValue
            valueSuffix=" px"
            disabled={state.loading || !state.settings.enabled}
            onChange={(horizontal: number) => controller.update({ horizontal })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Vertical"
            description="Vertical offset in CSS pixels"
            value={state.settings.vertical}
            min={-160}
            max={160}
            step={1}
            showValue
            editableValue
            valueSuffix=" px"
            disabled={state.loading || !state.settings.enabled}
            onChange={(vertical: number) => controller.update({ vertical })}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <SliderField
            label="Scale"
            value={Math.max(0.9, state.settings.scale)}
            min={0.9}
            max={1.1}
            step={0.001}
            showValue
            disabled={state.loading || !state.settings.enabled}
            onChange={(scale: number) => controller.update({ scale })}
          />
        </PanelSectionRow>
        <ScaleInput
          value={state.settings.scale}
          disabled={state.loading || !state.settings.enabled}
          onChange={(scale) => controller.update({ scale })}
        />
      </PanelSection>
			<PanelSection title="MangoHud">
				<PanelSectionRow>
					<ToggleField
						label="Also offset MangoHud"
						description="Add the same offsets to MangoHud (Requires Restart)"
						checked={state.settings.mangohud}
						disabled={state.loading || !state.settings.enabled}
						onChange={(mangohud: boolean) => controller.update({ mangohud })}
					/>
				</PanelSectionRow>
			</PanelSection>
			<PanelSection title="Actions">
				<PanelSectionRow>
					<ButtonItem layout="below" disabled={state.loading} onClick={() => controller.reset()}>
						Reset all margins to 0
					</ButtonItem>
				</PanelSectionRow>
				<PanelSectionRow>
					<div style={{ opacity: 0.8, fontSize: "12px", lineHeight: 1.4, overflowWrap: "anywhere" }}>
						<p>Steam UI: Scale {state.settings.scale.toFixed(3)} | Horizontal {state.settings.horizontal}px | Vertical {state.settings.vertical}px | White Background: {state.settings.whiteBackground ? "On" : "Off"}</p>
						<p>MangoHud: {state.mangohudStatus}</p>
						<p>MangoHud needs an overlay level change or game restart to view changes. Gamescope's viewport is not resized.</p>
					</div>
				</PanelSectionRow>
			</PanelSection>
		</div>
	);
}

export default definePlugin(() => {
	const controller = new Controller();
	void controller.start();
	return {
		name: "Overscan Fixes",
		titleView: <div className={staticClasses.Title}>Overscan Fixes</div>,
		content: <Content controller={controller} />,
		icon: <FaCropAlt />,
		onDismount() {
			controller.stop();
		},
	};
});
