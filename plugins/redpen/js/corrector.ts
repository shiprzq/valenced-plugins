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
export const CORRECTOR_VERSION = '2.0.0'

export type RuleId =
	| 'whitespace'
	| 'punctuation-spacing'
	| 'ellipsis-dashes'
	| 'contractions'
	| 'misspellings'
	| 'phrases'
	| 'agreement'
	| 'articles'
	| 'standalone-i'
	| 'repeated-words'
	| 'sentence-capitalization'
	| 'terminal-punctuation'
	| 'double-punctuation'

/** Human-readable names for every rule group, in pipeline order. */
export const RULE_LABELS: { id: RuleId; label: string; description: string }[] = [
	{ id: 'misspellings', label: 'Spelling', description: 'Common misspellings, e.g. “definately” → “definitely”.' },
	{ id: 'contractions', label: 'Contractions', description: 'Missing apostrophes, e.g. “dont” → “don’t”.' },
	{ id: 'phrases', label: 'Wordy phrases', description: '“in order to” → “to”, “could of” → “could have”.' },
	{ id: 'agreement', label: 'Grammar agreement', description: '“he don’t” → “he doesn’t”, “they was” → “they were”.' },
	{ id: 'articles', label: 'a / an', description: '“a apple” → “an apple”.' },
	{ id: 'standalone-i', label: 'Pronoun “I”', description: '“i think im late” → “I think I’m late”.' },
	{ id: 'repeated-words', label: 'Repeated words', description: '“the the” → “the”.' },
	{ id: 'punctuation-spacing', label: 'Punctuation spacing', description: '“hello ,world” → “hello, world”.' },
	{ id: 'ellipsis-dashes', label: 'Ellipses and dashes', description: 'Normalises “...” and “--”.' },
	{ id: 'whitespace', label: 'Whitespace', description: 'Double spaces, trailing spaces, blank-line runs.' },
	{ id: 'sentence-capitalization', label: 'Sentence case', description: 'Capitalises the first letter of each sentence.' },
	{ id: 'terminal-punctuation', label: 'Final punctuation', description: 'Adds a period to a message with none.' },
	{ id: 'double-punctuation', label: 'Double punctuation', description: '“!!” → “!”, “?.” → “?”.' },
]

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

/** Missing apostrophes and contracted pronouns. Keys are lowercased and matched as whole words, case-insensitively.
 *
 * `its`, `lets` and `ill` are deliberately absent: each is a real word, so guessing the
 * contraction would corrupt ordinary sentences. */
const CONTRACTIONS: Record<string, string> = {
	aint: 'ain\'t',
	arent: 'aren\'t',
	cant: 'can\'t',
	couldnt: 'couldn\'t',
	couldve: 'could\'ve',
	didnt: 'didn\'t',
	doesnt: 'doesn\'t',
	dont: 'don\'t',
	hadnt: 'hadn\'t',
	hasnt: 'hasn\'t',
	havent: 'haven\'t',
	hed: 'he\'d',
	heres: 'here\'s',
	hes: 'he\'s',
	hows: 'how\'s',
	im: 'I\'m',
	isnt: 'isn\'t',
	itd: 'it\'d',
	itll: 'it\'ll',
	ive: 'I\'ve',
	mightve: 'might\'ve',
	mustnt: 'mustn\'t',
	mustve: 'must\'ve',
	neednt: 'needn\'t',
	shes: 'she\'s',
	shouldnt: 'shouldn\'t',
	shouldve: 'should\'ve',
	thats: 'that\'s',
	theres: 'there\'s',
	theyd: 'they\'d',
	theyll: 'they\'ll',
	theyre: 'they\'re',
	theyve: 'they\'ve',
	wasnt: 'wasn\'t',
	werent: 'weren\'t',
	weve: 'we\'ve',
	whats: 'what\'s',
	whens: 'when\'s',
	wheres: 'where\'s',
	whod: 'who\'d',
	wholl: 'who\'ll',
	whos: 'who\'s',
	wont: 'won\'t',
	wouldnt: 'wouldn\'t',
	wouldve: 'would\'ve',
	youd: 'you\'d',
	youll: 'you\'ll',
	youre: 'you\'re',
	youve: 'you\'ve',
}

/** Fixed dictionary of common misspellings. Whole words only, casing preserved. */
const MISSPELLINGS: Record<string, string> = {
	abanden: 'abandon',
	abscence: 'absence',
	absolutly: 'absolutely',
	absorbsion: 'absorption',
	accellerate: 'accelerate',
	acceptible: 'acceptable',
	accessable: 'accessible',
	accidentaly: 'accidentally',
	accomodate: 'accommodate',
	accomodation: 'accommodation',
	accompanyed: 'accompanied',
	accross: 'across',
	acheive: 'achieve',
	acheiving: 'achieving',
	acknowlege: 'acknowledge',
	acomplish: 'accomplish',
	addresed: 'addressed',
	adecuate: 'adequate',
	adminstrator: 'administrator',
	adress: 'address',
	advantagous: 'advantageous',
	adventrous: 'adventurous',
	adviced: 'advised',
	afficionado: 'aficionado',
	afordable: 'affordable',
	agreemnet: 'agreement',
	agression: 'aggression',
	agressive: 'aggressive',
	algorithim: 'algorithm',
	allmost: 'almost',
	allright: 'all right',
	allways: 'always',
	alot: 'a lot',
	alternitive: 'alternative',
	amature: 'amateur',
	ambigious: 'ambiguous',
	ammount: 'amount',
	amoung: 'among',
	analize: 'analyze',
	annoint: 'anoint',
	anouncement: 'announcement',
	anoying: 'annoying',
	antartic: 'antarctic',
	anually: 'annually',
	anyways: 'anyway',
	aparently: 'apparently',
	aplication: 'application',
	apologise: 'apologize',
	apparant: 'apparent',
	apparantly: 'apparently',
	appearence: 'appearance',
	apreciate: 'appreciate',
	apropriate: 'appropriate',
	aproximate: 'approximate',
	aquaintance: 'acquaintance',
	aquire: 'acquire',
	arbitary: 'arbitrary',
	architechture: 'architecture',
	argubly: 'arguably',
	arguement: 'argument',
	arguements: 'arguments',
	arival: 'arrival',
	artical: 'article',
	asetic: 'ascetic',
	asign: 'assign',
	asociated: 'associated',
	assasination: 'assassination',
	assistent: 'assistant',
	assitance: 'assistance',
	asterick: 'asterisk',
	athelete: 'athlete',
	athiest: 'atheist',
	attatched: 'attached',
	attendence: 'attendance',
	attension: 'attention',
	authorative: 'authoritative',
	automaticly: 'automatically',
	auxillary: 'auxiliary',
	availabe: 'available',
	availible: 'available',
	backround: 'background',
	basicly: 'basically',
	becasue: 'because',
	becuase: 'because',
	befor: 'before',
	begginer: 'beginner',
	begining: 'beginning',
	beleive: 'believe',
	beleived: 'believed',
	beleives: 'believes',
	belive: 'believe',
	benificial: 'beneficial',
	benifit: 'benefit',
	betwen: 'between',
	beutiful: 'beautiful',
	bizzare: 'bizarre',
	bouyant: 'buoyant',
	brillant: 'brilliant',
	brocolli: 'broccoli',
	bueatiful: 'beautiful',
	buisness: 'business',
	burocracy: 'bureaucracy',
	burried: 'buried',
	busness: 'business',
	calender: 'calendar',
	calulator: 'calculator',
	camoflage: 'camouflage',
	capible: 'capable',
	carefull: 'careful',
	catagory: 'category',
	cauhgt: 'caught',
	ceasar: 'caesar',
	celcius: 'celsius',
	cemetary: 'cemetery',
	certian: 'certain',
	challange: 'challenge',
	challanging: 'challenging',
	chancelor: 'chancellor',
	changable: 'changeable',
	charachter: 'character',
	chauffer: 'chauffeur',
	cheif: 'chief',
	childs: 'children',
	chosing: 'choosing',
	cirriculum: 'curriculum',
	citezen: 'citizen',
	clasic: 'classic',
	clearely: 'clearly',
	collegue: 'colleague',
	collosal: 'colossal',
	comanding: 'commanding',
	combind: 'combined',
	comitment: 'commitment',
	comming: 'coming',
	commited: 'committed',
	commitee: 'committee',
	commiting: 'committing',
	comparision: 'comparison',
	compatable: 'compatible',
	compitent: 'competent',
	completly: 'completely',
	componant: 'component',
	comprimise: 'compromise',
	comradery: 'camaraderie',
	conceed: 'concede',
	concensus: 'consensus',
	concious: 'conscious',
	condradict: 'contradict',
	conected: 'connected',
	conection: 'connection',
	confidance: 'confidence',
	confortable: 'comfortable',
	congradulate: 'congratulate',
	congradulations: 'congratulations',
	conistently: 'consistently',
	conquerer: 'conqueror',
	consciencious: 'conscientious',
	consequnce: 'consequence',
	conservitive: 'conservative',
	consistant: 'consistent',
	constuction: 'construction',
	consulant: 'consultant',
	contemperary: 'contemporary',
	contiously: 'continuously',
	contravercial: 'controversial',
	contributer: 'contributor',
	contries: 'countries',
	controled: 'controlled',
	controll: 'control',
	conveniant: 'convenient',
	conversate: 'converse',
	conveyer: 'conveyor',
	convienient: 'convenient',
	cooridnate: 'coordinate',
	corespond: 'correspond',
	corrispond: 'correspond',
	corupt: 'corrupt',
	couldnt: 'couldn\'t',
	councellor: 'counselor',
	crany: 'cranky',
	creater: 'creator',
	critisism: 'criticism',
	critisize: 'criticize',
	critizise: 'criticize',
	crucialy: 'crucially',
	curios: 'curious',
	curiousity: 'curiosity',
	currenly: 'currently',
	custumize: 'customize',
	dalmation: 'dalmatian',
	decaffinated: 'decaffeinated',
	decieve: 'deceive',
	decison: 'decision',
	decisons: 'decisions',
	decomission: 'decommission',
	defanitely: 'definitely',
	defencive: 'defensive',
	deffensive: 'defensive',
	definate: 'definite',
	definately: 'definitely',
	definatly: 'definitely',
	definitly: 'definitely',
	dejavu: 'deja vu',
	delightfull: 'delightful',
	dependance: 'dependence',
	dependant: 'dependent',
	depricated: 'deprecated',
	derivitive: 'derivative',
	descision: 'decision',
	descripton: 'description',
	desicion: 'decision',
	desireable: 'desirable',
	desparate: 'desperate',
	desperatly: 'desperately',
	destory: 'destroy',
	developement: 'development',
	developper: 'developer',
	diferent: 'different',
	diffrence: 'difference',
	diffrent: 'different',
	dilemna: 'dilemma',
	dilligence: 'diligence',
	dimention: 'dimension',
	diper: 'diaper',
	diptheria: 'diphtheria',
	disapoint: 'disappoint',
	dissagreement: 'disagreement',
	dissapear: 'disappear',
	dissapoint: 'disappoint',
	dissappear: 'disappear',
	dissappointed: 'disappointed',
	distingish: 'distinguish',
	distorsion: 'distortion',
	distrubution: 'distribution',
	documnet: 'document',
	doesnt: 'doesn\'t',
	dominent: 'dominant',
	dramaticly: 'dramatically',
	dumbell: 'dumbbell',
	eaiser: 'easier',
	ealier: 'earlier',
	effeciency: 'efficiency',
	efficent: 'efficient',
	elegable: 'eligible',
	elemant: 'element',
	eligable: 'eligible',
	elimintate: 'eliminate',
	embarass: 'embarrass',
	embarassed: 'embarrassed',
	embarassing: 'embarrassing',
	emergance: 'emergence',
	eminate: 'emanate',
	emmediately: 'immediately',
	emmision: 'emission',
	emory: 'memory',
	encription: 'encryption',
	encyclopeadia: 'encyclopedia',
	enought: 'enough',
	enterance: 'entrance',
	enthusiam: 'enthusiasm',
	entrepeneur: 'entrepreneur',
	enviroment: 'environment',
	equiped: 'equipped',
	equiptment: 'equipment',
	equivlent: 'equivalent',
	especialy: 'especially',
	essencial: 'essential',
	estabish: 'establish',
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
	exlcude: 'exclude',
	exlpain: 'explain',
	expalin: 'explain',
	expence: 'expense',
	experiance: 'experience',
	expierence: 'experience',
	explaination: 'explanation',
	expresso: 'espresso',
	extemely: 'extremely',
	extreem: 'extreme',
	facinating: 'fascinating',
	familar: 'familiar',
	familliar: 'familiar',
	febuary: 'february',
	feild: 'field',
	fierly: 'fiercely',
	finaly: 'finally',
	firey: 'fiery',
	flamable: 'flammable',
	florescent: 'fluorescent',
	flourescent: 'fluorescent',
	forcast: 'forecast',
	forgien: 'foreign',
	foriegn: 'foreign',
	formaly: 'formally',
	forteen: 'fourteen',
	fortunatly: 'fortunately',
	forunner: 'forerunner',
	fourty: 'forty',
	foward: 'forward',
	freind: 'friend',
	freindly: 'friendly',
	fucntion: 'function',
	fufill: 'fulfill',
	fulfilment: 'fulfillment',
	funcion: 'function',
	furthur: 'further',
	futher: 'further',
	ganna: 'gonna',
	garantee: 'guarantee',
	garanteed: 'guaranteed',
	gaurd: 'guard',
	generaly: 'generally',
	genious: 'genius',
	german: 'German',
	glamourous: 'glamorous',
	goign: 'going',
	gorgous: 'gorgeous',
	govenment: 'government',
	goverment: 'government',
	grammer: 'grammar',
	gratefull: 'grateful',
	greatful: 'grateful',
	grovelling: 'groveling',
	gruop: 'group',
	guarentee: 'guarantee',
	guidence: 'guidance',
	guidlines: 'guidelines',
	habbit: 'habit',
	happend: 'happened',
	harrass: 'harass',
	harrassment: 'harassment',
	havent: 'haven\'t',
	headquaters: 'headquarters',
	heaviliy: 'heavily',
	heigth: 'height',
	heirarchy: 'hierarchy',
	hemorrage: 'hemorrhage',
	hesistant: 'hesitant',
	hieght: 'height',
	hierachy: 'hierarchy',
	higene: 'hygiene',
	hight: 'height',
	hipopotamus: 'hippopotamus',
	hospitible: 'hospital',
	humerous: 'humorous',
	humourous: 'humorous',
	hygeine: 'hygiene',
	hypocracy: 'hypocrisy',
	hystory: 'history',
	idiosyncracy: 'idiosyncrasy',
	ignorence: 'ignorance',
	illeagal: 'illegal',
	illegitamate: 'illegitimate',
	imaginery: 'imaginary',
	imediately: 'immediately',
	immediatley: 'immediately',
	immediatly: 'immediately',
	immitate: 'imitate',
	impement: 'implement',
	importence: 'importance',
	impresive: 'impressive',
	imprioned: 'imprisoned',
	improvision: 'improvisation',
	inaccessable: 'inaccessible',
	inadvertant: 'inadvertent',
	inbalance: 'imbalance',
	inbetween: 'in between',
	incidently: 'incidentally',
	incompatable: 'incompatible',
	inconsistant: 'inconsistent',
	inconvienience: 'inconvenience',
	inconvinience: 'inconvenience',
	incorect: 'incorrect',
	indefinately: 'indefinitely',
	independant: 'independent',
	independantly: 'independently',
	indespensable: 'indispensable',
	indispensible: 'indispensable',
	indite: 'indict',
	inevitible: 'inevitable',
	infact: 'in fact',
	influance: 'influence',
	influencial: 'influential',
	ingreedient: 'ingredient',
	inital: 'initial',
	initally: 'initially',
	inmmediately: 'immediately',
	innoculate: 'inoculate',
	inorder: 'in order',
	inpired: 'inspired',
	insistance: 'insistence',
	insistant: 'insistent',
	inspite: 'in spite',
	instade: 'instead',
	insted: 'instead',
	intelegence: 'intelligence',
	inteligent: 'intelligent',
	intentionly: 'intentionally',
	interchangable: 'interchangeable',
	intergrate: 'integrate',
	intermident: 'intermittent',
	interogate: 'interrogate',
	interupt: 'interrupt',
	interuption: 'interruption',
	intrest: 'interest',
	intresting: 'interesting',
	introducion: 'introduction',
	intrument: 'instrument',
	invarient: 'invariant',
	inviteing: 'inviting',
	iritate: 'irritate',
	irregardless: 'regardless',
	irrelevent: 'irrelevant',
	irreplacable: 'irreplaceable',
	irresistable: 'irresistible',
	issueing: 'issuing',
	january: 'January',
	jeapardy: 'jeopardy',
	jist: 'gist',
	jorney: 'journey',
	knowledgable: 'knowledgeable',
	knowlege: 'knowledge',
	labratory: 'laboratory',
	laision: 'liaison',
	langauge: 'language',
	largst: 'largest',
	lastest: 'latest',
	leasure: 'leisure',
	legitmate: 'legitimate',
	liason: 'liaison',
	libary: 'library',
	libitarian: 'libertarian',
	liesure: 'leisure',
	likelyhood: 'likelihood',
	liqour: 'liquor',
	lisence: 'license',
	litature: 'literature',
	litterally: 'literally',
	livlihood: 'livelihood',
	loged: 'logged',
	lonelyness: 'loneliness',
	lonley: 'lonely',
	loosing: 'losing',
	loseing: 'losing',
	magasine: 'magazine',
	maintainance: 'maintenance',
	maintainence: 'maintenance',
	maintenence: 'maintenance',
	managable: 'manageable',
	managment: 'management',
	mandantory: 'mandatory',
	maneuvre: 'maneuver',
	manisfest: 'manifest',
	manuever: 'maneuver',
	marraige: 'marriage',
	massachussetts: 'Massachusetts',
	matteress: 'mattress',
	meantion: 'mention',
	medeval: 'medieval',
	mediterainian: 'Mediterranean',
	merchendise: 'merchandise',
	millenium: 'millennium',
	minature: 'miniature',
	miniscule: 'minuscule',
	minumum: 'minimum',
	mischevious: 'mischievous',
	mischievious: 'mischievous',
	mispell: 'misspell',
	mispelled: 'misspelled',
	mispelling: 'misspelling',
	missin: 'missing',
	missinterpret: 'misinterpret',
	misterious: 'mysterious',
	mistery: 'mystery',
	moble: 'mobile',
	molitov: 'molotov',
	moniter: 'monitor',
	morgage: 'mortgage',
	mucuous: 'mucous',
	munciple: 'municipal',
	mysterius: 'mysterious',
	narcisist: 'narcissist',
	naseuos: 'nauseous',
	naturaly: 'naturally',
	neccesary: 'necessary',
	neccessarily: 'necessarily',
	neccessary: 'necessary',
	neccessity: 'necessity',
	necesary: 'necessary',
	neice: 'niece',
	neigbor: 'neighbor',
	neigbour: 'neighbor',
	neigbourhood: 'neighborhood',
	neucleus: 'nucleus',
	neverthless: 'nevertheless',
	nieghbor: 'neighbor',
	nieghbour: 'neighbour',
	nineth: 'ninth',
	ninty: 'ninety',
	noone: 'no one',
	noticable: 'noticeable',
	noticably: 'noticeably',
	nowdays: 'nowadays',
	nucular: 'nuclear',
	nusance: 'nuisance',
	obediance: 'obedience',
	obediant: 'obedient',
	obssesed: 'obsessed',
	obssession: 'obsession',
	ocasion: 'occasion',
	occassion: 'occasion',
	occassionally: 'occasionally',
	occationally: 'occasionally',
	occurance: 'occurrence',
	occured: 'occurred',
	occurence: 'occurrence',
	occuring: 'occurring',
	ocurred: 'occurred',
	offical: 'official',
	offically: 'officially',
	oftenly: 'often',
	omited: 'omitted',
	ommision: 'omission',
	ommission: 'omission',
	ommitted: 'omitted',
	onate: 'ornate',
	openning: 'opening',
	oposite: 'opposite',
	opperation: 'operation',
	oppinion: 'opinion',
	opponant: 'opponent',
	oppurtunity: 'opportunity',
	opression: 'oppression',
	optomism: 'optimism',
	optomize: 'optimize',
	orginal: 'original',
	origional: 'original',
	orthadox: 'orthodox',
	outragous: 'outrageous',
	overacheiver: 'overachiever',
	overal: 'overall',
	overide: 'override',
	overwelming: 'overwhelming',
	paided: 'paid',
	paniced: 'panicked',
	paralel: 'parallel',
	paralell: 'parallel',
	parralel: 'parallel',
	particularily: 'particularly',
	particulary: 'particularly',
	pasttime: 'pastime',
	patiance: 'patience',
	payed: 'paid',
	peageant: 'pageant',
	peculier: 'peculiar',
	peculure: 'peculiar',
	pefect: 'perfect',
	peice: 'piece',
	peices: 'pieces',
	peom: 'poem',
	pepole: 'people',
	percieve: 'perceive',
	percisely: 'precisely',
	perculiar: 'peculiar',
	perdicament: 'predicament',
	perenial: 'perennial',
	perfomance: 'performance',
	perhapse: 'perhaps',
	permanant: 'permanent',
	permenant: 'permanent',
	permissable: 'permissible',
	perpindicular: 'perpendicular',
	persain: 'pursuing',
	persaude: 'persuade',
	perseverence: 'perseverance',
	persistant: 'persistent',
	personel: 'personnel',
	persue: 'pursue',
	phenominon: 'phenomenon',
	phenomonon: 'phenomenon',
	phenonmenon: 'phenomenon',
	philosphy: 'philosophy',
	phonen: 'phone',
	picknic: 'picnic',
	plagerize: 'plagiarize',
	playright: 'playwright',
	pleasent: 'pleasant',
	poeple: 'people',
	polination: 'pollination',
	politican: 'politician',
	posess: 'possess',
	posession: 'possession',
	posessive: 'possessive',
	possesion: 'possession',
	possibilty: 'possibility',
	potatoe: 'potato',
	potatos: 'potatoes',
	potentional: 'potential',
	practicioner: 'practitioner',
	practicle: 'practical',
	prarie: 'prairie',
	precedance: 'precedence',
	preceed: 'precede',
	preceeding: 'preceding',
	precurser: 'precursor',
	prefered: 'preferred',
	prefering: 'preferring',
	preform: 'perform',
	pregancy: 'pregnancy',
	prepair: 'prepare',
	preperation: 'preparation',
	presance: 'presence',
	presedent: 'president',
	presense: 'presence',
	prestigous: 'prestigious',
	presumibly: 'presumably',
	prevelant: 'prevalent',
	primative: 'primitive',
	privaledge: 'privilege',
	privelege: 'privilege',
	priviledge: 'privilege',
	probablity: 'probability',
	probally: 'probably',
	probaly: 'probably',
	probelm: 'problem',
	procede: 'proceed',
	professer: 'professor',
	proffesional: 'professional',
	profiency: 'proficiency',
	prominant: 'prominent',
	promiss: 'promise',
	pronounciation: 'pronunciation',
	propably: 'probably',
	propietor: 'proprietor',
	propoganda: 'propaganda',
	protien: 'protein',
	publically: 'publicly',
	pumkin: 'pumpkin',
	pursuation: 'persuasion',
	quaranteen: 'quarantine',
	quater: 'quarter',
	quesion: 'question',
	questionaire: 'questionnaire',
	quik: 'quick',
	quikly: 'quickly',
	quizes: 'quizzes',
	realy: 'really',
	reccomend: 'recommend',
	reccommend: 'recommend',
	reccuring: 'recurring',
	receieve: 'receive',
	recepient: 'recipient',
	reciept: 'receipt',
	reciet: 'receipt',
	recieve: 'receive',
	recieved: 'received',
	recieving: 'receiving',
	recognizeable: 'recognizable',
	recomend: 'recommend',
	recomendation: 'recommendation',
	reconize: 'recognize',
	recuring: 'recurring',
	referance: 'reference',
	refered: 'referred',
	refering: 'referring',
	refrence: 'reference',
	reguardless: 'regardless',
	reherse: 'rehearse',
	relevent: 'relevant',
	religeon: 'religion',
	religous: 'religious',
	relize: 'realize',
	remeber: 'remember',
	rememberance: 'remembrance',
	reminescent: 'reminiscent',
	reminice: 'reminisce',
	remodled: 'remodeled',
	repitition: 'repetition',
	replaceing: 'replacing',
	representive: 'representative',
	requred: 'required',
	resistent: 'resistant',
	resouce: 'resource',
	respectfull: 'respectful',
	responsable: 'responsible',
	restaraunt: 'restaurant',
	resturant: 'restaurant',
	retreive: 'retrieve',
	rhythym: 'rhythm',
	ridiculos: 'ridiculous',
	ridiculus: 'ridiculous',
	rythm: 'rhythm',
	rythym: 'rhythm',
	sacrafice: 'sacrifice',
	sacreligious: 'sacrilegious',
	sacrifise: 'sacrifice',
	saftey: 'safety',
	safty: 'safety',
	salery: 'salary',
	satalite: 'satellite',
	saterday: 'Saturday',
	sattelite: 'satellite',
	scedual: 'schedule',
	scedule: 'schedule',
	scenerio: 'scenario',
	schedual: 'schedule',
	seargant: 'sergeant',
	seccond: 'second',
	secratary: 'secretary',
	seige: 'siege',
	seperate: 'separate',
	seperated: 'separated',
	seperately: 'separately',
	sergent: 'sergeant',
	serios: 'serious',
	seventeeth: 'seventieth',
	severly: 'severely',
	shcool: 'school',
	shedual: 'schedule',
	sheild: 'shield',
	shure: 'sure',
	sience: 'science',
	sieze: 'seize',
	significent: 'significant',
	signifigant: 'significant',
	similer: 'similar',
	similiar: 'similar',
	simular: 'similar',
	sincerelly: 'sincerely',
	sincerly: 'sincerely',
	situtation: 'situation',
	skilfull: 'skillful',
	slighly: 'slightly',
	soem: 'some',
	soliders: 'soldiers',
	somthing: 'something',
	sophmore: 'sophomore',
	sorrounding: 'surrounding',
	speach: 'speech',
	specail: 'special',
	specfic: 'specific',
	spectular: 'spectacular',
	speical: 'special',
	sponser: 'sponsor',
	spontanious: 'spontaneous',
	sqaure: 'square',
	stabel: 'stable',
	stange: 'strange',
	startegic: 'strategic',
	stategy: 'strategy',
	statment: 'statement',
	steddily: 'steadily',
	steped: 'stepped',
	steriod: 'steroid',
	stomache: 'stomach',
	stoped: 'stopped',
	stoping: 'stopping',
	straigt: 'straight',
	strenght: 'strength',
	strenghten: 'strengthen',
	stubborness: 'stubbornness',
	subconsceince: 'subconscious',
	subpoenae: 'subpoena',
	succede: 'succeed',
	succesful: 'successful',
	succesfully: 'successfully',
	sucess: 'success',
	sucessful: 'successful',
	sufficent: 'sufficient',
	sufficently: 'sufficiently',
	suficcient: 'sufficient',
	sumary: 'summary',
	supercede: 'supersede',
	superintendant: 'superintendent',
	supprise: 'surprise',
	supress: 'suppress',
	suprise: 'surprise',
	suprised: 'surprised',
	suprisingly: 'surprisingly',
	suprize: 'surprise',
	surpise: 'surprise',
	surpised: 'surprised',
	surprize: 'surprise',
	suspicios: 'suspicious',
	suspision: 'suspicion',
	swich: 'switch',
	sycronize: 'synchronize',
	symetrical: 'symmetrical',
	syncronize: 'synchronize',
	systam: 'system',
	tatoo: 'tattoo',
	tecnical: 'technical',
	tecnology: 'technology',
	teh: 'the',
	temperture: 'temperature',
	temprature: 'temperature',
	tempreture: 'temperature',
	tendancy: 'tendency',
	theorectical: 'theoretical',
	therefor: 'therefore',
	therfore: 'therefore',
	thier: 'their',
	thourough: 'thorough',
	threatning: 'threatening',
	threshhold: 'threshold',
	throught: 'through',
	througout: 'throughout',
	tikle: 'tickle',
	tobbaco: 'tobacco',
	tolerence: 'tolerance',
	tommorow: 'tomorrow',
	tommorrow: 'tomorrow',
	tomorow: 'tomorrow',
	totaly: 'totally',
	tounge: 'tongue',
	tournement: 'tournament',
	towords: 'towards',
	tradgedy: 'tragedy',
	tradgic: 'tragic',
	tranfered: 'transferred',
	transcendance: 'transcendence',
	transfered: 'transferred',
	translater: 'translator',
	tremelos: 'tremulous',
	truely: 'truly',
	truley: 'truly',
	tuesday: 'Tuesday',
	tunnell: 'tunnel',
	turkish: 'Turkish',
	twelth: 'twelfth',
	tyrany: 'tyranny',
	unaminous: 'unanimous',
	unathorized: 'unauthorized',
	uncertainity: 'uncertainty',
	uncomforable: 'uncomfortable',
	unconcious: 'unconscious',
	unconsious: 'unconscious',
	undoubtably: 'undoubtedly',
	unecessarily: 'unnecessarily',
	unecessary: 'unnecessary',
	unforseen: 'unforeseen',
	unfortunantly: 'unfortunately',
	unfortunatley: 'unfortunately',
	unfortunatly: 'unfortunately',
	unfortunetly: 'unfortunately',
	unihabited: 'uninhabited',
	uniquley: 'uniquely',
	unlce: 'uncle',
	unmanagable: 'unmanageable',
	unmistakeable: 'unmistakable',
	unneccessary: 'unnecessary',
	unnecesary: 'unnecessary',
	unnesessary: 'unnecessary',
	unprecendented: 'unprecedented',
	unsubstanciated: 'unsubstantiated',
	untill: 'until',
	untimeley: 'untimely',
	unuseable: 'unusable',
	unusuable: 'unusable',
	unwieldly: 'unwieldy',
	upcomming: 'upcoming',
	upsidedown: 'upside down',
	usally: 'usually',
	useable: 'usable',
	usefull: 'useful',
	usefullness: 'usefulness',
	usualy: 'usually',
	vaccum: 'vacuum',
	vaccuum: 'vacuum',
	vacum: 'vacuum',
	vacume: 'vacuum',
	valuble: 'valuable',
	vandelism: 'vandalism',
	vegatable: 'vegetable',
	vegitarian: 'vegetarian',
	vehical: 'vehicle',
	verisons: 'versions',
	vigilence: 'vigilance',
	vigourous: 'vigorous',
	visable: 'visible',
	visably: 'visibly',
	vistor: 'visitor',
	volumne: 'volume',
	vunerable: 'vulnerable',
	warrent: 'warrant',
	wasnt: 'wasn\'t',
	wastefull: 'wasteful',
	watn: 'want',
	weakenss: 'weakness',
	weath: 'wealth',
	wednesday: 'Wednesday',
	weild: 'wield',
	wether: 'whether',
	whcih: 'which',
	whereever: 'wherever',
	whic: 'which',
	wich: 'which',
	wierd: 'weird',
	wierdly: 'weirdly',
	wih: 'with',
	willem: 'will',
	withdrawl: 'withdrawal',
	withold: 'withhold',
	wittness: 'witness',
	wonderfull: 'wonderful',
	wont: 'won\'t',
	worht: 'worth',
	woudl: 'would',
	wouldnt: 'wouldn\'t',
	writen: 'written',
	writting: 'writing',
	yatch: 'yacht',
	yeild: 'yield',
	youre: 'you\'re',
	yuor: 'your',
}

/** Words that end in a period without ending a sentence. Used by rules 2 and 8. */
/**
 * `MISSPELLINGS` plus the regular plural of every single-word entry, so “freinds” is caught
 * as well as “freind”. Plurals are only derived when both sides are plain words: “alot”
 * (→ “a lot”) is skipped because its correction is not one word.
 */
const SPELLING_MAP: Record<string, string> = (() => {
	const map: Record<string, string> = { ...MISSPELLINGS }
	for (const [wrong, right] of Object.entries(MISSPELLINGS)) {
		if (!/^[a-z]+[^s]$/.test(wrong)) continue
		if (!/^[a-z]+$/.test(right)) continue
		map[`${wrong}s`] ??= `${right}s`
	}
	return map
})()

/**
 * Wordy phrases and misheard idioms, replaced with their standard form.
 *
 * Multi-word keys are matched with flexible whitespace, as whole words, case-insensitively.
 */
const PHRASES: Record<string, string> = {
	'a large number of': 'many',
	'a majority of': 'most',
	'a small number of': 'a few',
	'a sufficient amount of': 'enough',
	'absolutely essential': 'essential',
	'add an additional': 'add',
	'advance planning': 'planning',
	'and also': 'also',
	'are able to': 'can',
	'as a result of': 'because of',
	'at the present time': 'now',
	'at this point in time': 'now',
	'attach together': 'attach',
	'baited breath': 'bated breath',
	'blend together': 'blend',
	'bold faced': 'bald-faced',
	'brief summary': 'summary',
	'by means of': 'with',
	'case and point': 'case in point',
	'chock it up': 'chalk it up',
	'close proximity': 'proximity',
	'collaborate together': 'collaborate',
	'combine together': 'combine',
	'come to the conclusion': 'conclude',
	'completely eliminate': 'eliminate',
	'consensus of opinion': 'consensus',
	'cooperate together': 'cooperate',
	'could care less': 'couldn\'t care less',
	'could of': 'could have',
	'day in age': 'day and age',
	'deep seeded': 'deep-seated',
	'difficult dilemma': 'dilemma',
	'due to the fact that': 'because',
	'each and every': 'every',
	'each individual': 'each',
	'eliminate entirely': 'eliminate',
	'end result': 'result',
	'escape goat': 'scapegoat',
	'exactly identical': 'identical',
	'few in number': 'few',
	'final outcome': 'outcome',
	'first and foremost': 'first',
	'for all intensive purposes': 'for all intents and purposes',
	'for the purpose of': 'to',
	'free gift': 'gift',
	'free reign': 'free rein',
	'future plans': 'plans',
	'has the ability to': 'can',
	'have the ability to': 'can',
	'hone in on': 'home in on',
	'in close proximity to': 'near',
	'in excess of': 'more than',
	'in light of': 'given',
	'in order to': 'to',
	'in relation to': 'about',
	'in spite of the fact that': 'although',
	'in the absence of': 'without',
	'in the event that': 'if',
	'in the majority of cases': 'usually',
	'in the near future': 'soon',
	'intensive purposes': 'intents and purposes',
	'irregardless': 'regardless',
	'irregardless of': 'regardless of',
	'is able to': 'can',
	'jive with': 'jibe with',
	'join together': 'join',
	'make a decision': 'decide',
	'merge together': 'merge',
	'might of': 'might have',
	'more unique': 'unique',
	'most unique': 'unique',
	'must of': 'must have',
	'new innovation': 'innovation',
	'nip it in the butt': 'nip it in the bud',
	'on a daily basis': 'daily',
	'on a regular basis': 'regularly',
	'on account of': 'because of',
	'on tenderhooks': 'on tenterhooks',
	'one in the same': 'one and the same',
	'owing to the fact that': 'because',
	'pass mustard': 'pass muster',
	'past experience': 'experience',
	'peaked my interest': 'piqued my interest',
	'plan ahead': 'plan',
	'prior to': 'before',
	'reason why': 'why',
	'refer back': 'refer',
	'repeat again': 'repeat',
	'return back': 'return',
	'revert back': 'revert',
	'same identical': 'identical',
	'self-depreciating': 'self-deprecating',
	'share together': 'share',
	'should of': 'should have',
	'slight of hand': 'sleight of hand',
	'statue of limitations': 'statute of limitations',
	'still remains': 'remains',
	'subsequent to': 'after',
	'summarize briefly': 'summarize',
	'supposably': 'supposedly',
	'take into consideration': 'consider',
	'take it for granite': 'take it for granted',
	'tow the line': 'toe the line',
	'true fact': 'fact',
	'unexpected emergency': 'emergency',
	'usual custom': 'custom',
	'utilize': 'use',
	'utilized': 'used',
	'utilizes': 'uses',
	'utilizing': 'using',
	'very unique': 'unique',
	'wet your appetite': 'whet your appetite',
	'with regard to': 'about',
	'with respect to': 'about',
	'would of': 'would have',
}

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
/** Mentions, channel links and custom emoji must survive untouched. */
const MENTION_PATTERN = /<(?:@[!&]?|#|a?:[A-Za-z0-9_]+:)\d+>/g
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
	collect(MENTION_PATTERN, 'url')

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
	const combined = extra && Object.keys(extra).length ? { ...SPELLING_MAP, ...extra } : SPELLING_MAP
	return replaceWords(text, combined, 'misspellings', record)
}

/** 6. Standalone `i`, and the pronoun inside `i'm` / `i've` / `i'll` / `i'd`. */
function ruleStandaloneI(text: string, record: Recorder): string {
	// Contractions first, so `im` becomes `I'm` in one step rather than `I'm` -> `I'm`.
	let out = text.replace(/\b(im|ive)\b/gi, match => {
		const fixed = match.toLowerCase() === 'im' ? "I'm" : "I've"
		if (fixed !== match) record({ rule: 'standalone-i', from: match, to: fixed })
		return fixed
	})

	out = out.replace(/\bi([’'])(m|ve|ll|d)\b/gi, (match, apostrophe: string, tail: string) => {
		const fixed = `I${apostrophe}${tail.toLowerCase()}`
		if (fixed !== match) record({ rule: 'standalone-i', from: match, to: fixed })
		return fixed
	})

	// `i.e.` and friends are not the pronoun.
	return out.replace(/\bi\b(?![’'.]|[a-z])/g, match => {
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
/** 7. Wordy phrases and misheard idioms. */
function rulePhrases(text: string, record: Recorder): string {
	let out = text
	for (const wrong of Object.keys(PHRASES)) {
		const right = PHRASES[wrong]
		if (!right) continue
		const pattern = new RegExp(`\\b${escapeRegExp(wrong).replace(/\\ /g, '\\s+')}\\b`, 'gi')
		out = out.replace(pattern, match => {
			const cased = matchCase(match, right)
			if (cased === match) return match
			record({ rule: 'phrases', from: match, to: cased })
			return cased
		})
	}
	return out
}

/**
 * 8. Grammar agreement.
 *
 * Deliberately narrow: only patterns that are wrong in every register, so a correct
 * sentence can never be rewritten.
 */
const AGREEMENT_PATTERNS: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
	{
		pattern: /\b(he|she|it)\s+(don['’]?t)\b/gi,
		replace: (match, pronoun: string) =>
			`${pronoun} ${pronoun[0] === pronoun[0].toUpperCase() ? "doesn't" : "doesn't"}`,
	},
	{
		pattern: /\b(they|we|you)\s+was\b/gi,
		replace: (match, pronoun: string) =>
			`${pronoun} ${pronoun[0] === pronoun[0].toUpperCase() ? 'Were' : 'were'}`,
	},
	{
		pattern: /\b(he|she|it)\s+have\b/gi,
		replace: (match, pronoun: string) =>
			`${pronoun} ${pronoun[0] === pronoun[0].toUpperCase() ? 'Has' : 'has'}`,
	},
	{
		pattern: /\b(don['’]?t|doesn['’]?t)\s+has\b/gi,
		replace: (match, verb: string) => `${verb} have`,
	},
	{
		pattern: /\b(have|has|had)\s+went\b/gi,
		replace: (match, verb: string) => `${verb} gone`,
	},
	{
		pattern: /\bthere\s+(is|was)\s+(many|several|few|two|three|four|five)\b/gi,
		replace: (match, verb: string, count: string) =>
			`there ${verb.toLowerCase() === 'was' ? 'were' : 'are'} ${count}`,
	},
]

function ruleAgreement(text: string, record: Recorder): string {
	let out = text
	for (const { pattern, replace } of AGREEMENT_PATTERNS) {
		out = out.replace(pattern, (match, ...groups: string[]) => {
			const replacement = replace(match, ...groups)
			if (replacement !== match) record({ rule: 'agreement', from: match, to: replacement })
			return replacement
		})
	}
	return out
}

/** Words that start with a vowel letter but a consonant sound, and vice versa. */
const CONSONANT_SOUND = /^(?:uni|use|usa|usu|uti|ure|uro|ubiq|eu|ewe|one|once|ouija)/i
const VOWEL_SOUND = /^(?:hour|honest|honor|honour|heir|herb)/i

function startsWithVowelSound(word: string): boolean {
	if (VOWEL_SOUND.test(word)) return true
	if (CONSONANT_SOUND.test(word)) return false
	return /^[aeiou]/i.test(word)
}

/**
 * 9. `a` / `an`.
 *
 * Only lowercase single words are considered, so acronyms (“a MRI”), proper nouns and
 * numbers are left alone.
 */
function ruleArticles(text: string, record: Recorder): string {
	return text.replace(/\b(a|an)(\s+)([a-z][a-z'-]*)\b/g, (match, article: string, space: string, word: string) => {
		const wantsAn = startsWithVowelSound(word)
		const hasAn = article === 'an'

		if (wantsAn === hasAn) return match
		if (!wantsAn && /^(?:one|once|eu|uni)/i.test(word) && !CONSONANT_SOUND.test(word)) return match

		const fixed = wantsAn ? 'an' : 'a'
		record({ rule: 'articles', from: match, to: `${fixed}${space}${word}` })
		return `${fixed}${space}${word}`
	})
}

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
	if (!skip.has('phrases')) out = rulePhrases(out, record)
	if (!skip.has('agreement')) out = ruleAgreement(out, record)
	if (!skip.has('articles')) out = ruleArticles(out, record)
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
