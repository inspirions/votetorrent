import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {getLocales} from 'react-native-localize';

// Feature-namespaced resource tree (D-11) — a deliberate, documented improvement over
// Authority's single flat ~48KB `translation` namespace. Each namespace stays co-located
// with the flow that owns it, so later phases only touch the namespace they're building.
// Shell-only starter key set (D-12) seeded EN+ES in lockstep (I18N-01) from the
// 39-UI-SPEC.md Copywriting Contract — this `resources` export is the source of truth the
// 39-08 namespace-aware parity test walks.
const resources = {
	en: {
		common: {
			tabVote: 'Vote',
			// Phase 59 (D-13) — fifth bottom tab, second position (Vote · Timeline · Registration ·
			// Scan · Settings). Placed here (after tabVote) so property order mirrors D-13's locked
			// tab order.
			tabTimeline: 'Timeline',
			tabRegistration: 'Registration',
			tabScan: 'Scan',
			tabSettings: 'Settings',
			placeholderBody: "This screen isn't built yet — check back in a future update.",
			close: 'Close',
			// Detail inside the "Learn about this …" info dialogs.
			'info.unavailable': "This information isn't available right now.",
			'info.openLink': 'More information',
			networkName: 'Utah Network',
			notifications: 'Notifications',
			'breadcrumb.home': 'Home',
			'breadcrumb.ballot': 'Ballot',
			configNotConfigured: 'Not configured',
			// Quick task 260928-kkf — the boot re-attach's "still syncing" label, shown
			// under the loading spinner while a joiner waits on cadre-core's first-sync
			// gate (mirrors the authority app's SyncChip copy, `syncSyncing`).
			syncSyncing: 'Syncing',
		},
		home: {
			headerTitle: 'Vote',
			// Phase 40 (HOME-01/02/03) — flat dotted keys (property names literally contain
			// dots), required by `keySeparator: false` below. See i18n-parity.test.ts (D-14):
			// walking Object.keys(namespace) shallowly gives full per-key EN/ES coverage only
			// when keys stay flat — a nested { states: { open: {...} } } object would leave
			// sub-keys unchecked and silently break lockstep.
			voteNowCta: 'Vote now',
			learnAboutElection: 'Learn about this election',
			// "Learn about this election" info dialog (Figma Candidate Info frame, election variant).
			'electionInfo.title': 'Election Info',
			'electionInfo.subtitle': 'Informational Page about this election',
			'electionInfo.body': '"The following information has been provided by the election authority"',
			'electionInfo.authority': 'Election authority',
			'electionInfo.date': 'Election day',
			'electionInfo.instructions': 'Instructions',
			'electionInfo.tags': 'Tags',
			'progressLabel': '{{percent}}% complete',
			'countdown.hours': 'hours',
			'countdown.minutes': 'minutes',
			'countdown.seconds': 'seconds',
			'countdown.days': 'days',
			validationDetailsTitle: 'Validation Details',
			'states.upcoming.summary':
				"Voting hasn't opened yet — check back when the polls open.",
			'states.open.summary': 'Cast your vote before the polls close.',
			// [ASSUMED] RESEARCH Pitfall 4/A1 — no dedicated Home-card Figma frame for
			// ReviewSelections; non-canonical placeholder copy, safe to revise later.
			'states.reviewSelections.summary': 'Continue reviewing your ballot selections.',
			'states.releasingKeys.summary': '{{released}}/{{total}} election keys released.',
			'states.validation.summary':
				'Validation status {{checksComplete}}/{{checksTotal}} checks.',
			'states.validationDetails.summary':
				'Validation status {{checksComplete}}/{{checksTotal}} checks — view the full evidence.',
			// [ASSUMED] RESEARCH A2 — no exact compact-card CTA string documented in the
			// extract; authored to match the drill-in screen's own title 1:1.
			'states.validationDetails.cta': 'View Validation Details',
			'states.complete.summary': 'Certified ✓',
			// Fallbacks for a real election read: these states' counted copy above needs data with
			// no engine source yet (keys released, validation checks, certification), so the card
			// states only what the timeline establishes.
			'states.releasingKeys.pendingSummary': 'Voting has closed. Results stay locked until the election keys are released.',
			'states.validation.pendingSummary': 'Election keys released — results are being tallied and validated.',
			'states.complete.closedSummary': 'This election is closed.',
			electionUnavailable: 'No election is available on this network yet.',
			// Phase 42 (VOTE-04/D-08) — the Open card's minimal voted-state reflection: once
			// hasVoted flips true, the "Vote now" CTA becomes this disabled pill instead.
			votedCta: 'You voted',
			'validationDetails.columnCheck': 'Check',
			'validationDetails.columnResult': 'Result',
			'validationDetails.columnTime': 'Time',
			'validationDetails.columnStatus': 'Status',
			'validationDetails.overallCount': '{{verified}}/{{total}} checks verified',
			'validationDetails.fingerprintLabel': 'Fingerprint',
			'validationDetails.recordedInBlockchain':
				'Validation report recorded in blockchain',
			'validationDetails.verified': 'Verified',
			'validationDetails.pending': 'Pending',
			'validationDetails.check1.name': 'Search for voter record',
			'validationDetails.check1.result': 'Voter record found',
			'validationDetails.check2.name': 'Verify voter record',
			'validationDetails.check2.result': 'IDs match',
			'validationDetails.check3.name': 'Check election integrity',
			'validationDetails.check3.result': 'Adjacent blocks and tree path verified',
		},
		ballot: {
			headerTitle: 'Ballot',
			individualQuestionTitle: 'Individual Question',
			// Phase 42 (VOTE-01/02/04) — Ballot Page / Individual Question / Review & Submit UI copy.
			'progressLabel': '{{completed}}/{{total}} questions completed',
			'voteForN': 'Vote for {{n}}',
			'saveExitCta': 'Save & Exit',
			'reviewCta': 'Review & Submit Ballot',
			'continueVotingCta': 'Continue Voting',
			'nextCta': 'Next Question',
			'previousCta': 'Previous Question',
			'submitCta': 'Submit',
			'submittedConfirmation': 'Your ballot was submitted',
			'notYetAnswered': 'Not yet answered',
			'learnAboutOffice': 'Learn about this office',
			'learnAboutCandidate': 'Learn about this candidate',
			// "Learn about this …" info dialogs (Figma Candidate Info frame).
			'candidateInfo.title': 'Candidate Info',
			'candidateInfo.subtitle': 'Informational Page about your selected candidate',
			'candidateInfo.body': '"The following information has been provided by the candidate"',
			'officeInfo.title': 'Office Info',
			'officeInfo.subtitle': 'Informational Page about this office',
			'officeInfo.body': '"The following information has been provided by the office"',
			'officeInfo.instructions': 'Instructions',
			'officeInfo.voteFor': 'You may choose',
			'officeInfo.voteForValue': 'Up to {{count}}',
			'candidateInfo.name': 'Name',
			'candidateInfo.details': 'Details',
			'reviewSubmitTitle': 'Review & Submit',
			// Office titles, candidate names and party lines are NOT keys: they are the authority's
			// published ballot text (Question.title / Option.title / Option.details), shown as-is.
			ballotUnavailable: "This election's ballot isn't available yet.",
			unsupportedQuestions_one: "{{count}} question on this ballot can't be answered in this app yet.",
			unsupportedQuestions_other: "{{count}} questions on this ballot can't be answered in this app yet.",
		},
		registration: {
			headerTitle: 'Registration',
			// RegistrationInfo (the "(?)" help / network-header target): live status + deadline + how it works.
			'info.statusHeading': 'Your registration',
			'info.network': 'Network',
			'info.election': 'Election',
			'info.deadline': 'Registration closes',
			'info.deadlinePassed': 'Registration has closed',
			'info.noElection': 'No election is open for registration on this network.',
			'info.howHeading': 'How registration works',
			'info.step1': 'Your device is checked to confirm it is genuine and secure.',
			'info.step2': 'You enter the personal details the election authority asks for.',
			'info.step3': 'You confirm the request with your device unlock (face, fingerprint or passcode).',
			'info.step4': 'The election authority reviews your request. Once approved you are registered and receive a registration code.',
			deviceAttestationTitle: 'Verifying Your Device',
			confirmationTitle: "You're All Set",
			// Phase 41 (REG-01..05) — flat dotted keys, transcribed verbatim from
			// 41-UI-SPEC.md's Copywriting Contract. `[AUTHORED]` strings noted in the
			// contract are marked below for traceability.
			'notRegistered.heading': 'You are not registered',
			'notRegistered.body':
				'To participate in the Utah Network you will need to register',
			'notRegistered.cta': 'Register now',
			'registered.heading': "You're registered to vote",
			'registered.body': 'You have successfully registered for the Utah Network',
			'registered.identityLine': '{{fullName}}: {{party}} {{dob}}',
			'registered.validThrough': 'Valid through {{validThrough}}',
			'registered.updatePrompt':
				'Have you recently made any changes to your personal info?',
			'registered.updateCta': 'Update registration',
			'deviceAttestation.heading': 'Verifying your device...',
			// [AUTHORED]
			'deviceAttestation.caption': 'Confirming your device is secure',
			// [AUTHORED] — Phase 45-06 (D-09) terminal capability-probe wall.
			'deviceAttestation.terminalHeading': "This device can't be used to vote",
			// [AUTHORED]
			'deviceAttestation.terminalBody':
				'This device lacks the secure hardware required to protect a vote, so it cannot be used to register.',
			'form.sectionTitle': 'Register for the Utah Network',
			'form.firstName': 'First Name',
			'form.lastName': 'Last Name',
			'form.dob': 'Date of Birth',
			'form.email': 'Email',
			'form.phone': 'Phone Number',
			// [AUTHORED]
			'form.dobPlaceholder': 'MM/DD/YYYY',
			// [AUTHORED]
			'form.continueCta': 'Continue',
			// [AUTHORED]
			'form.backCta': 'Back',
			// [AUTHORED]
			'form.submitCta': 'Submit',
			// [AUTHORED] — inline field-validation messages (REG-03 validation, added post-QA)
			'form.errors.required': 'This field is required',
			'form.errors.email': 'Enter a valid email address',
			'form.errors.phone': 'Enter a valid phone number',
			'form.errors.dob': 'Enter your date of birth as MM/DD/YYYY',
			'form.errors.party': 'Select your party',
			// [AUTHORED]
			'form.stepLabel': 'Step {{step}} of 3',
			'form.addressLine1': 'Address line 1',
			'form.addressLine2': 'Address line 2 (optional)',
			'form.addressLine3': 'Address line 3 (optional)',
			'form.selectParty': 'Select Your Party',
			// [AUTHORED]
			'form.party.democratic': 'Democratic Party',
			// [AUTHORED]
			'form.party.republican': 'Republican Party',
			// [AUTHORED]
			'form.party.independent': 'Independent',
			// [AUTHORED]
			'form.party.other': 'Other',
			'form.confirmInstruction': 'Check to ensure all information is correct',
			'form.review.fullName': 'Full Name',
			'form.review.dob': 'Date of Birth',
			'form.review.email': 'Email',
			'form.review.phone': 'Phone Number',
			'form.review.party': 'Registered Party',
			'form.review.address': 'Address',
			'confirmation.heading': "You're all set!",
			'confirmation.body': 'Confirm your registration with Face ID',
			// [AUTHORED]
			'confirmation.cta': 'Confirm with Face ID',
			// [AUTHORED]
			'confirmation.caption': 'Look at your device to confirm',
			// [AUTHORED] — Android variants of the three confirm strings above. The Android ceremony
			// is a BIOMETRIC_STRONG prompt (fingerprint or class-3 face unlock, no PIN fallback),
			// so the iOS Face ID framing is wrong there. The screen picks by Platform.OS.
			'confirmation.body.android': 'Confirm your registration with your fingerprint or face unlock',
			// [AUTHORED]
			'confirmation.cta.android': 'Confirm with biometrics',
			// [AUTHORED]
			'confirmation.caption.android': 'Follow the prompt on your device to confirm',
			// [AUTHORED] — Phase 45-06 (D-09) three-way attestation failure UX.
			'confirmation.error.biometricNotEnrolled': 'Set up fingerprint or face unlock to continue',
			// [AUTHORED]
			'confirmation.error.setupCta': 'Set up device unlock',
			// [AUTHORED]
			'confirmation.error.transient': 'Something went wrong verifying your device. Try again.',
			// [AUTHORED]
			'confirmation.error.terminal': "This device can't be used to vote",
			// [AUTHORED] — the authority's intake refused the request (vote-engine IntakeError): the
			// device is fine, so this must not blame it.
			'confirmation.error.intakeUnavailable': "We couldn't send your registration to the authority right now. Try again later.",
			// [AUTHORED] — native-stack header titles for the form-step routes (41-08).
			formHeaderTitle: 'Register',
			confirmHeaderTitle: 'Confirm',
		},
		scan: {
			headerTitle: 'Scan',
			// [AUTHORED] — branded "not available yet" placeholder copy (43-01, SCAN-01/I18N-01).
			notAvailableTitle: 'QR scanning coming soon',
			notAvailableBody: "QR code scanning isn't available yet — it's coming in a future update.",
		},
		settings: {
			headerTitle: 'Settings',
			language: 'Language',
			// Endonyms in both locales (mobile-locale-picker convention) — a user who can't
			// read the current UI language can still recognize their own language's name.
			languageEnglish: 'English',
			languageSpanish: 'Español',
		},
		// Phase 59 (D-13/D-21) — the voter's Timeline tab. A NEW namespace (not reuse of `home`):
		// `home.states.releasingKeys.summary` already exists and speaks a different sentence for a
		// different surface (ElectionCard's mock lifecycle summary vs. this tab's real row copy) —
		// reusing `home` risks exactly that collision. Flat dotted-string property names
		// (`keySeparator: false` below) — never nested objects. Keys mirror the ElectionEvent
		// member each row's dot/date represents (D-21's row identifier), not the LifecycleState
		// interval, so a row-title key stays stable regardless of which interval an instant
		// currently falls in.
		timeline: {
			'stage.registrationEnds.title': 'Registration Ends',
			'stage.ballotsFinal.title': 'Ballots Finalized',
			'stage.votingPeriod.title': 'Voting Period',
			'stage.accruingVotes.title': 'Accruing Votes',
			'stage.hashingVotes.title': 'Hashing Votes',
			'stage.releasingKeys.title': 'Releasing Keys',
			'stage.tallyingStarts.title': 'Tallying',
			'stage.validation.title': 'Validation',
			'stage.certificationStarts.title': 'Certification',
			'stage.closed.title': 'Election Closed',
			'help.accessibilityLabel': 'More information about {{stage}}',
			'subtitle.yesterday': 'Yesterday',
			'subtitle.today': 'Today - {{weekday}}',
			'subtitle.futureWeekday': '{{weekday}}',
			'subtitle.pastDate': '{{date}}',
			'subtitle.futureDate': '{{date}}',
			'header.dateRange': '{{startDate}} - {{endDate}}',
			headerTitle: 'Timeline',
			'rail.now': 'Now',
			// The UI-SPEC's bold run ("You **are registered** ...") is rendered via a nested <Text>
			// split, NOT markdown-in-string (no rich-text library is used anywhere in this app).
			// `{{bold}}` is a sentinel the consumer splits on; resolving it to
			// `registration.isRegisteredBold`'s own text yields the plain sentence for the panel's
			// `accessibilityLabel`. No third key, no leading/trailing spaces in either resource.
			'registration.isRegistered': 'You {{bold}} in the {{network}}',
			'registration.isRegisteredBold': 'are registered',
			// `pending`/`notRegistered`/`unknown` implement D-23(d)'s three honest states
			// (registered / pending / not registered) plus D-03's explicit-indeterminate path —
			// additions beyond the UI-SPEC's printed "registered" copy, required so 59-09 does not
			// have to reopen this file. Revoked ('r') / suspended ('s') registrants resolve to
			// `notRegistered` — a wiring call made by 59-09, not this namespace.
			'registration.pending': 'Your registration in the {{network}} is awaiting a decision.',
			'registration.notRegistered': 'You are not registered in the {{network}}.',
			'registration.unknown': "We couldn't check your registration status right now.",
			'registration.viewCta': 'View registration',
			'registration.editCta': 'Edit registration',
			'voting.previewBallotCta': 'Preview ballot',
			'voting.voteNowCta': 'Vote now',
			'voting.viewSubmissionCta': 'View submission',
			'row.detailsCta': 'See details',
			'keyholders.viewCta': 'View Keyholders',
			'keyholders.screenTitle': 'Keyholders',
			'keyholders.releasedCount': '{{released}} of {{total}} keys released',
			'keyholders.emptyHeading': 'No keyholders yet',
			'keyholders.emptyBody': 'This election has no keyholders assigned yet.',
			'indeterminate.heading': "We can't show this election's timeline right now",
			'indeterminate.body':
				"The election schedule could not be read or doesn't make sense yet. Try again in a moment.",
			'indeterminate.retryCta': 'Try again',
			// __DEV__-only clock-offset control (D-05) — styled with colors.warning, never a
			// production-affordance color, so it cannot be mistaken for a real control.
			'dev.clockOffsetLabel': 'DEV: Clock offset',
			// WR-04: the probe stop's suffix. It was an inline English literal concatenated onto the
			// translated prefix, so under es the control read 'DEV: Ajuste de reloj Periodo de Votacion
			// final day'. The i18n-parity test only walks literal single-argument translate call
			// sites, so it was structurally unable to see it.
			'dev.finalDayStop': 'final day',
		},
		// Phase 62 (D-31/D-36/D-40/D-41/D-43/D-45) — the `continuity` namespace: device-continuity
		// surfaces (registration code display, continue-on-another-device, retired device, restart a
		// pending registration). Flat dotted-string property names (`keySeparator: false` below) —
		// never nested objects. Consumers use `useTranslation('continuity')`.
		continuity: {
			'code.heading': 'Your Registration Code',
			'code.body':
				"Save this code. If you ever need to continue your registration on another device, you'll enter it there.",
			'code.copyButton': 'Copy Code',
			'code.copiedConfirm': 'Copied',
			'code.showAgainLink': 'Show my registration code',
			'code.unavailable':
				"Your registration code isn't available right now. Try again in a moment.",
			'code.checking': 'Checking your registration…',
			'code.notAvailableOnDevice':
				"A registration code isn't available on this device. If you move to another device, you'll confirm your identity there instead.",
			'newDevice.screenTitle': 'Continue on This Device',
			'newDevice.codeFieldLabel': 'Registration Code',
			'newDevice.codeFieldPlaceholder': 'Enter your code',
			'newDevice.submitButton': 'Continue with Code',
			'newDevice.lostCodeLink': "I don't have my code",
			'newDevice.identityFallbackHeading': 'Confirm Your Identity',
			'newDevice.identityFallbackBody':
				'An officer will match these details to your existing registration. This may take longer than using a code.',
			'newDevice.identityFallbackSubmitButton': 'Submit for Review',
			'newDevice.pendingHeading': 'Waiting for approval',
			'newDevice.pendingBody':
				'An officer needs to approve this device change before you can continue.',
			'newDevice.approvedHeading': 'Device approved',
			'newDevice.rejectedHeading': 'Request not approved',
			'newDevice.rejectedBody':
				'This device change request was not approved. Contact your election authority for help.',
			'newDevice.entryLink': 'Already registered on another device?',
			'newDevice.codeRequired': 'Enter your registration code to continue.',
			'newDevice.submitError': 'Could not send your request. Check your connection and try again.',
			'newDevice.backToCodeLink': 'Use my code instead',
			'newDevice.restartLink': 'My registration is still pending',
			'newDevice.retryButton': 'Try Again',
			'deviceRetired.heading': 'This device has been retired',
			'deviceRetired.body':
				'Your voting registration was moved to another device. This device can no longer be used to vote.',
			'restart.heading': 'Start a New Registration',
			'restart.body':
				'Your previous registration is still pending and tied to your other device. Continuing here starts a brand-new registration from scratch on this device.',
			'restart.confirmButton': 'Start New Registration',
		},
	},
	es: {
		common: {
			tabVote: 'Votar',
			// Phase 59 (D-13) — see the `en.common` block's comment.
			tabTimeline: 'Cronograma',
			tabRegistration: 'Registro',
			tabScan: 'Escanear',
			tabSettings: 'Ajustes',
			placeholderBody: 'Esta pantalla aún no está lista — vuelve a consultar más adelante.',
			close: 'Cerrar',
			'info.unavailable': 'Esta información no está disponible en este momento.',
			'info.openLink': 'Más información',
			networkName: 'Utah Network',
			notifications: 'Notificaciones',
			'breadcrumb.home': 'Inicio',
			'breadcrumb.ballot': 'Papeleta',
			configNotConfigured: 'Sin configurar',
			syncSyncing: 'Sincronizando',
		},
		home: {
			headerTitle: 'Votar',
			voteNowCta: 'Votar ahora',
			learnAboutElection: 'Conoce más sobre esta elección',
			// "Learn about this election" info dialog (Figma Candidate Info frame, election variant).
			'electionInfo.title': 'Información de la elección',
			'electionInfo.subtitle': 'Página informativa sobre esta elección',
			'electionInfo.body': '"La siguiente información ha sido proporcionada por la autoridad electoral"',
			'electionInfo.authority': 'Autoridad electoral',
			'electionInfo.date': 'Día de la elección',
			'electionInfo.instructions': 'Instrucciones',
			'electionInfo.tags': 'Etiquetas',
			'progressLabel': '{{percent}}% completado',
			'countdown.hours': 'horas',
			'countdown.minutes': 'minutos',
			'countdown.seconds': 'segundos',
			'countdown.days': 'días',
			validationDetailsTitle: 'Detalles de Validación',
			'states.upcoming.summary':
				'La votación aún no ha comenzado — vuelve cuando se abran las urnas.',
			'states.open.summary': 'Emite tu voto antes de que cierren las urnas.',
			// [ASSUMED] RESEARCH Pitfall 4/A1 — see EN comment above.
			'states.reviewSelections.summary':
				'Continúa revisando tus selecciones de la boleta.',
			'states.releasingKeys.summary': '{{released}}/{{total}} claves de elección liberadas.',
			'states.validation.summary':
				'Estado de validación {{checksComplete}}/{{checksTotal}} verificaciones.',
			'states.validationDetails.summary':
				'Estado de validación {{checksComplete}}/{{checksTotal}} verificaciones — ver toda la evidencia.',
			// [ASSUMED] RESEARCH A2 — see EN comment above.
			'states.validationDetails.cta': 'Ver Detalles de Validación',
			'states.complete.summary': 'Certificada ✓',
			'states.releasingKeys.pendingSummary':
				'La votación ha cerrado. Los resultados permanecen bloqueados hasta que se liberen las claves de la elección.',
			'states.validation.pendingSummary':
				'Claves de la elección liberadas — los resultados se están contando y validando.',
			'states.complete.closedSummary': 'Esta elección ha cerrado.',
			electionUnavailable: 'Aún no hay ninguna elección disponible en esta red.',
			votedCta: 'Ya votaste',
			'validationDetails.columnCheck': 'Verificación',
			'validationDetails.columnResult': 'Resultado',
			'validationDetails.columnTime': 'Tiempo',
			'validationDetails.columnStatus': 'Estado',
			'validationDetails.overallCount': '{{verified}}/{{total}} verificaciones completadas',
			'validationDetails.fingerprintLabel': 'Huella digital',
			'validationDetails.recordedInBlockchain':
				'Informe de validación registrado en la cadena de bloques',
			'validationDetails.verified': 'Verificado',
			'validationDetails.pending': 'Pendiente',
			'validationDetails.check1.name': 'Buscar registro de votante',
			'validationDetails.check1.result': 'Registro de votante encontrado',
			'validationDetails.check2.name': 'Verificar registro de votante',
			'validationDetails.check2.result': 'Las identificaciones coinciden',
			'validationDetails.check3.name': 'Verificar la integridad de la elección',
			'validationDetails.check3.result':
				'Bloques adyacentes y ruta del árbol verificados',
		},
		ballot: {
			headerTitle: 'Boleta',
			individualQuestionTitle: 'Pregunta Individual',
			'progressLabel': '{{completed}}/{{total}} preguntas completadas',
			'voteForN': 'Vote por {{n}}',
			'saveExitCta': 'Guardar y salir',
			'reviewCta': 'Revisar y enviar boleta',
			'continueVotingCta': 'Continuar votando',
			'nextCta': 'Siguiente pregunta',
			'previousCta': 'Pregunta anterior',
			'submitCta': 'Enviar',
			'submittedConfirmation': 'Tu boleta fue enviada',
			'notYetAnswered': 'Aún no respondido',
			'learnAboutOffice': 'Conoce más sobre este cargo',
			'learnAboutCandidate': 'Conoce más sobre este candidato',
			// "Learn about this …" info dialogs (Figma Candidate Info frame).
			'candidateInfo.title': 'Información del candidato',
			'candidateInfo.subtitle': 'Página informativa sobre el candidato seleccionado',
			'candidateInfo.body': '"La siguiente información ha sido proporcionada por el candidato"',
			'officeInfo.title': 'Información del cargo',
			'officeInfo.subtitle': 'Página informativa sobre este cargo',
			'officeInfo.body': '"La siguiente información ha sido proporcionada por el cargo"',
			'officeInfo.instructions': 'Instrucciones',
			'officeInfo.voteFor': 'Puedes elegir',
			'officeInfo.voteForValue': 'Hasta {{count}}',
			'candidateInfo.name': 'Nombre',
			'candidateInfo.details': 'Detalles',
			'reviewSubmitTitle': 'Revisar y enviar',
			ballotUnavailable: 'La boleta de esta elección aún no está disponible.',
			unsupportedQuestions_one: '{{count}} pregunta de esta boleta aún no se puede responder en esta aplicación.',
			unsupportedQuestions_other: '{{count}} preguntas de esta boleta aún no se pueden responder en esta aplicación.',
		},
		registration: {
			headerTitle: 'Registro',
			'info.statusHeading': 'Tu registro',
			'info.network': 'Red',
			'info.election': 'Elección',
			'info.deadline': 'El registro cierra',
			'info.deadlinePassed': 'El registro ha cerrado',
			'info.noElection': 'No hay ninguna elección abierta para registro en esta red.',
			'info.howHeading': 'Cómo funciona el registro',
			'info.step1': 'Se verifica tu dispositivo para confirmar que es auténtico y seguro.',
			'info.step2': 'Ingresas los datos personales que solicita la autoridad electoral.',
			'info.step3': 'Confirmas la solicitud con el desbloqueo de tu dispositivo (rostro, huella o código).',
			'info.step4': 'La autoridad electoral revisa tu solicitud. Una vez aprobada quedas registrado y recibes un código de registro.',
			deviceAttestationTitle: 'Verificando Tu Dispositivo',
			confirmationTitle: 'Todo Listo',
			'notRegistered.heading': 'No estás registrado',
			'notRegistered.body':
				'Para participar en la Red de Utah necesitarás registrarte',
			'notRegistered.cta': 'Regístrate ahora',
			'registered.heading': 'Estás registrado para votar',
			'registered.body': 'Te has registrado exitosamente en la Red de Utah',
			'registered.identityLine': '{{fullName}}: {{party}} {{dob}}',
			'registered.validThrough': 'Válido hasta {{validThrough}}',
			'registered.updatePrompt':
				'¿Has hecho cambios recientes en tu información personal?',
			'registered.updateCta': 'Actualizar registro',
			'deviceAttestation.heading': 'Verificando tu dispositivo...',
			'deviceAttestation.caption': 'Confirmando que tu dispositivo es seguro',
			'deviceAttestation.terminalHeading': 'Este dispositivo no se puede usar para votar',
			'deviceAttestation.terminalBody':
				'Este dispositivo no cuenta con el hardware seguro necesario para proteger un voto, por lo que no se puede usar para registrarte.',
			'form.sectionTitle': 'Regístrate en la Red de Utah',
			'form.firstName': 'Nombre',
			'form.lastName': 'Apellido',
			'form.dob': 'Fecha de Nacimiento',
			'form.email': 'Correo Electrónico',
			'form.phone': 'Número de Teléfono',
			'form.dobPlaceholder': 'MM/DD/AAAA',
			'form.continueCta': 'Continuar',
			'form.backCta': 'Atrás',
			'form.submitCta': 'Enviar',
			'form.errors.required': 'Este campo es obligatorio',
			'form.errors.email': 'Introduce un correo electrónico válido',
			'form.errors.phone': 'Introduce un número de teléfono válido',
			'form.errors.dob': 'Introduce tu fecha de nacimiento como MM/DD/AAAA',
			'form.errors.party': 'Selecciona tu partido',
			'form.stepLabel': 'Paso {{step}} de 3',
			'form.addressLine1': 'Dirección línea 1',
			'form.addressLine2': 'Dirección línea 2 (opcional)',
			'form.addressLine3': 'Dirección línea 3 (opcional)',
			'form.selectParty': 'Selecciona Tu Partido',
			'form.party.democratic': 'Partido Demócrata',
			'form.party.republican': 'Partido Republicano',
			'form.party.independent': 'Independiente',
			'form.party.other': 'Otro',
			'form.confirmInstruction': 'Verifica que toda la información sea correcta',
			'form.review.fullName': 'Nombre Completo',
			'form.review.dob': 'Fecha de Nacimiento',
			'form.review.email': 'Correo Electrónico',
			'form.review.phone': 'Número de Teléfono',
			'form.review.party': 'Partido Registrado',
			'form.review.address': 'Dirección',
			'confirmation.heading': '¡Todo listo!',
			'confirmation.body': 'Confirma tu registro con Face ID',
			'confirmation.cta': 'Confirmar con Face ID',
			'confirmation.caption': 'Mira tu dispositivo para confirmar',
			'confirmation.body.android': 'Confirma tu registro con tu huella o desbloqueo facial',
			'confirmation.cta.android': 'Confirmar con biometría',
			'confirmation.caption.android': 'Sigue las indicaciones de tu dispositivo para confirmar',
			'confirmation.error.biometricNotEnrolled': 'Configura el desbloqueo por huella o rostro para continuar',
			'confirmation.error.setupCta': 'Configurar desbloqueo del dispositivo',
			'confirmation.error.transient': 'Algo salió mal al verificar tu dispositivo. Inténtalo de nuevo.',
			'confirmation.error.terminal': 'Este dispositivo no se puede usar para votar',
			'confirmation.error.intakeUnavailable': 'No pudimos enviar tu registro a la autoridad en este momento. Inténtalo más tarde.',
			formHeaderTitle: 'Registrarse',
			confirmHeaderTitle: 'Confirmar',
		},
		scan: {
			headerTitle: 'Escanear',
			notAvailableTitle: 'Escaneo QR próximamente',
			notAvailableBody:
				'El escaneo de códigos QR aún no está disponible — llegará en una próxima actualización.',
		},
		settings: {
			headerTitle: 'Ajustes',
			language: 'Idioma',
			// Endonyms in both locales (mobile-locale-picker convention).
			languageEnglish: 'English',
			languageSpanish: 'Español',
		},
		// Phase 59 (D-13/D-21) — see the `en.timeline` block's comment.
		timeline: {
			'stage.registrationEnds.title': 'Fin del Registro',
			'stage.ballotsFinal.title': 'Boletas Finalizadas',
			'stage.votingPeriod.title': 'Período de Votación',
			'stage.accruingVotes.title': 'Acumulando Votos',
			'stage.hashingVotes.title': 'Verificando Votos',
			'stage.releasingKeys.title': 'Liberando Claves',
			'stage.tallyingStarts.title': 'Escrutinio',
			'stage.validation.title': 'Validación',
			'stage.certificationStarts.title': 'Certificación',
			'stage.closed.title': 'Elección Cerrada',
			'help.accessibilityLabel': 'Más información sobre {{stage}}',
			'subtitle.yesterday': 'Ayer',
			'subtitle.today': 'Hoy - {{weekday}}',
			'subtitle.futureWeekday': '{{weekday}}',
			'subtitle.pastDate': '{{date}}',
			'subtitle.futureDate': '{{date}}',
			'header.dateRange': '{{startDate}} - {{endDate}}',
			headerTitle: 'Cronograma',
			'rail.now': 'Ahora',
			// Spanish word order leads with the bold run — see the `en.timeline` block's comment
			// for the sentinel-split mechanism.
			'registration.isRegistered': '{{bold}} en la {{network}}',
			'registration.isRegisteredBold': 'Estás registrado',
			'registration.pending': 'Tu registro en la {{network}} está esperando una decisión.',
			'registration.notRegistered': 'No estás registrado en la {{network}}.',
			'registration.unknown': 'No pudimos verificar tu estado de registro en este momento.',
			'registration.viewCta': 'Ver registro',
			'registration.editCta': 'Editar registro',
			'voting.previewBallotCta': 'Vista previa de la boleta',
			'voting.voteNowCta': 'Votar ahora',
			'voting.viewSubmissionCta': 'Ver mi envío',
			'row.detailsCta': 'Ver detalles',
			'keyholders.viewCta': 'Ver Custodios de Claves',
			'keyholders.screenTitle': 'Custodios de Claves',
			'keyholders.releasedCount': '{{released}} de {{total}} claves liberadas',
			'keyholders.emptyHeading': 'Aún no hay custodios',
			'keyholders.emptyBody': 'Esta elección aún no tiene custodios asignados.',
			'indeterminate.heading': 'No podemos mostrar el cronograma de esta elección en este momento',
			'indeterminate.body':
				'No se pudo leer el cronograma de la elección o aún no es válido. Inténtalo de nuevo en un momento.',
			'indeterminate.retryCta': 'Intentar de nuevo',
			'dev.clockOffsetLabel': 'DEV: Ajuste de reloj',
			'dev.finalDayStop': 'último día',
		},
		// Phase 62 — see the `en.continuity` block's comment.
		continuity: {
			'code.heading': 'Tu Código de Registro',
			'code.body':
				'Guarda este código. Si alguna vez necesitas continuar tu registro en otro dispositivo, lo introducirás allí.',
			'code.copyButton': 'Copiar Código',
			'code.copiedConfirm': 'Copiado',
			'code.showAgainLink': 'Mostrar mi código de registro',
			'code.unavailable':
				'Tu código de registro no está disponible en este momento. Inténtalo de nuevo en un momento.',
			'code.checking': 'Comprobando tu registro…',
			'code.notAvailableOnDevice':
				'No hay un código de registro disponible en este dispositivo. Si cambias a otro dispositivo, confirmarás tu identidad allí.',
			'newDevice.screenTitle': 'Continuar en Este Dispositivo',
			'newDevice.codeFieldLabel': 'Código de Registro',
			'newDevice.codeFieldPlaceholder': 'Introduce tu código',
			'newDevice.submitButton': 'Continuar con el código',
			'newDevice.lostCodeLink': 'No tengo mi código',
			'newDevice.identityFallbackHeading': 'Confirma tu Identidad',
			'newDevice.identityFallbackBody':
				'Un funcionario comparará estos datos con tu registro existente. Esto puede tardar más que usar un código.',
			'newDevice.identityFallbackSubmitButton': 'Enviar para Revisión',
			'newDevice.pendingHeading': 'Esperando aprobación',
			'newDevice.pendingBody':
				'Un funcionario debe aprobar este cambio de dispositivo antes de que puedas continuar.',
			'newDevice.approvedHeading': 'Dispositivo aprobado',
			'newDevice.rejectedHeading': 'Solicitud no aprobada',
			'newDevice.rejectedBody':
				'Esta solicitud de cambio de dispositivo no fue aprobada. Contacta a tu autoridad electoral para obtener ayuda.',
			'newDevice.entryLink': '¿Ya te registraste en otro dispositivo?',
			'newDevice.codeRequired': 'Introduce tu código de registro para continuar.',
			'newDevice.submitError': 'No se pudo enviar tu solicitud. Revisa tu conexión e inténtalo de nuevo.',
			'newDevice.backToCodeLink': 'Usar mi código en su lugar',
			'newDevice.restartLink': 'Mi registro aún está pendiente',
			'newDevice.retryButton': 'Intentar de nuevo',
			'deviceRetired.heading': 'Este dispositivo ha sido retirado',
			'deviceRetired.body':
				'Tu registro de votación se trasladó a otro dispositivo. Este dispositivo ya no se puede usar para votar.',
			'restart.heading': 'Iniciar un Nuevo Registro',
			'restart.body':
				'Tu registro anterior sigue pendiente y vinculado a tu otro dispositivo. Continuar aquí inicia un registro completamente nuevo desde cero en este dispositivo.',
			'restart.confirmButton': 'Iniciar Nuevo Registro',
		},
	},
};

const deviceLanguage = getLocales()[0]?.languageCode ?? 'en';

i18n.use(initReactI18next).init({
	resources: resources,
	ns: Object.keys(resources.en),
	defaultNS: 'common',
	lng: deviceLanguage,
	fallbackLng: 'en',
	// Phase 40 (D-12 lockstep / D-14 parity coverage) — `home.*` keys are authored as FLAT
	// dotted-string property names (e.g. 'states.open.summary'), not nested objects. With the
	// i18next default '.' keySeparator, a flat key like 'states.open.summary' would be
	// misinterpreted as a nested path ({ states: { open: { summary } } }) and fail to resolve at
	// runtime. Existing single-segment keys (headerTitle, tabVote, etc.) are unaffected.
	keySeparator: false,
	interpolation: {
		escapeValue: false,
	},
});

export {resources};
export default i18n;
