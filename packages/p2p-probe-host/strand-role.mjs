/**
 * Strand role for the host drone (dev tooling, never shipped).
 *
 * Round-3 UAT test 15: drone.mjs always founded the strand it hosted. Pointed at a strand id a
 * device had already founded, it created a second independent history under the same id, and
 * while peered the device's own committed rows read as missing. Rule: use
 * DRONE_STRAND_ROLE=join whenever STRAND_ID is a network a device created.
 *
 * Control-plane owner genesis is unaffected; only strand founding is made optional.
 */
const ROLES = ['found', 'join'];

export function resolveStrandRole(env, isControlFounder) {
  const raw = env.DRONE_STRAND_ROLE;
  if (raw === undefined || raw === '') {
    return { role: isControlFounder ? 'found' : 'join', explicit: false };
  }
  if (!ROLES.includes(raw)) {
    throw new Error(`Invalid DRONE_STRAND_ROLE=${JSON.stringify(raw)}; allowed values: ${ROLES.join(', ')}`);
  }
  return { role: raw, explicit: true };
}

export function strandFounderOption(resolved) {
  if (!resolved.explicit) return resolved.role === 'found' ? { founder: true } : {};
  return { founder: resolved.role === 'found' };
}
