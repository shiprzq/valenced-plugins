/**
 * Redpen corrector tests.
 *
 * Run with:  npm test
 * (equivalent to: node --experimental-strip-types --test plugins/redpen/js/corrector.test.ts)
 *
 * Node >= 22.6 is required for native TypeScript execution. On older Node, transpile first:
 *   npx tsc plugins/redpen/js/corrector.ts plugins/redpen/js/corrector.test.ts \
 *     --outDir /tmp/redpen-test --target es2022 --module es2022 --skipLibCheck
 *   node --test /tmp/redpen-test/corrector.test.js
 */

/// <reference types="node" />

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CORRECTOR_VERSION, RULE_LABELS, correct, correctText } from './corrector.ts'

const fix = (input: string) => correctText(input)
const rules = (input: string) => correct(input).changes.map(change => change.rule)

describe('metadata', () => {
	it('exposes a version string', () => {
		assert.match(CORRECTOR_VERSION, /^\d+\.\d+\.\d+$/)
	})
})

describe('rule 1: whitespace', () => {
	it('collapses runs of spaces', () => {
		assert.equal(fix('hello     world'), 'Hello world.')
	})

	it('strips trailing spaces per line and leading spaces', () => {
		assert.equal(fix('   first line   \nsecond line   '), 'First line\nSecond line.')
	})

	it('collapses 3+ newlines to 2', () => {
		assert.equal(fix('first\n\n\n\nsecond'), 'First\n\nSecond.')
	})
})

describe('rule 2: spacing around punctuation', () => {
	it('removes space before punctuation', () => {
		assert.equal(fix('well , yes'), 'Well, yes.')
	})

	it('adds one space after commas, semicolons and colons', () => {
		assert.equal(fix('apples,pears'), 'Apples, pears.')
		assert.equal(fix('note:this'), 'Note: this.')
	})

	it('adds one space after sentence punctuation followed by a letter', () => {
		assert.equal(fix('stop.Go'), 'Stop. Go.')
	})

	it('leaves thousands separators and times alone', () => {
		assert.equal(fix('we met at 10:30 with 1,000 people'), 'We met at 10:30 with 1,000 people.')
	})

	it('does not split filenames or domains at the dot', () => {
		assert.equal(fix('discord.js and node.js are fine'), 'Discord.js and node.js are fine.')
		assert.equal(fix('open example.com in the browser'), 'Open example.com in the browser.')
	})

	it('does not break e.g. or i.e.', () => {
		assert.equal(fix('fruit, e.g. apples'), 'Fruit, e.g. apples.')
		assert.equal(fix('i.e. the same thing'), 'I.e. the same thing.')
	})
})

describe('rule 3: ellipsis and dashes', () => {
	it('converts three dots to an ellipsis', () => {
		assert.equal(fix('wait...'), 'Wait…')
	})

	it('converts spaced double hyphens to an em dash', () => {
		assert.equal(fix('one thing -- another'), 'One thing — another.')
	})

	it('converts tight double hyphens between words', () => {
		assert.equal(fix('a well--known fact'), 'A well—known fact.')
	})
})

describe('rule 4: contractions', () => {
	it('restores missing apostrophes', () => {
		assert.equal(fix('i dont know'), "I don't know.")
		assert.equal(fix('theyre not here'), "They're not here.")
		assert.equal(fix('weve seen it'), "We've seen it.")
	})

	it('capitalizes i-contractions', () => {
		assert.equal(fix('im ready'), "I'm ready.")
		assert.equal(fix('ive finished'), "I've finished.")
	})

	it('leaves possessive its alone', () => {
		assert.equal(fix('the cat licked its paw'), 'The cat licked its paw.')
	})
})

describe('rule 5: misspellings', () => {
	it('fixes common misspellings', () => {
		assert.equal(fix('teh recieve seperate definately occured'), 'The receive separate definitely occurred.')
	})

	it('fixes multi-word replacements', () => {
		assert.equal(fix('i have alot to say'), 'I have a lot to say.')
	})

	it('preserves casing patterns', () => {
		assert.equal(fix('TEH thing'), 'THE thing.')
		assert.equal(fix('Teh thing'), 'The thing.')
		assert.equal(fix('teh thing'), 'The thing.')
	})

	it('does not touch correctly spelled words inside other words', () => {
		assert.equal(fix('the theatre theory'), 'The theatre theory.')
	})
})

describe('rule 6: standalone i', () => {
	it('capitalizes standalone i', () => {
		assert.equal(fix('i think so'), 'I think so.')
	})

	it('does not capitalize i.e.', () => {
		assert.equal(fix('the best one, i.e. this'), 'The best one, i.e. this.')
	})
})

describe('rule 7: repeated words', () => {
	it('drops immediate repeats', () => {
		assert.equal(fix('the the cat sat'), 'The cat sat.')
		assert.equal(fix('That that was was odd'), 'That was odd.')
	})
})

describe('rule 8: sentence capitalization', () => {
	it('capitalizes after terminal punctuation', () => {
		assert.equal(fix('ready? yes! good. fine'), 'Ready? Yes! Good. Fine.')
	})

	it('capitalizes after a newline', () => {
		assert.equal(fix('first line\nsecond line'), 'First line\nSecond line.')
	})

	it('does not capitalize after an abbreviation', () => {
		assert.equal(fix('ask mr. smith about it'), 'Ask mr. smith about it.')
	})

	it('does not capitalize after a number and a period', () => {
		assert.equal(fix('version 2. next build'), 'Version 2. next build.')
	})
})

describe('rule 9: terminal punctuation', () => {
	it('appends a period to a multi-word message', () => {
		assert.equal(fix('this needs a period'), 'This needs a period.')
	})

	it('does not append to a single word', () => {
		assert.equal(fix('hello'), 'Hello')
	})

	it('does not append after an emoji', () => {
		assert.equal(fix('nice work 😀'), 'Nice work 😀')
	})

	it('does not append after a URL', () => {
		assert.equal(fix('look at https://example.com/page'), 'Look at https://example.com/page')
	})

	it('does not append after a code fence', () => {
		assert.equal(fix('run this\n```\nnpm i\n```'), 'Run this\n```\nnpm i\n```')
	})

	it('does not append when terminal punctuation exists', () => {
		assert.equal(fix('already done!'), 'Already done!')
	})
})

describe('rule 10: double punctuation', () => {
	it('collapses repeated exclamation and question marks', () => {
		assert.equal(fix('wow!!!'), 'Wow!')
		assert.equal(fix('really????'), 'Really?')
	})

	it('collapses exactly two dots into an ellipsis', () => {
		assert.equal(fix('wait..'), 'Wait…')
	})

	it('does not collapse dots inside a URL', () => {
		assert.equal(fix('see http://example.com/..'), 'See http://example.com/..')
	})
})

describe('protected regions', () => {
	it('leaves fenced code untouched', () => {
		const input = 'check this\n```\nteh  code ,  dont\n```'
		assert.equal(fix(input), 'Check this\n```\nteh  code ,  dont\n```')
	})

	it('leaves inline code untouched', () => {
		assert.equal(fix('run `teh  thing` now'), 'Run `teh  thing` now.')
	})

	it('leaves URLs untouched', () => {
		assert.equal(fix('go to https://example.com/a..b?x=1 now'), 'Go to https://example.com/a..b?x=1 now.')
	})

	it('corrects prose around masked regions', () => {
		assert.equal(
			fix('i recieve mail at https://example.com ok'),
			'I receive mail at https://example.com ok.',
		)
	})
})

describe('change reporting', () => {
	it('records one change per applied rule', () => {
		const changes = rules('teh the the end')
		assert.ok(changes.includes('misspellings'))
		assert.ok(changes.includes('repeated-words'))
	})

	it('reports no changes for already-clean input', () => {
		const result = correct('The cat sat.')
		assert.deepEqual(result.changes, [])
		assert.equal(result.corrected, result.original)
	})

	it('reports no changes for empty input', () => {
		const result = correct('   ')
		assert.deepEqual(result.changes, [])
		assert.equal(result.corrected, '   ')
	})

	it('unmasks values inside change records', () => {
		const result = correct('go to https://example.com now and enjoy')
		for (const change of result.changes) {
			assert.ok(!change.from.includes('\u0001'))
			assert.ok(!change.to.includes('\u0001'))
		}
	})
})

describe('options', () => {
	it('skips disabled rule groups', () => {
		assert.equal(correctText('teh end', { skip: ['misspellings'] }), 'Teh end.')
		assert.equal(correctText('teh end', { skip: ['terminal-punctuation'] }), 'The end')
	})

	it('applies a user dictionary', () => {
		assert.equal(correctText('i use discord.js daily', { dictionary: { discord: 'Discord' } }), 'I use Discord.js daily.')
	})
})

describe('idempotence', () => {
	const corpus = [
		'teh the the end',
		'i recieve alot of mail . . .',
		'wait... what?? really!!!!',
		'check `teh  code` and https://example.com/a..b then go',
		'```\nteh  code\n```',
		'   spaced   out   text   ',
		'first\n\n\n\nsecond\nthird',
		'dont  say  teh  same  thing  twice twice',
		'a well--known fact -- for sure',
		'i think mr. smith knows better, i.e. he does',
		'nothing to fix here.',
		'🙂🙂 hello',
		'',
		'   ',
	]

	for (const input of corpus) {
		it(`is stable for ${JSON.stringify(input)}`, () => {
			const once = correct(input)
			const twice = correct(once.corrected)
			assert.equal(twice.corrected, once.corrected)
			assert.deepEqual(twice.changes, [])
		})
	}

	it('never returns changes when nothing changed', () => {
		for (const input of corpus) {
			const result = correct(input)
			if (result.corrected === result.original) assert.deepEqual(result.changes, [])
			else assert.ok(result.changes.length > 0)
		}
	})
})

describe('expanded rule set', () => {
	it('fixes wordy phrases', () => {
		assert.equal(fix('in order to win'), 'To win.')
		assert.equal(fix('due to the fact that it rained'), 'Because it rained.')
		assert.equal(fix('we should of known'), 'We should have known.')
		assert.equal(fix('prior to the meeting'), 'Before the meeting.')
	})

	it('fixes misheard idioms', () => {
		assert.equal(
			fix('for all intensive purposes it is done'),
			'For all intents and purposes it is done.',
		)
		assert.equal(fix('i could care less'), "I couldn't care less.")
		assert.equal(fix('it peaked my interest'), 'It piqued my interest.')
	})

	it('fixes grammar agreement', () => {
		assert.equal(fix('he don\'t care'), 'He doesn\'t care.')
		assert.equal(fix('they was late'), 'They were late.')
		assert.equal(fix('she have a plan'), 'She has a plan.')
		assert.equal(fix('they have went home'), 'They have gone home.')
	})

	it('picks a or an by sound', () => {
		assert.equal(fix('a apple'), 'An apple.')
		assert.equal(fix('an user'), 'A user.')
		assert.equal(fix('a hour'), 'An hour.')
		assert.equal(fix('an honest mistake'), 'An honest mistake.')
	})

	it('capitalises the pronoun inside contractions', () => {
		assert.equal(fix('im ready and ive checked'), "I'm ready and I've checked.")
		assert.equal(fix("i'll do it"), "I'll do it.")
	})

	it('catches plurals of known misspellings', () => {
		assert.equal(fix('my freinds'), 'My friends.')
		assert.equal(fix('thier opinions'), 'Their opinions.')
	})

	it('never rewrites mentions, channel links or custom emoji', () => {
		assert.equal(fix('<@123> dont worry'), "<@123> don't worry.")
		assert.equal(fix('<#456> is quiet'), '<#456> is quiet.')
		assert.equal(fix('<:redpen:789> alot'), '<:redpen:789> a lot.')
		assert.equal(fix('https://example.com/a..b is fine'), 'https://example.com/a..b is fine.')
	})

	it('skips a whole rule family on request', () => {
		const input = 'definately a apple'
		assert.equal(correct(input, { skip: ['misspellings'] }).corrected, 'Definately an apple.')
		assert.equal(correct(input, { skip: ['articles'] }).corrected, 'Definitely a apple.')
		assert.equal(correct(input).corrected, 'Definitely an apple.')
	})

	it('exposes the version and rule labels', () => {
		assert.equal(CORRECTOR_VERSION, '2.0.0')
		assert.ok(RULE_LABELS.length >= 10)
		assert.ok(RULE_LABELS.every(rule => rule.id && rule.label && rule.description))
	})

	it('keeps ordinary prose untouched', () => {
		const prose = [
			'The quick brown fox jumps over the lazy dog.',
			'I will send the report tomorrow morning.',
			'She said "hello" and left.',
			'We met at 5 pm on Tuesday.',
			'Use the API to fetch 3 items.',
			'Is this correct?',
		]
		for (const input of prose) assert.equal(fix(input), input)
	})
})
