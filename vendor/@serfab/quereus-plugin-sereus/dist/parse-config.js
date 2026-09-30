const TEXT = {
    expected: 'a string',
    read: raw => (typeof raw === 'string' ? raw : undefined),
    emptyIsAbsent: true,
};
const COMMA_LIST = {
    ...TEXT,
    expected: 'a comma-separated string',
    read: raw => (typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined),
};
// NOTE: no numeric strings here or in FLAG, so a `${VAR}` in quoomb.config.json
// (whose env interpolation always yields a string) cannot supply port or
// enable_cache; if that is ever needed, accept decimal-integer strings here.
const PORT = {
    expected: 'an integer from 0 to 65535',
    read: raw => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : undefined),
};
/** 0 and 1 are accepted because SQL has no boolean type. */
const FLAG = {
    expected: 'true, false, 1 or 0',
    read: raw => {
        if (raw === true || raw === 1)
            return true;
        if (raw === false || raw === 0)
            return false;
        return undefined;
    },
};
/**
 * One of a closed set of strings. The set is written as an object with every
 * member as a key so it is checked against the union: `oneOf<StrandTransactor>`
 * stops compiling when the union gains or loses a member.
 */
function oneOf(members) {
    const values = Object.keys(members);
    return {
        expected: `one of ${values.join(', ')}`,
        read: raw => values.find(v => v === raw),
        emptyIsAbsent: true,
    };
}
const SETTINGS = {
    strand_id: { ...TEXT, required: true },
    bootstrap_nodes: COMMA_LIST,
    schema: TEXT,
    sapp_id: TEXT,
    sapp_version: TEXT,
    port: PORT,
    enable_cache: FLAG,
    fret_profile: oneOf({ edge: true, core: true }),
    transactor: oneOf({ local: true, network: true, test: true }),
    storage_path: TEXT,
};
/** Every key the plugin accepts; the package manifest's `quereus.settings` must list the same. */
export const PLUGIN_SETTING_KEYS = Object.keys(SETTINGS);
const PROBLEM_HEADER = 'quereus-plugin-sereus: invalid plugin settings';
/** A string echoed in a problem is cut here: enough to recognise a typo, not a pasted schema. */
const MAX_ECHOED_CHARS = 120;
/**
 * Parse the plugin-loader SqlValue config into typed StrandConnectionOptions.
 * Shared by the Node (`plugin.ts`) and browser (`plugin-browser.ts`) entries.
 *
 * Strict: an unknown key or a value of the wrong type throws one error listing
 * every problem, rather than falling back to a default the user never chose.
 */
export function parseConfig(config) {
    const problems = [];
    const values = readSettings(config, problems);
    problems.push(...unknownKeyProblems(config));
    // `strand_id` is undefined only alongside its own "required" problem.
    const strandId = values.strand_id;
    if (problems.length > 0 || strandId === undefined) {
        throw new Error([PROBLEM_HEADER, ...problems.map(p => `  - ${p}`)].join('\n'));
    }
    return toParsedConfig(strandId, values);
}
function readSettings(config, problems) {
    const values = {};
    for (const key of PLUGIN_SETTING_KEYS)
        readSettingInto(values, key, config[key], problems);
    return values;
}
function readSettingInto(values, key, raw, problems) {
    const setting = SETTINGS[key];
    if (raw === undefined || raw === null || (raw === '' && setting.emptyIsAbsent)) {
        if (setting.required)
            problems.push(`${key} is required`);
        return;
    }
    const value = setting.read(raw);
    if (value === undefined) {
        problems.push(`${key} must be ${setting.expected} (got ${describeValue(raw)})`);
        return;
    }
    values[key] = value;
}
function unknownKeyProblems(config) {
    return Object.keys(config)
        .filter(key => !Object.hasOwn(SETTINGS, key))
        .map(key => key === 'mode'
        ? 'mode was removed: a lone node now coordinates for itself, and transactor selects the storage engine'
        : `unknown setting ${JSON.stringify(key)}; accepted settings are ${PLUGIN_SETTING_KEYS.join(', ')}`);
}
function describeValue(raw) {
    if (typeof raw === 'string') {
        return raw.length > MAX_ECHOED_CHARS
            ? `${JSON.stringify(raw.slice(0, MAX_ECHOED_CHARS))}… (${raw.length} characters)`
            : JSON.stringify(raw);
    }
    if (typeof raw === 'bigint')
        return `${raw}n`;
    if (typeof raw === 'number' || typeof raw === 'boolean')
        return String(raw);
    if (raw instanceof Uint8Array)
        return `a blob of ${raw.length} bytes`;
    return 'a JSON value';
}
function toParsedConfig(strandId, values) {
    const { transactor } = values;
    return {
        options: {
            strandId,
            bootstrapNodes: values.bootstrap_nodes ?? [],
            schema: values.schema,
            sAppId: values.sapp_id ?? 'unknown',
            sAppVersion: values.sapp_version ?? '1.0.0',
            port: values.port ?? 0,
            enableCache: values.enable_cache ?? true,
            fretProfile: values.fret_profile ?? 'edge',
            // Left out entirely when unset so `composeStrand` applies its own default.
            ...(transactor && { transactor }),
        },
        storagePath: values.storage_path,
    };
}
//# sourceMappingURL=parse-config.js.map