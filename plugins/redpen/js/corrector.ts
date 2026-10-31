/**
 * Redpen's deterministic corrector.
 *
 * Pure TypeScript. Zero imports, zero side effects, zero platform coupling — it must be
 * unit-testable outside the Discord client (see `corrector.test.ts`).
 *
 * Pipeline:
 *   mask (code fences, inline code, URLs) -> 10 ordered rule groups -> unmask
 *
 * `correct()` runs the pipeline to a fixpoint (at most `MAX_PASSES`), which guarantees
 * idempotence: `correct(correct(x).corrected).corrected === correct(x).corrected`.
 */

/** Corrector version, surfaced read-only in the plugin's settings. */
export const CORRECTOR_VERSION = '1.0.0'

export type RuleId =
	| 'whitespace'
	| 'punctuation-spacing'
	| 'ellipsis-dashes'
	| 'contractions'
	| 'misspellings'
	| 'standalone-i'
	| 'repeated-words'
	| 'sentence-capitalization'
	| 'terminal-punctuation'
	| 'double-punctuation'

export interface CorrectionChange {
	/** The rule group that produced the change. */
	rule: string
	from: string
	to: string
}

export interface CorrectionResult {
	original: string
	corrected: string
	changes: CorrectionChange[]
}

export interface CorrectorOptions {
	/** Rule groups to skip. Everything is enabled by default. */
	skip?: RuleId[]
	/** Extra whole-word replacements (a user dictionary), applied after the built-in ones. */
	dictionary?: Record<string, string>
}

export const DEFAULT_OPTIONS: CorrectorOptions = {
	skip: [],
	dictionary: {},
}

const MAX_PASSES = 4

/* -------------------------------------------------------------------------- */
/* Dictionaries                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Missing apostrophes. Keys are lowercased and matched as whole words, case-insensitively.
 *
 * `its` is deliberately absent: it is a real possessive in the majority of messages and
 * the spec requires leaving it unchanged when the intent is ambiguous.
 */
const CONTRACTIONS: Record<string, string> = {
	arent: "aren't",
	cant: "can't",
	couldnt: "couldn't",
	didnt: "didn't",
	doesnt: "doesn't",
	dont: "don't",
	hadnt: "hadn't",
	hasnt: "hasn't",
	havent: "haven't",
	im: "i'm",
	isnt: "isn't",
	ive: "i've",
	lets: "let's",
	shouldnt: "shouldn't",
	thats: "that's",
	theyre: "they're",
	wasnt: "wasn't",
	weve: "we've",
	whats: "what's",
	wont: "won't",
	wouldnt: "wouldn't",
	youre: "you're",
}

/** Fixed dictionary of common misspellings. Whole words only, casing preserved. */
const MISSPELLINGS: Record<string, string> = {
	accomodate: 'accommodate',
	accross: 'across',
	acheive: 'achieve',
	acknowlege: 'acknowledge',
	adress: 'address',
	agressive: 'aggressive',
	allright: 'all right',
	allways: 'always',
	alot: 'a lot',
	ammount: 'amount',
	anually: 'annually',
	apparant: 'apparent',
	apparantly: 'apparently',
	appearence: 'appearance',
	aquire: 'acquire',
	arguement: 'argument',
	arguements: 'arguments',
	attatched: 'attached',
	attendence: 'attendance',
	auxillary: 'auxiliary',
	basicly: 'basically',
	becasue: 'because',
	becuase: 'because',
	begining: 'beginning',
	beleive: 'believe',
	beleived: 'believed',
	beleives: 'believes',
	benifit: 'benefit',
	bizzare: 'bizarre',
	brillant: 'brilliant',
	buisness: 'business',
	burried: 'buried',
	calender: 'calendar',
	catagory: 'category',
	cemetary: 'cemetery',
	challange: 'challenge',
	changable: 'changeable',
	charachter: 'character',
	cheif: 'chief',
	chosing: 'choosing',
	collegue: 'colleague',
	comming: 'coming',
	commited: 'committed',
	commitee: 'committee',
	compitent: 'competent',
	completly: 'completely',
	concious: 'conscious',
	concensus: 'consensus',
	condradict: 'contradict',
	congradulate: 'congratulate',
	consequnce: 'consequence',
	consistant: 'consistent',
	contries: 'countries',
	corespond: 'correspond',
	critisism: 'criticism',
	curiousity: 'curiosity',
	currenly: 'currently',
	decison: 'decision',
	decisons: 'decisions',
	definatly: 'definitely',
	definate: 'definite',
	definately: 'definitely',
	desicion: 'decision',
	desparate: 'desperate',
	developement: 'development',
	diferent: 'different',
	diffrent: 'different',
	dilemna: 'dilemma',
	disapoint: 'disappoint',
	dissagreement: 'disagreement',
	dissapear: 'disappear',
	dissappear: 'disappear',
	dissapoint: 'disappoint',
	ealier: 'earlier',
	efficent: 'efficient',
	embarass: 'embarrass',
	embarassed: 'embarrassed',
	embarassing: 'embarrassing',
	enought: 'enough',
	enterance: 'entrance',
	entrepeneur: 'entrepreneur',
	enviroment: 'environment',
	equiped: 'equipped',
	eventhough: 'even though',
	everytime: 'every time',
	exagerate: 'exaggerate',
	excede: 'exceed',
	excelent: 'excellent',
	excellant: 'excellent',
	excercise: 'exercise',
	exhorbitant: 'exorbitant',
	existance: 'existence',
	existant: 'existent',
	explaination: 'explanation',
	experiance: 'experience',
	extreem: 'extreme',
	facinating: 'fascinating',
	familar: 'familiar',
	febuary: 'february',
	finaly: 'finally',
	flamable: 'flammable',
	flourescent: 'fluorescent',
	forcast: 'forecast',
	forgien: 'foreign',
	foriegn: 'foreign',
	fortunatly: 'fortunately',
	fourty: 'forty',
	foward: 'forward',
	freind: 'friend',
	freindly: 'friendly',
	futher: 'further',
	furthur: 'further',
	garantee: 'guarantee',
	garanteed: 'guaranteed',
	gaurd: 'guard',
	generaly: 'generally',
	goverment: 'government',
	grammer: 'grammar',
	gratefull: 'grateful',
	greatful: 'grateful',
	gruop: 'group',
	guidlines: 'guidelines',
	happend: 'happened',
	harrass: 'harass',
	heaviliy: 'heavily',
	heigth: 'height',
	heirarchy: 'hierarchy',
	hight: 'height',
	humerous: 'humorous',
	humourous: 'humorous',
	ignorence: 'ignorance',
	imediately: 'immediately',
	immediatley: 'immediately',
	immediatly: 'immediately',
	immitate: 'imitate',
	impement: 'implement',
	inbalance: 'imbalance',
	inconvienience: 'inconvenience',
	indefinately: 'indefinitely',
	independant: 'independent',
	influance: 'influence',
	inteligent: 'intelligent',
	intrest: 'interest',
	intresting: 'interesting',
	interupt: 'interrupt',
	irresistable: 'irresistible',
	irrelevent: 'irrelevant',
	iritate: 'irritate',
	issueing: 'issuing',
	knowlege: 'knowledge',
	knowledgable: 'knowledgeable',
	liason: 'liaison',
	libary: 'library',
	liesure: 'leisure',
	likelyhood: 'likelihood',
	lisence: 'license',
	litterally: 'literally',
	lonley: 'lonely',
	maintainance: 'maintenance',
	maintainence: 'maintenance',
	managable: 'manageable',
	manuever: 'maneuver',
	medeval: 'medieval',
	millenium: 'millennium',
	miniscule: 'minuscule',
	mischevious: 'mischievous',
	mispell: 'misspell',
	mispelled: 'misspelled',
	mistery: 'mystery',
	moniter: 'monitor',
	neccessary: 'necessary',
	neccessarily: 'necessarily',
	necesary: 'necessary',
	neice: 'niece',
	nieghbor: 'neighbor',
	nieghbour: 'neighbour',
	nineth: 'ninth',
	ninty: 'ninety',
	noticable: 'noticeable',
	noticably: 'noticeably',
	nowdays: 'nowadays',
	obediance: 'obedience',
	ocasion: 'occasion',
	occassion: 'occasion',
	occassionally: 'occasionally',
	occationally: 'occasionally',
	occured: 'occurred',
	occurance: 'occurrence',
	occurence: 'occurrence',
	ocurred: 'occurred',
	offical: 'official',
	offically: 'officially',
	omited: 'omitted',
	ommission: 'omission',
	oposite: 'opposite',
	opperation: 'operation',
	oppinion: 'opinion',
	oppurtunity: 'opportunity',
	optomism: 'optimism',
	origional: 'original',
	orthadox: 'orthodox',
	outragous: 'outrageous',
	overal: 'overall',
	paralel: 'parallel',
	pasttime: 'pastime',
	payed: 'paid',
	peculier: 'peculiar',
	peice: 'piece',
	peom: 'poem',
	percieve: 'perceive',
	perfomance: 'performance',
	permanant: 'permanent',
	persaude: 'persuade',
	perseverence: 'perseverance',
	personel: 'personnel',
	persistant: 'persistent',
	persue: 'pursue',
	phenomonon: 'phenomenon',
	posess: 'possess',
	posession: 'possession',
	posessive: 'possessive',
	potatoe: 'potato',
	potentional: 'potential',
	practicle: 'practical',
	precedance: 'precedence',
	prefered: 'preferred',
	prefering: 'preferring',
	prepair: 'prepare',
	presance: 'presence',
	presumibly: 'presumably',
	prevelant: 'prevalent',
	privelege: 'privilege',
	priviledge: 'privilege',
	probally: 'probably',
	probaly: 'probably',
	procede: 'proceed',
	proffesional: 'professional',
	promiss: 'promise',
	pronounciation: 'pronunciation',
	propietor: 'proprietor',
	propoganda: 'propaganda',
	publically: 'publicly',
	questionaire: 'questionnaire',
	quikly: 'quickly',
	quizes: 'quizzes',
	realy: 'really',
	reccomend: 'recommend',
	reccommend: 'recommend',
	reccuring: 'recurring',
	recepient: 'recipient',
	reciept: 'receipt',
	recieve: 'receive',
	recieving: 'receiving',
	recomend: 'recommend',
	recomendation: 'recommendation',
	reconize: 'recognize',
	recuring: 'recurring',
	refered: 'referred',
	refering: 'referring',
	reguardless: 'regardless',
	relevent: 'relevant',
	religeon: 'religion',
	religous: 'religious',
	remeber: 'remember',
	repitition: 'repetition',
	responsable: 'responsible',
	restaraunt: 'restaurant',
	resturant: 'restaurant',
	rythm: 'rhythm',
	rythym: 'rhythm',
	sacrafice: 'sacrifice',
	saftey: 'safety',
	safty: 'safety',
	sattelite: 'satellite',
	scedual: 'schedule',
	scedule: 'schedule',
	scenerio: 'scenario',
	schedual: 'schedule',
	secratary: 'secretary',
	seige: 'siege',
	seperate: 'separate',
	serios: 'serious',
	sieze: 'seize',
	similiar: 'similar',
	similer: 'similar',
	sincerelly: 'sincerely',
	sincerly: 'sincerely',
	specail: 'special',
	speach: 'speech',
	stange: 'strange',
	steriod: 'steroid',
	succede: 'succeed',
	succesful: 'successful',
	succesfully: 'successfully',
	sucess: 'success',
	suficcient: 'sufficient',
	sumary: 'summary',
	supercede: 'supersede',
	supress: 'suppress',
	suprise: 'surprise',
	supprise: 'surprise',
	suprised: 'surprised',
	surprize: 'surprise',
	tatoo: 'tattoo',
	teh: 'the',
	tempreture: 'temperature',
	tendancy: 'tendency',
	theorectical: 'theoretical',
	therefor: 'therefore',
	thier: 'their',
	thourough: 'thorough',
	threshhold: 'threshold',
	tobbaco: 'tobacco',
	tolerence: 'tolerance',
	tomorow: 'tomorrow',
	tommorow: 'tomorrow',
	tommorrow: 'tomorrow',
	totaly: 'totally',
	tounge: 'tongue',
	tranfered: 'transferred',
	transfered: 'transferred',
	truely: 'truly',
	twelth: 'twelfth',
	unathorized: 'unauthorized',
	unconsious: 'unconscious',
	unecessarily: 'unnecessarily',
	unecessary: 'unnecessary',
	unforseen: 'unforeseen',
	unfortunatly: 'unfortunately',
	uniquley: 'uniquely',
	unnesessary: 'unnecessary',
	untill: 'until',
	upcomming: 'upcoming',
	usally: 'usually',
	useable: 'usable',
	usefull: 'useful',
	usualy: 'usually',
	vacum: 'vacuum',
	vaccuum: 'vacuum',
	vegatable: 'vegetable',
	vegitarian: 'vegetarian',
	vehical: 'vehicle',
	verisons: 'versions',
	visable: 'visible',
	vistor: 'visitor',
	volumne: 'volume',
	wether: 'whether',
	whereever: 'wherever',
	wich: 'which',
	wierd: 'weird',
	withdrawl: 'withdrawal',
	wittness: 'witness',
	woudl: 'would',
	writting: 'writing',
	writen: 'written',
	yatch: 'yacht',
	yeild: 'yield',
	yuor: 'your',
}

/** Words that end in a period without ending a sentence. Used by rules 2 and 8. */
const ABBREVIATIONS = new Set([
	'appt',
	'approx',
	'avg',
	'cf',
	'co',
	'dept',
	'dr',
	'e',
	'ed',
	'eg',
	'etc',
	'fig',
	'gov',
	'i',
	'ie',
	'inc',
	'jr',
	'ltd',
	'max',
	'min',
	'misc',
	'mr',
	'mrs',
	'ms',
	'mt',
	'no',
	'prof',
	'st',
	'sr',
	'vs',
	'vol',
])

/* -------------------------------------------------------------------------- */
/* Masking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Placeholders use control characters that no rule can match, so masked spans survive
 * every pass untouched. `Restore` puts the original spans back.
 */
const MASK_OPEN = '\u0001'
const MASK_CLOSE = '\u0002'
const MASK_PATTERN = /\u0001(\d+)\u0002/g

type MaskKind = 'fence' | 'inline' | 'url'

interface MaskEntry {
	text: string
	kind: MaskKind
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
const FENCE_PATTERN = /```[\s\S]*?```|```[\s\S]*$/g
const INLINE_CODE_PATTERN = /`[^`\n]+`/g

/**
 * Replaces code fences, inline code and URLs with placeholders.
 *
 * Fences are masked first (they may contain backticks), then inline code, then URLs.
 * Masking happens in a single left-to-right scan so the earliest construct wins.
 */
function mask(input: string): { text: string; entries: MaskEntry[] } {
	const entries: MaskEntry[] = []
	const ranges: { start: number; end: number; kind: MaskKind }[] = []

	const collect = (pattern: RegExp, kind: MaskKind) => {
		pattern.lastIndex = 0
		let match = pattern.exec(input)
		while (match) {
			const start = match.index
			const end = start + match[0].length
			const overlaps = ranges.some(r => start < r.end && end > r.start)
			if (!overlaps) ranges.push({ start, end, kind })
			match = pattern.exec(input)
		}
	}

	collect(FENCE_PATTERN, 'fence')
	collect(INLINE_CODE_PATTERN, 'inline')
	collect(URL_PATTERN, 'url')

	ranges.sort((a, b) => a.start - b.start)

	let text = ''
	let cursor = 0
	for (const range of ranges) {
		if (range.start < cursor) continue
		text += input.slice(cursor, range.start)
		const index = entries.length
		entries.push({ text: input.slice(range.start, range.end), kind: range.kind })
		text += `${MASK_OPEN}${index}${MASK_CLOSE}`
		cursor = range.end
	}
	text += input.slice(cursor)

	return { text, entries }
}

function unmask(text: string, entries: MaskEntry[]): string {
	return text.replace(MASK_PATTERN, (_match, index: string) => {
		const entry = entries[Number(index)]
		return entry ? entry.text : _match
	})
}

/** Returns the kind of the mask entry the string ends with, if any. */
function trailingMaskKind(text: string, entries: MaskEntry[]): MaskKind | undefined {
	const match = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}$`).exec(text)
	if (!match) return undefined
	return entries[Number(match[1])]?.kind
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Recorder = (change: CorrectionChange) => void

/** Applies a replacement dictionary as whole words, preserving the original casing. */
function replaceWords(
	text: string,
	dictionary: Record<string, string>,
	rule: string,
	record: Recorder,
): string {
	const keys = Object.keys(dictionary)
	if (!keys.length) return text

	const pattern = new RegExp(`\\b(?:${keys.map(escapeRegExp).join('|')})\\b`, 'gi')
	return text.replace(pattern, match => {
		const replacement = dictionary[match.toLowerCase()]
		if (!replacement) return match
		const cased = matchCase(match, replacement)
		if (cased === match) return match
		record({ rule, from: match, to: cased })
		return cased
	})
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mirrors the casing pattern of `source` onto `replacement`:
 * ALL CAPS -> ALL CAPS, Capitalized -> Capitalized, otherwise as written.
 */
function matchCase(source: string, replacement: string): string {
	const letters = source.replace(/[^A-Za-z]/g, '')
	if (letters.length > 1 && letters === letters.toUpperCase()) {
		return replacement.toUpperCase()
	}
	if (
		letters.length > 0 &&
		letters[0] === letters[0].toUpperCase() &&
		letters.slice(1) === letters.slice(1).toLowerCase()
	) {
		return replacement.charAt(0).toUpperCase() + replacement.slice(1)
	}
	return replacement
}

const LETTER = /[^\W\d_]/u

function isLetter(char: string | undefined): boolean {
	return char !== undefined && LETTER.test(char)
}

/** True for glyphs Discord users treat as "ends with an emoji". */
function isEmojiCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
		(codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) ||
		(codePoint >= 0x2600 && codePoint <= 0x27bf) ||
		(codePoint >= 0x2b00 && codePoint <= 0x2bff) ||
		(codePoint >= 0x2190 && codePoint <= 0x21ff) ||
		codePoint === 0xfe0f ||
		codePoint === 0x200d ||
		codePoint === 0x20e3 ||
		codePoint === 0x2122 ||
		codePoint === 0x2139
	)
}

function endsWithEmoji(text: string): boolean {
	// Iterate by code point so astral characters (most emoji) are not split into surrogates.
	const characters = Array.from(text)
	let index = characters.length - 1

	// Skip variation selectors, joiners and skin tone modifiers.
	while (index >= 0) {
		const codePoint = characters[index]!.codePointAt(0)
		if (codePoint === undefined) return false
		if (codePoint === 0xfe0f || codePoint === 0x200d) {
			index -= 1
			continue
		}
		if (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) {
			index -= 1
			continue
		}
		return isEmojiCodePoint(codePoint)
	}
	return false
}

/**
 * True when `before` ends with a dotted abbreviation, such as `e.g`, `i.e` or `u.s`,
 * so the trailing period must not be treated as a sentence break.
 */
function isDottedAbbreviation(before: string): boolean {
	return /(?:^|[^\w.])(?:[A-Za-z]\.)+[A-Za-z]$/.test(before)
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

/** 1. Whitespace. */
function ruleWhitespace(text: string, record: Recorder): string {
	let out = text

	out = out.replace(/[ \t]{2,}/g, match => {
		record({ rule: 'whitespace', from: match, to: ' ' })
		return ' '
	})

	out = out.replace(/[ \t]+$/gm, match => {
		record({ rule: 'whitespace', from: match, to: '' })
		return ''
	})

	out = out.replace(/\n{3,}/g, match => {
		record({ rule: 'whitespace', from: match, to: '\n\n' })
		return '\n\n'
	})

	out = out.replace(/^[ \t]+/, match => {
		record({ rule: 'whitespace', from: match, to: '' })
		return ''
	})

	return out
}

/** 2. Spacing around punctuation. */
function rulePunctuationSpacing(text: string, record: Recorder): string {
	let out = text

	// No space before `, . ! ? ; :`
	out = out.replace(/[ \t]+([,.!?;:])/g, (_match, punctuation: string) => {
		record({ rule: 'punctuation-spacing', from: _match, to: punctuation })
		return punctuation
	})

	// Exactly one space after `, ; :` when a letter follows.
	out = out.replace(/([,;:])(?=[^\W\d_])/gu, (match, punctuation: string, offset: number, source: string) => {
		const before = source[offset - 1]
		// `10:30`, `<#123>`, `http://` and emoticons are left alone because the lookahead
		// only fires on letters; nothing else needs guarding here.
		if (before === punctuation) return match
		record({ rule: 'punctuation-spacing', from: match, to: `${punctuation} ` })
		return `${punctuation} `
	})

	// One space after `! ?` when a letter follows.
	out = out.replace(/([!?])(?=[^\W\d_])/gu, (match, punctuation: string) => {
		record({ rule: 'punctuation-spacing', from: match, to: `${punctuation} ` })
		return `${punctuation} `
	})

	/*
	 * One space after `.` when a capital letter follows, unless it is an abbreviation or a
	 * decimal. A lowercase letter after a period is left alone on purpose: `discord.js`,
	 * `node.js` and `example.com` must not be split apart.
	 */
	out = out.replace(/(\.)(?=[A-Z])/g, (match, punctuation: string, offset: number, source: string) => {
		const before = source.slice(0, offset)
		const wordMatch = /([A-Za-z]+)$/.exec(before)
		const word = wordMatch?.[1]?.toLowerCase()
		if (word && ABBREVIATIONS.has(word)) return match

		if (isDottedAbbreviation(before)) return match

		const previous = before[before.length - 1]
		if (previous !== undefined && /\d/.test(previous)) return match
		if (previous === punctuation) return match

		record({ rule: 'punctuation-spacing', from: match, to: `${punctuation} ` })
		return `${punctuation} `
	})

	return out
}

/** 3. Ellipsis and dashes. */
function ruleEllipsisDashes(text: string, record: Recorder): string {
	let out = text

	out = out.replace(/\.{3,}/g, match => {
		record({ rule: 'ellipsis-dashes', from: match, to: '…' })
		return '…'
	})

	out = out.replace(/[ \t]+--[ \t]+/g, match => {
		record({ rule: 'ellipsis-dashes', from: match, to: ' — ' })
		return ' — '
	})

	out = out.replace(/(\S)--(\S)/g, (match, left: string, right: string) => {
		record({ rule: 'ellipsis-dashes', from: match, to: `${left}—${right}` })
		return `${left}—${right}`
	})

	return out
}

/** 4. Contractions. */
function ruleContractions(text: string, record: Recorder): string {
	return replaceWords(text, CONTRACTIONS, 'contractions', record)
}

/** 5. Common misspellings. */
function ruleMisspellings(
	text: string,
	record: Recorder,
	extra: Record<string, string> | undefined,
): string {
	const combined = extra && Object.keys(extra).length ? { ...MISSPELLINGS, ...extra } : MISSPELLINGS
	return replaceWords(text, combined, 'misspellings', record)
}

/** 6. Standalone `i` and `i'm` / `i've` / `i'll` / `i'd`. */
function ruleStandaloneI(text: string, record: Recorder): string {
	// `i.e.` and friends are not the pronoun.
	return text.replace(/\bi\b(?!\.[a-z])/g, match => {
		record({ rule: 'standalone-i', from: match, to: 'I' })
		return 'I'
	})
}

/** 7. Repeated words. */
function ruleRepeatedWords(text: string, record: Recorder): string {
	return text.replace(/\b([A-Za-z']+)([ \t]+)\1\b/gi, (match, word: string, space: string) => {
		record({ rule: 'repeated-words', from: match, to: word })
		return word
	})
}

/** 8. Sentence capitalization. */
function ruleSentenceCapitalization(text: string, record: Recorder): string {
	// Sentence starts: position 0, after a newline, or after `. ! ? …` plus whitespace.
	const boundaries: number[] = [0]
	const boundaryPattern = /\n|[.!?…][ \t]+/g
	let match = boundaryPattern.exec(text)
	while (match) {
		boundaries.push(match.index + match[0].length)
		match = boundaryPattern.exec(text)
	}

	const edits: { index: number; char: string }[] = []

	for (const boundary of boundaries) {
		// Abbreviation / number guards, for boundaries created by punctuation.
		if (boundary > 0) {
			const punctuationIndex = boundary - 1
			let wordEnd = punctuationIndex
			while (wordEnd > 0 && /[ \t]/.test(text[wordEnd - 1])) wordEnd -= 1
			const punctuation = text[wordEnd - 1]
			const before = text.slice(0, wordEnd - 1)
			const wordMatch = /([A-Za-z]+)$/.exec(before)
			const word = wordMatch?.[1]?.toLowerCase()
			const previous = before[before.length - 1]
			if (word && ABBREVIATIONS.has(word)) continue
			if (isDottedAbbreviation(before)) continue
			if (punctuation !== '…' && previous !== undefined && /\d/.test(previous)) continue
		}

		let index = boundary
		while (index < text.length && !isLetter(text[index])) {
			// Stop at the start of a masked span; the character after it is handled by the
			// next boundary pass at the latest, and masked content must never be edited.
			if (text[index] === MASK_OPEN || text[index] === MASK_CLOSE) break
			index += 1
		}

		if (index >= text.length) continue
		const char = text[index]
		if (!isLetter(char) || char === char.toUpperCase()) continue
		edits.push({ index, char: char.toUpperCase() })
	}

	if (!edits.length) return text

	let out = text
	for (let i = edits.length - 1; i >= 0; i--) {
		const edit = edits[i]!
		record({ rule: 'sentence-capitalization', from: out[edit.index] ?? '', to: edit.char })
		out = `${out.slice(0, edit.index)}${edit.char}${out.slice(edit.index + 1)}`
	}

	return out
}

/** 9. Terminal punctuation. */
function ruleTerminalPunctuation(
	text: string,
	record: Recorder,
	entries: MaskEntry[],
): string {
	const trimmed = text.replace(/[ \t]+$/, '')
	if (!trimmed) return text

	if (/[.!?…]$/.test(trimmed)) return text

	// Trailing code fence, inline code or URL: never append.
	const kind = trailingMaskKind(trimmed, entries)
	if (kind === 'fence' || kind === 'url' || kind === 'inline') return text

	const last = trimmed[trimmed.length - 1]!
	if (/["')\]}]/.test(last)) return text
	if (endsWithEmoji(trimmed)) return text

	// Single words are left alone; the rule only applies to sentences.
	const words = trimmed.split(/\s+/).filter(token => token.length > 0)
	if (words.length < 2) return text

	record({ rule: 'terminal-punctuation', from: last, to: `${last}.` })
	return `${trimmed}.`
}

/** 10. Double punctuation. */
function ruleDoublePunctuation(text: string, record: Recorder): string {
	let out = text

	out = out.replace(/!{2,}/g, match => {
		record({ rule: 'double-punctuation', from: match, to: '!' })
		return '!'
	})

	out = out.replace(/\?{2,}/g, match => {
		record({ rule: 'double-punctuation', from: match, to: '?' })
		return '?'
	})

	// Runs of three or more were already collapsed by rule 3; this handles exactly two.
	out = out.replace(/\.\./g, match => {
		record({ rule: 'double-punctuation', from: match, to: '…' })
		return '…'
	})

	return out
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                   */
/* -------------------------------------------------------------------------- */

function runPipeline(
	text: string,
	options: CorrectorOptions,
	record: Recorder,
	entries: MaskEntry[],
): string {
	const skip = new Set(options.skip ?? [])
	let out = text

	if (!skip.has('whitespace')) out = ruleWhitespace(out, record)
	if (!skip.has('punctuation-spacing')) out = rulePunctuationSpacing(out, record)
	if (!skip.has('ellipsis-dashes')) out = ruleEllipsisDashes(out, record)
	if (!skip.has('contractions')) out = ruleContractions(out, record)
	if (!skip.has('misspellings')) out = ruleMisspellings(out, record, options.dictionary)
	if (!skip.has('standalone-i')) out = ruleStandaloneI(out, record)
	if (!skip.has('repeated-words')) out = ruleRepeatedWords(out, record)
	if (!skip.has('sentence-capitalization')) out = ruleSentenceCapitalization(out, record)
	if (!skip.has('terminal-punctuation')) out = ruleTerminalPunctuation(out, record, entries)
	if (!skip.has('double-punctuation')) out = ruleDoublePunctuation(out, record)

	return out
}

/**
 * Corrects `input`.
 *
 * Deterministic, offline and idempotent. The pipeline is repeated until stable so the
 * result never needs a second call.
 */
export function correct(input: string, options: CorrectorOptions = DEFAULT_OPTIONS): CorrectionResult {
	const original = typeof input === 'string' ? input : String(input ?? '')

	if (!original.trim()) return { original, corrected: original, changes: [] }

	const { text: masked, entries } = mask(original)

	let current = masked
	const changes: CorrectionChange[] = []

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const before = current
		const passChanges: CorrectionChange[] = []

		current = runPipeline(current, options, change => passChanges.push(change), entries)

		changes.push(...passChanges)
		if (current === before) break
	}

	const corrected = unmask(current, entries)
	const deduped = changes.map(change => ({
		rule: change.rule,
		from: unmask(change.from, entries),
		to: unmask(change.to, entries),
	}))

	if (corrected === original) return { original, corrected, changes: [] }

	return { original, corrected, changes: deduped }
}

/** Convenience wrapper for callers that only need the text. */
export function correctText(input: string, options?: CorrectorOptions): string {
	return correct(input, options).corrected
}
