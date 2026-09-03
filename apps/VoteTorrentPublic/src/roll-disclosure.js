/**
 * roll-disclosure.js — which registrant columns an anonymous reader may see,
 * decided in exactly one named place and validated before it is trusted
 * (D-19, D-22, D-23).
 *
 * Four things a later reader cannot infer from the code alone:
 *
 * 1. PUBLISHING THIS ROLL ANONYMOUSLY IS A DELIBERATE DECISION, NOT AN
 *    OVERSIGHT. The spikes flagged it as "a policy decision nobody has made",
 *    and it has now been made: the table the roll reads is the one the schema
 *    itself names public, the authority signs every row in it, and published
 *    voter rolls are ordinary practice in many jurisdictions. `SECURITY.md`
 *    carries the reasoning in full; this module is where the decision becomes
 *    a rendered column set. Read that document before widening anything here.
 *
 * 2. WHY THE POLICY IS DECLARED HERE RATHER THAN READ. The schema's
 *    per-field disclosure policy is documented at
 *    `packages/vote-core/schema/votetorrent.qsql:2298-2300` as naming "a
 *    top-level attribute name within RegistrantSelective.SelectiveDetails" —
 *    so the two-audience policy governs the SELECTIVE record only, and the
 *    public record has no per-field audience lever in the schema at all.
 *    There is therefore no policy row to read for this roll, and reading the
 *    selective record is forbidden outright (D-22). Left implicit, the page's
 *    disclosure policy would be three column names in a JSX table by
 *    accident; declared here, it is one reviewable statement that a validator
 *    runs over before any column renders.
 *
 * 3. THE TABLE THAT WOULD MAKE THIS DATA-DRIVEN, and why it is not read here.
 *    `ElectionRegistrationField` (`votetorrent.qsql:2249`) maps a field name
 *    to a public / selective / private tier per election. Reading it needs a
 *    new read module in the data package and a classification entry for it —
 *    both outside this plan's fence — so it belongs to a later phase. Naming
 *    it here so that phase does not have to rediscover it.
 *
 * 4. THIS MODULE NEVER READS, NEVER QUERIES AND IMPORTS NOTHING. Content
 *    selection is all it does. It also never throws: a page whose whole
 *    subject is honest gaps must not white-screen because a policy was
 *    malformed, and there is no operator to surface a thrown error to. Every
 *    malformed input resolves to a verdict, and the verdict is always
 *    fail-closed.
 *
 * The house style here is `election-address.js`'s: a dependency-free function
 * that returns a frozen verdict and reports what it could not establish,
 * rather than guessing.
 */

/**
 * The entire published field set (D-19), in schema order.
 *
 * Three names are DELIBERATELY ABSENT and each absence is load-bearing:
 *
 *   - the authority-specific public field collection
 *     (`votetorrent.qsql:1818`) — the schema describes it as a json object
 *     for authority-specific public fields, which is to say unconstrained,
 *     unreviewed, authority-supplied JSON with no schema to reason about. A
 *     page cannot state what it is publishing if it does not know what the
 *     value contains.
 *   - the public record's own content id, and the registrant key it carries.
 *     Each is a correlation handle from a roll row back into the registrant
 *     tables, so publishing either would let a reader join this roll to
 *     anything else that names the same registrant.
 *
 * The read module's select list already omits all three, and its import-time
 * assertion makes adding one a load-time crash. This constant is the
 * RENDER-SIDE half of the same rule: a widened query still cannot widen the
 * page, because a column outside this array is never indexed.
 *
 * @type {ReadonlyArray<string>}
 */
export const ROLL_FIELDS = Object.freeze(['LastName', 'FirstName', 'District']);

/**
 * The audience vocabulary, transcribed from the schema's own disclosure
 * audience view (`votetorrent.qsql:2287-2289`).
 *
 * It exists so that "the setting names an audience this page does not
 * recognise" — D-23's third fault mode — is a CHECKABLE condition rather than
 * an unreachable branch. Without a closed vocabulary, an unrecognised code
 * and a recognised one are the same input.
 *
 * @type {ReadonlyArray<string>}
 */
export const DISCLOSURE_AUDIENCE_CODES = Object.freeze(['district', 'everyone']);

/**
 * The only audience an anonymous reader satisfies. The other recognised code
 * scopes disclosure to a district, and a reader with no identity has no
 * district — so the page cannot establish that such a setting permits this
 * reader, and it fails closed exactly as a malformed setting does.
 * @type {string}
 */
export const ANONYMOUS_AUDIENCE = 'everyone';

/**
 * @typedef {object} RollDisclosureEntry
 * @property {string} field one member of `ROLL_FIELDS`.
 * @property {string} audience one member of `DISCLOSURE_AUDIENCE_CODES`.
 */

/**
 * This page's declared disclosure policy for the published roll: one entry
 * per published field, every one of them the anonymous audience.
 *
 * WHY EVERY ENTRY IS THE SAME, recorded so a later reader does not read the
 * uniformity as laziness: these three columns live in the record the schema
 * names public, each row is signed by the election's authority under the
 * voter-registration scope, and the decision at point 1 of this file's header
 * is to publish exactly that record. An entry that differed would be
 * asserting a distinction the schema does not make.
 *
 * @type {ReadonlyArray<Readonly<RollDisclosureEntry>>}
 */
export const ROLL_DISCLOSURE_POLICY = Object.freeze(
	ROLL_FIELDS.map((field) => Object.freeze({ field, audience: ANONYMOUS_AUDIENCE })),
);

/**
 * @typedef {object} RollColumnVerdict
 * @property {ReadonlyArray<string>} columns the fields that may render, ordered by `ROLL_FIELDS`.
 * @property {ReadonlyArray<string>} unreadable the fields withheld because their setting could not be established, same order.
 */

/**
 * Is this policy entry one that permits an anonymous reader to see the field?
 *
 * Written as an ALLOW-LIST — the column renders only on the full conjunction —
 * rather than as a chain of rejections. The difference matters on the next
 * edit: a future fault mode nobody anticipated gets the WITHHOLD branch by
 * default, whereas a rejection chain would publish anything it forgot to
 * reject.
 *
 * @param {unknown} entry
 * @param {string} field
 * @returns {boolean}
 */
function permitsAnonymousReader(entry, field) {
	if (entry === null || typeof entry !== 'object') return false;
	const candidate = /** @type {{ field?: unknown, audience?: unknown }} */ (entry);
	if (typeof candidate.field !== 'string' || candidate.field === '') return false;
	if (candidate.field !== field) return false;
	if (typeof candidate.audience !== 'string' || candidate.audience === '') return false;
	if (!DISCLOSURE_AUDIENCE_CODES.includes(candidate.audience)) return false;
	return candidate.audience === ANONYMOUS_AUDIENCE;
}

/**
 * Decide which roll columns render, and which were withheld because their
 * disclosure setting could not be established.
 *
 * FAIL-CLOSED, AND SAY SO. Every outcome other than "an entry is present,
 * well-formed, names a recognised audience, and that audience is the
 * anonymous one" withholds the column AND records the field in `unreadable`.
 * The render layer states that a setting could not be read, so a policy fault
 * is never indistinguishable from a deliberate withholding — the same
 * treatment an unreadable timeline gets one screen over. A silent omission
 * would let a reader conclude the authority chose not to publish a column
 * when in fact this page failed to establish whether it may.
 *
 * The output is ordered by `ROLL_FIELDS` and never by the policy's own order,
 * so a reordered or duplicated policy cannot reorder or duplicate the table.
 * A non-array policy — including null and undefined — is treated as zero
 * entries, which produces the all-withheld verdict with no special case.
 *
 * @param {unknown} policy
 * @returns {Readonly<RollColumnVerdict>}
 */
export function resolveRollColumns(policy) {
	const entries = Array.isArray(policy) ? policy : [];

	/** @type {string[]} */
	const columns = [];
	/** @type {string[]} */
	const unreadable = [];

	for (const field of ROLL_FIELDS) {
		// The FIRST entry naming this field decides. A later duplicate cannot
		// override it, and cannot add a second column either.
		const entry = entries.find(
			(candidate) =>
				candidate !== null &&
				typeof candidate === 'object' &&
				/** @type {{ field?: unknown }} */ (candidate).field === field,
		);
		if (permitsAnonymousReader(entry, field)) columns.push(field);
		else unreadable.push(field);
	}

	return Object.freeze({ columns: Object.freeze(columns), unreadable: Object.freeze(unreadable) });
}
