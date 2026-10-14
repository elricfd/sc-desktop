/** escape for HTML text or quoted attribute: settings and confirm markup is built by concatenation,
 * so every stored or caller-supplied value goes through here */
export function escapeHtml(value: unknown): string {
    if (value === undefined || value === null) return '';

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
