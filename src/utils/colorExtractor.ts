/** theme palette from CSS custom properties */

export interface ThemeColors {
    primary: string;
    secondary: string;
    background: string;
    surface: string;
    text: string;
    accent: string;
}

// runs every page load; stylesheet only changes on theme pick, so keep last result
let lastCss = '';
let lastColors: ThemeColors | null = null;

/** palette from theme CSS custom properties */
export function extractThemeColors(cssContent: string): ThemeColors | null {
    if (!cssContent || cssContent.trim() === '') return null;

    if (cssContent !== lastCss) {
        lastColors = extractThemeColorsUncached(cssContent);
        lastCss = cssContent;
    }
    return lastColors;
}

function extractThemeColorsUncached(cssContent: string): ThemeColors | null {
    const colors: Partial<ThemeColors> = {};

    // parse hex, rgb/rgba, hsl/hsla or named color
    const parseColorValue = (value: string): string | null => {
        if (!value) return null;

        // strip !important
        value = value
            .trim()
            .replace(/!important/gi, '')
            .trim();

        // anchored: prefix-only match would pass trailing junk into stylesheet/script strings
        if (value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)) {
            return value;
        }

        // rgb/rgba: digits, separators, % only
        if (value.match(/^rgba?\(\s*[0-9.,%\s/]+\)$/i)) {
            return value;
        }

        // hsl/hsla: same, plus angle units
        if (value.match(/^hsla?\(\s*[0-9.,%\s/]+(deg|rad|grad|turn)?[0-9.,%\s/]*\)$/i)) {
            return value;
        }

        if (value.match(/^[a-z]+$/i)) {
            return value;
        }

        return null;
    };

    // first --varName declaration wins
    const extractVariable = (varName: string): string | null => {
        const regex = new RegExp(`--${varName}\\s*:\\s*([^;]+);`, 'i');
        const match = cssContent.match(regex);
        if (match && match[1]) {
            return parseColorValue(match[1]);
        }
        return null;
    };

    // first defined variable wins, else fallback

    // accents, buttons, highlights
    colors.primary =
        extractVariable('primary-color') ||
        extractVariable('button-primary-background-color') ||
        extractVariable('accent-color') ||
        extractVariable('highlight-color') ||
        extractVariable('artist-color') ||
        '#ff5500'; // SoundCloud orange fallback

    colors.secondary =
        extractVariable('secondary-color') ||
        extractVariable('button-secondary-background-color') ||
        extractVariable('artist-surface-color') ||
        '#a89984'; // Gruvbox secondary fallback

    colors.background =
        extractVariable('background-surface-color') ||
        extractVariable('surface-color') ||
        extractVariable('background-dark-color') ||
        extractVariable('background-base') ||
        '#1d2021'; // Gruvbox background fallback

    // cards, panels
    colors.surface =
        extractVariable('surface-color') ||
        extractVariable('background-highlight-color') ||
        extractVariable('background-surface') ||
        '#282828'; // Gruvbox surface fallback

    colors.text =
        extractVariable('primary-color') ||
        extractVariable('font-primary-color') ||
        extractVariable('font-light-color') ||
        extractVariable('text-base') ||
        '#ebdbb2'; // Gruvbox text fallback

    // special elements
    colors.accent =
        extractVariable('button-special-background-color') ||
        extractVariable('font-special-color') ||
        extractVariable('special-color') ||
        extractVariable('artist-pro-color') ||
        '#fe8019'; // Gruvbox accent fallback

    return colors as ThemeColors;
}

/** hex to rgba() string */
export function hexToRgba(hex: string, alpha: number = 1): string {
    hex = hex.replace('#', '');

    if (hex.length === 3) {
        hex = hex
            .split('')
            .map((char) => char + char)
            .join('');
    }

    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** rgb components from any color format */
export function extractRgb(color: string): { r: number; g: number; b: number } | null {
    if (color.startsWith('#')) {
        const hex = color.replace('#', '');
        const fullHex =
            hex.length === 3
                ? hex
                      .split('')
                      .map((c) => c + c)
                      .join('')
                : hex;

        return {
            r: parseInt(fullHex.substring(0, 2), 16),
            g: parseInt(fullHex.substring(2, 4), 16),
            b: parseInt(fullHex.substring(4, 6), 16),
        };
    }

    const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) {
        return {
            r: parseInt(rgbMatch[1]),
            g: parseInt(rgbMatch[2]),
            b: parseInt(rgbMatch[3]),
        };
    }

    return null;
}

/** WCAG relative luminance, 0.5 when color is unparseable */
export function getLuminance(color: string): number {
    const rgb = extractRgb(color);
    if (!rgb) return 0.5;

    const rsRGB = rgb.r / 255;
    const gsRGB = rgb.g / 255;
    const bsRGB = rgb.b / 255;

    const r = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
    const g = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
    const b = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** light/dark split at luminance 0.5 */
export function isLightColor(color: string): boolean {
    return getLuminance(color) > 0.5;
}
