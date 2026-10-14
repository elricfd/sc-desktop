#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** run castlabs EVS under first python that imports it, EVS_PYTHON forces one.
 *  wrong one shipped dev VMP sig, breaks every DRM track */
function runEvs(args) {
    const candidates = process.env.EVS_PYTHON ? [process.env.EVS_PYTHON] : ['python3', 'python', '/usr/bin/python3'];
    const interpreter = candidates.find(
        (candidate) => spawnSync(candidate, ['-c', 'import castlabs_evs'], { stdio: 'ignore' }).status === 0,
    );
    if (!interpreter) {
        return {
            error: new Error(
                `castlabs-evs is not importable by any of: ${candidates.join(', ')}. ` +
                    'Run `python3 -m pip install castlabs-evs`, or set EVS_PYTHON to the interpreter that has it.',
            ),
        };
    }

    const result = spawnSync(interpreter, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    result.interpreter = interpreter;
    return result;
}

function signPackage(appOutDir) {
    if (process.env.STRICT_VMP_SIGNING === 'true' && (!process.env.EVS_USERNAME || !process.env.EVS_PASSWORD)) {
        console.error('EVS_USERNAME and EVS_PASSWORD are required when STRICT_VMP_SIGNING=true');
        process.exit(1);
    }

    const packageDir = path.resolve(appOutDir);

    if (!fs.existsSync(packageDir)) {
        console.error(`Package directory not found: ${packageDir}`);
        if (process.env.STRICT_VMP_SIGNING === 'true') {
            process.exit(1);
        }
        return;
    }

    console.log(`VMP Signing Application at ${packageDir}`);

    try {
        const subprocess = runEvs(['-m', 'castlabs_evs.vmp', 'sign-pkg', packageDir]);

        if (subprocess.error) {
            throw subprocess.error;
        }

        if (subprocess.status !== 0) {
            const customError = new Error(`Process exited with code ${subprocess.status}`);
            customError.stdout = subprocess.stdout;
            customError.stderr = subprocess.stderr;
            customError.status = subprocess.status;
            throw customError;
        }

        console.log(`EVS signing output (${subprocess.interpreter}):`, subprocess.stdout);
        console.log('VMP signing completed successfully');
    } catch (error) {
        // any failure: missing module, bad/missing creds, expired account, network
        console.warn('\n' + '='.repeat(72));
        console.warn('WARNING: VMP signing did not complete. The build is NOT signed.');
        console.warn('');
        console.warn('DRM-protected audio will NOT play in this build. On SoundCloud');
        console.warn('that means every SoundCloud Go and Go+ track fails silently --');
        console.warn('the player skips or stalls with no visible error. Free tracks are');
        console.warn('unaffected, which is what makes this easy to miss.');
        console.warn('');
        console.warn('Widevine requires a VMP signature on macOS and Windows. To sign:');
        console.warn('  pip install --upgrade castlabs-evs');
        console.warn('  python -m castlabs_evs.account signup      # once, free');
        console.warn('  python3 -m castlabs_evs.account reauth    # if the cached login expired');
        console.warn('  npm run build-mac');
        console.warn('');
        console.warn('Set STRICT_VMP_SIGNING=true to fail the build instead of warning.');
        console.warn('='.repeat(72) + '\n');

        if (error.stdout) console.error('stdout:', error.stdout);
        if (error.stderr) console.error('stderr:', error.stderr);

        if (process.env.STRICT_VMP_SIGNING === 'true') {
            console.error('STRICT_VMP_SIGNING is enabled. Aborting build.');
            process.exit(1);
        }

        console.log('Continuing build without VMP signing...\n');
    }
}

// hooks: mac VMP must precede codesign (sealed bundle, breaks Apple sig), win must follow
// afterPack runs before fuses: move mac VMP after electronFuses if ever configured
module.exports.afterPack = function (context) {
    // linux: Widevine needs no VMP sig
    if (context.electronPlatformName === 'darwin') {
        signPackage(context.appOutDir);
    }
};

module.exports.afterSign = function (context) {
    if (context.electronPlatformName === 'win32') {
        signPackage(context.appOutDir);
    }
};

// manual: node scripts/sign-vmp.js <packaged-app>
if (require.main === module) {
    const appOutDir = process.argv[2];
    if (!appOutDir) {
        console.error('Usage: node scripts/sign-vmp.js <path-to-packaged-app>');
        process.exit(1);
    }
    signPackage(appOutDir);
}
