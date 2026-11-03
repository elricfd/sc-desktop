import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }));

import { startLogFile } from './utils/diagnostics';

const saved = { ...console };
let dir = '';

afterEach(() => {
    Object.assign(console, saved);
    rmSync(dir, { recursive: true, force: true });
});

describe('startLogFile', () => {
    it('appends console output to main.log, and rotates a big one at start', () => {
        dir = mkdtempSync(join(tmpdir(), 'sc-log-'));
        writeFileSync(join(dir, 'main.log'), 'x'.repeat(6 * 1024 * 1024));
        console.error = vi.fn();

        const file = startLogFile(dir);
        console.error('boom %d', 42, { a: 1 });

        expect(existsSync(join(dir, 'main.old.log'))).toBe(true);
        const log = readFileSync(file, 'utf8');
        expect(log).toContain('--- SoundCloud 9.9.9');
        expect(log).toMatch(/Z ERROR boom 42 \{ a: 1 \}\n$/);
    });
});
