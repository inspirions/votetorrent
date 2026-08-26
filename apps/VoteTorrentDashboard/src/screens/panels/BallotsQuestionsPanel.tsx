/**
 * BallotsQuestionsPanel.tsx -- the `ceb` panel body: ballots, their
 * questions and option counts, for the active election.
 *
 * Renders no control of any kind (rule R2) and issues its own reads from an
 * effect against `props.db` (rule R6) -- see `RegistrationsPanel.tsx`'s
 * header for the shared reasoning.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '../../i18n/copy.js';
import { readBallots, readQuestions, countBallotSigningTasks } from '../../reads/ballots.js';
import { selectActiveElection } from '../../reads/elections.js';
import './election-ops.css';

// Field labels reproduced VERBATIM from the schema (rule R1), rendered as
// JSX EXPRESSIONS, never as literal JSX text.
const COL = Object.freeze({
	ballotDeadline: 'BallotDeadline',
	required: 'Required',
	pendingSigningTasks: 'BallotSignatureTaskExtension',
});

type QuestionRow = Awaited<ReturnType<typeof readQuestions>>[number];

interface BallotsData {
	title: string;
	ballotDeadline: string;
	ballots: Awaited<ReturnType<typeof readBallots>>;
	questionsByBallot: Map<string, QuestionRow[]>;
	pendingSigningTasks: number;
}

interface BallotsState {
	loading: boolean;
	data: BallotsData | null;
}

/** Parse an `OptionRange` JSON column into a `"min-max"` figure. Never throws. */
function optionRangeFigure(raw: unknown): string {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (parsed && typeof parsed === 'object') {
			const { min, max } = parsed as { min?: number; max?: number };
			return `${min ?? ''}-${max ?? ''}`;
		}
	} catch {
		// fall through to empty figure below
	}
	return '';
}

const BallotsQuestionsPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<BallotsState>({ loading: true, data: null });

	useEffect(() => {
		let cancelled = false;

		if (!db) {
			setState({ loading: false, data: null });
			return () => {
				cancelled = true;
			};
		}

		setState({ loading: true, data: null });

		const boundDb = db;
		(async () => {
			try {
				const active = await selectActiveElection(boundDb);
				if (!active) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const ballots = await readBallots(boundDb, active.Id);
				if (ballots.length === 0) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const questions = await readQuestions(boundDb, active.Id);
				const questionsByBallot = new Map<string, QuestionRow[]>();
				for (const question of questions) {
					const existing = questionsByBallot.get(question.BallotId) ?? [];
					existing.push(question);
					questionsByBallot.set(question.BallotId, existing);
				}
				const pendingSigningTasks = await countBallotSigningTasks(boundDb);
				if (!cancelled) {
					setState({
						loading: false,
						data: {
							title: active.Title,
							ballotDeadline: active.BallotDeadline,
							ballots,
							questionsByBallot,
							pendingSigningTasks,
						},
					});
				}
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('BallotsQuestionsPanel: a read failed:', (err as { name?: string })?.name ?? 'Error');
				if (!cancelled) {
					setState({ loading: false, data: null });
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [db]);

	if (!db || state.loading || !state.data) {
		return <p className="panel-empty">{t(capability.emptyKey)}</p>;
	}

	const { title, ballotDeadline, ballots, questionsByBallot, pendingSigningTasks } = state.data;
	const pendingFigure = `${COL.pendingSigningTasks} ${pendingSigningTasks}`;

	return (
		<>
			<div className="eo-row">
				<span>{title}</span>
				<span className="eo-datum" title={COL.ballotDeadline}>
					{ballotDeadline}
				</span>
			</div>
			{ballots.map((ballot) => {
				const districtsJoined = ballot.Districts.join(', ');
				const questions = questionsByBallot.get(ballot.Id) ?? [];
				return (
					<section className="eo-section" key={ballot.Id}>
						<div className="eo-row">
							<span>{ballot.Description}</span>
							<span className="eo-datum">{districtsJoined}</span>
							<span className="pill">{ballot.Id}</span>
						</div>
						{questions.map((question) => (
							<div className="eo-row" key={`${question.BallotId}-${question.Code}`}>
								<span>{question.Code}</span>
								<span>{question.Title}</span>
								<span className="eo-datum">{question.TypeName}</span>
								<span className="eo-datum">{optionRangeFigure(question.OptionRange)}</span>
								<span>{question.OptionCount}</span>
								{question.Required === 1 ? <span className="pill">{COL.required}</span> : null}
							</div>
						))}
					</section>
				);
			})}
			<span className="eo-datum">{pendingFigure}</span>
		</>
	);
};

export default BallotsQuestionsPanel;
