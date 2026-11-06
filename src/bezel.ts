
export interface Settings {
	enabled: boolean;
    whiteBackground: boolean;
	mangohud: boolean;
	scale: number;
	horizontal: number;
	vertical: number;
}

export const DEFAULTS: Readonly<Settings> = Object.freeze({
	enabled: true,
    whiteBackground: false,
	mangohud: true,
	scale: 1,
	horizontal: 0,
	vertical: 0,
});
export const MAX_OFFSET = 160;

export function sanitize(input: unknown): Settings {
	const value = input !== null && typeof input === "object"
		? input as Partial<Settings> & { left?: number; top?: number }
		: {};

	const offset = (raw: unknown): number => {
		const number = Number(raw);
		return Number.isFinite(number)
			? Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(number)))
			: 0;
	};

	const rawScale = Number(value.scale ?? 1);
	const scale = Number.isFinite(rawScale)
		? Math.round(Math.max(0.1, Math.min(1.9, rawScale)) * 1000) / 1000
		: 1;

	return {
		enabled: value.enabled !== false,
        whiteBackground: value.whiteBackground === true,
		mangohud: value.mangohud !== false,
		scale,
		horizontal: offset(value.horizontal ?? value.left ?? 0),
		vertical: offset(value.vertical ?? value.top ?? 0),
	};
}

// Executed inside Steam's SP browser tab.
function patchSteamUi(value: Settings): string {
	const body = document.querySelector("html > body") as HTMLBodyElement | null;

	if (!body) {
		return `No top-level body found in ${document.title}`;
	}

	const marker = "data-overscan-fix-original";
	const properties = ["scale", "margin-left", "margin-top", "transform-origin"];
    const html = document.documentElement;
    const backgroundMarker = "data-overscan-fix-background";

    function updateBackground(white: boolean): void {
        const original = html.getAttribute(backgroundMarker);

        if (white) {
            if (original === null) {
                html.setAttribute(backgroundMarker, JSON.stringify({
                    value: html.style.getPropertyValue("background-color"),
                    priority: html.style.getPropertyPriority("background-color")
                }));
            }

            html.style.setProperty("background-color", "white", "important");
            return;
        }

        if (original === null) return;

        try {
            const saved = JSON.parse(original) as {
                value: string;
                priority: string;
            };

            if (saved.value) {
                html.style.setProperty("background-color", saved.value, saved.priority);
            } else {
                html.style.removeProperty("background-color");
            }
        } catch {
            html.style.removeProperty("background-color");
        }

        html.removeAttribute(backgroundMarker);
    }

    updateBackground(value.enabled && value.whiteBackground);

	if (!value.enabled) {
		const original = body.getAttribute(marker);

		if (original !== null) {
			try {
				const saved = JSON.parse(original) as Array<{
					property: string;
					value: string;
					priority: string;
				}>;

				for (const entry of saved) {
					if (!properties.includes(entry.property)) continue;

					if (entry.value) {
						body.style.setProperty(entry.property, entry.value, entry.priority);
					} else {
						body.style.removeProperty(entry.property);
					}
				}
			} catch {
				for (const property of properties) {
					body.style.removeProperty(property);
				}
			}

			body.removeAttribute(marker);
		}

		return `Restored body styles in ${document.title}`;
	}

	// Capture existing inline values only on the first application.
	if (!body.hasAttribute(marker)) {
		const original = properties.map((property) => ({
			property,
			value: body.style.getPropertyValue(property),
			priority: body.style.getPropertyPriority(property)
		}));

		body.setAttribute(marker, JSON.stringify(original));
	}

	const scale = Number.isFinite(value.scale)
		? Math.max(0.1, Math.min(1.1, Math.round(value.scale * 1000) / 1000))
		: 1;

	const offset = (number: number): number =>
		Number.isFinite(number)
			? Math.max(-160, Math.min(160, Math.round(number)))
			: 0;

	const horizontal = offset(value.horizontal);
	const vertical = offset(value.vertical);

	// Modify the body's inline styles directly.
	body.style.setProperty("scale", scale.toFixed(3), "important");
	body.style.setProperty("margin-left", `${horizontal}px`, "important");
	body.style.setProperty("margin-top", `${vertical}px`, "important");
	body.style.setProperty("transform-origin", "top left", "important");

	const computed = getComputedStyle(body);

	return [
		`Tab: ${document.title}`,
		`URL: ${location.href}`,
		`Scale: ${computed.getPropertyValue("scale").trim()}`,
		`Horizontal: ${computed.marginLeft}`,
		`Vertical: ${computed.marginTop}`
	].join(" | ");
}

export function steamScript(settings: Settings): string {
	return `(${patchSteamUi.toString()})(${JSON.stringify(settings)});`;
}
